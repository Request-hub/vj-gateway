// server.js - Full working VJ Gateway backend (sqlite3 version)
// Paste this whole file into your repo (replace old server.js).
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// ---------- ENV CHECK ----------
const {
  GITHUB_TOKEN,
  REPO_OWNER,
  REPO_NAME,
  SITE_URL,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SERVICE,
  EMAIL_SENDER,
  WEBHOOK_SECRET,
  ADMIN_SECRET,
  PORT
} = process.env;

if (!REPO_OWNER || !REPO_NAME) {
  console.warn('Warning: REPO_OWNER or REPO_NAME not set in env.');
}

// ---------- Octokit ----------
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ---------- Mailer ----------
const transporter = nodemailer.createTransport({
  service: SMTP_SERVICE || 'gmail',
  auth: {
    user: SMTP_USER || '',
    pass: SMTP_PASS || ''
  }
});

// ---------- SQLite DB (promisified helpers) ----------
const dbFile = path.join(__dirname, 'db.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) console.error('Failed to open sqlite db:', err.message);
  else console.log('Connected to sqlite db:', dbFile);
});

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Create tables safely
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE,
    name TEXT,
    email TEXT,
    purpose TEXT,
    message TEXT,
    referral TEXT,
    issue_number INTEGER,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`, (err) => { if (err) console.error('create requests table error:', err.message); });

  db.run(`CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    action TEXT,
    max_uses INTEGER DEFAULT 0,
    uses INTEGER DEFAULT 0,
    owner_id TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`, (err) => { if (err) console.error('create referrals table error:', err.message); });

  db.run(`CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER,
    type TEXT,
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`, (err) => { if (err) console.error('create audit table error:', err.message); });
});

// ---------- Utilities ----------
function genToken() {
  return 'VJ-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function safeSendMail(mailOptions) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.log('SMTP not configured; would send:', mailOptions);
    return Promise.resolve();
  }
  return transporter.sendMail(mailOptions).catch(err => {
    console.error('Email send failed:', err && err.message);
  });
}

// ---------- SSE clients ----------
let sseClients = [];
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  const id = Date.now();
  sseClients.push({ id, res });
  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== id);
  });
});
function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => {
    try { c.res.write(payload); } catch (e) { /* ignore */ }
  });
}

// ---------- API: Create Request ----------
app.post('/api/request', async (req, res) => {
  try {
    const { name, email, purpose, message, referral } = req.body || {};
    if (!name || !email || !purpose || !message) {
      return res.status(400).json({ error: 'missing fields (name, email, purpose, message required)' });
    }

    // Validate referral (optional)
    let refRow = null;
    if (referral) {
      refRow = await getAsync('SELECT * FROM referrals WHERE code = ?', [referral]).catch(() => null);
      if (refRow) {
        if (refRow.expires_at && new Date(refRow.expires_at) < new Date()) refRow = null;
        if (refRow.max_uses && refRow.uses >= refRow.max_uses) refRow = null;
      }
    }

    const token = genToken();
    const issueBody = `Token: ${token}\nName: ${name}\nEmail: ${email}\nPurpose: ${purpose}\nReferral: ${referral || 'none'}\n\nMessage:\n${message}`;

    // Build labels array
    const labels = ['status:received'];
    if (refRow) {
      if (refRow.action === 'fast-track') labels.push('priority:fast-track');
      else if (refRow.action === 'team-verification') labels.push('status:team-verification');
      else if (refRow.action === 'office-verification') labels.push('status:office-verification');
      labels.push(`referral:${refRow.code}`);
    }

    // Create GitHub issue
    const issue = await octokit.issues.create({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      title: `Request: ${name} — ${purpose}`,
      body: issueBody,
      labels
    });

    // Persist request
    await runAsync(`INSERT INTO requests (token,name,email,purpose,message,referral,issue_number,status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [token, name, email, purpose, message, referral || null, issue.data.number, 'received']);

    // increment referral use if applicable
    if (refRow) {
      await runAsync('UPDATE referrals SET uses = uses + 1 WHERE id = ?', [refRow.id]);
    }

    const statusUrl = `${SITE_URL?.replace(/\/$/,'') || ''}/status.html?token=${token}`;

    // send confirmation email
    await safeSendMail({
      from: EMAIL_SENDER || SMTP_USER,
      to: email,
      subject: `Request received — ${token}`,
      text: `Thanks. Track your request: ${statusUrl}\nToken: ${token}`
    });

    // audit
    const inserted = await getAsync('SELECT * FROM requests WHERE token = ?', [token]);
    await runAsync('INSERT INTO audit_events (request_id, type, payload) VALUES (?, ?, ?)',
      [inserted.id, 'created', JSON.stringify({ issue_number: issue.data.number })]);

    res.json({ ok: true, token, statusUrl });
  } catch (err) {
    console.error('POST /api/request error:', err && err.message);
    res.status(500).json({ error: 'server error: ' + (err && err.message) });
  }
});

// ---------- API: Status lookup ----------
app.get('/api/status', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'token required' });
    const row = await getAsync('SELECT * FROM requests WHERE token = ?', [token]);
    if (!row) return res.status(404).json({ error: 'invalid token' });

    const issue = await octokit.issues.get({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      issue_number: row.issue_number
    });

    // fetch latest comments (optional)
    const comments = (await allAsync('SELECT * FROM audit_events WHERE request_id = ? ORDER BY created_at DESC LIMIT 10', [row.id]).catch(()=>[])) || [];

    res.json({
      token: row.token,
      name: row.name,
      email: row.email,
      purpose: row.purpose,
      status: issue.data.state,
      labels: issue.data.labels.map(l => (typeof l === 'string' ? l : l.name)),
      body: issue.data.body,
      comments // local audit_comments if any
    });
  } catch (err) {
    console.error('GET /api/status error:', err && err.message);
    res.status(500).json({ error: err && err.message });
  }
});

// ---------- ADMIN: Update status (protected) ----------
const VALID_STATUS_LABELS = [
  'status:received','status:under-review','status:team-verification',
  'status:office-verification','status:approved','status:chat-unlocked',
  'status:appointment','status:closed'
];

async function setIssueLabels(issue_number, newStatusLabel, extraLabels = []) {
  // get existing labels
  const issue = await octokit.issues.get({ owner: REPO_OWNER, repo: REPO_NAME, issue_number });
  const existing = issue.data.labels.map(l => (typeof l === 'string' ? l : l.name));
  // remove old status:* labels
  const other = existing.filter(l => !l.startsWith('status:'));
  // combine
  const labelsToSet = Array.from(new Set([...other, newStatusLabel, ...extraLabels]));
  await octokit.issues.setLabels({ owner: REPO_OWNER, repo: REPO_NAME, issue_number, labels: labelsToSet });
  return labelsToSet;
}

app.post('/api/admin/update-status', async (req, res) => {
  try {
    const secret = req.headers['x-admin-secret'] || req.query.admin_secret;
    if (!ADMIN_SECRET || !secret || secret !== ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
    const { token, issue_number, new_status, comment } = req.body || {};
    if (!new_status) return res.status(400).json({ error: 'new_status required' });
    if (!VALID_STATUS_LABELS.includes(new_status) && !new_status.startsWith('referral:') && new_status !== 'priority:fast-track') {
      return res.status(400).json({ error: 'invalid new_status label' });
    }

    let issueNum = issue_number;
    if (!issueNum && token) {
      const row = await getAsync('SELECT * FROM requests WHERE token = ?', [token]);
      if (!row) return res.status(404).json({ error: 'token not found' });
      issueNum = row.issue_number;
    }
    if (!issueNum) return res.status(400).json({ error: 'issue_number or token required' });

    const labels = await setIssueLabels(issueNum, new_status);
    if (new_status === 'status:closed') {
      await octokit.issues.update({ owner: REPO_OWNER, repo: REPO_NAME, issue_number: issueNum, state: 'closed' });
    }
    // update local DB status (store the label string)
    await runAsync('UPDATE requests SET status = ? WHERE issue_number = ?', [new_status, issueNum]);

    // optionally add comment
    if (comment) {
      await octokit.issues.createComment({ owner: REPO_OWNER, repo: REPO_NAME, issue_number: issueNum, body: comment });
      // save audit
      const rowNow = await getAsync('SELECT * FROM requests WHERE issue_number = ?', [issueNum]);
      if (rowNow) await runAsync('INSERT INTO audit_events (request_id, type, payload) VALUES (?, ?, ?)', [rowNow.id, 'admin_comment', JSON.stringify({ comment })]);
    }

    // notify clients
    const rowNow = await getAsync('SELECT * FROM requests WHERE issue_number = ?', [issueNum]);
    if (rowNow) broadcastSSE({ type: 'status_update', token: rowNow.token, new_status, issue_number: issueNum });

    res.json({ ok: true, labels });
  } catch (err) {
    console.error('POST /api/admin/update-status error:', err && err.message);
    res.status(500).json({ error: err && err.message });
  }
});

// ---------- GitHub Webhook endpoint ----------
app.post('/webhook', bodyParser.json({ type: '*/*' }), async (req, res) => {
  try {
    const sig = req.headers['x-hub-signature-256'];
    const secret = WEBHOOK_SECRET;
    if (!sig || !secret) return res.status(400).send('no signature configured');

    const hmac = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
    const expected = 'sha256=' + hmac;
    try {
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        return res.status(401).send('invalid signature');
      }
    } catch (e) {
      return res.status(401).send('signature compare failed');
    }

    const event = req.headers['x-github-event'];
    const payload = req.body;

    if (event === 'issues') {
      const issue = payload.issue;
      const issueNum = issue.number;
      // find local request
      const row = await getAsync('SELECT * FROM requests WHERE issue_number = ?', [issueNum]);
      if (row) {
        // choose first status:* label present or closed state
        const statusLabel = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name))
          .find(l => l && l.startsWith('status:')) || (issue.state === 'closed' ? 'status:closed' : 'status:received');
        await runAsync('UPDATE requests SET status = ? WHERE id = ?', [statusLabel, row.id]);
        await runAsync('INSERT INTO audit_events (request_id, type, payload) VALUES (?, ?, ?)', [row.id, 'webhook_issues', JSON.stringify({ action: payload.action })]);
        broadcastSSE({ type: 'status_update', token: row.token, new_status: statusLabel, issue_number: issueNum });
      }
    } else if (event === 'issue_comment') {
      const issueNum = payload.issue.number;
      const row = await getAsync('SELECT * FROM requests WHERE issue_number = ?', [issueNum]);
      if (row) {
        // log comment, notify
        await runAsync('INSERT INTO audit_events (request_id, type, payload) VALUES (?, ?, ?)', [row.id, 'issue_comment', JSON.stringify(payload.comment)]);
        broadcastSSE({ type: 'comment', token: row.token, comment: { body: payload.comment.body, user: payload.comment.user.login } });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('/webhook error:', err && err.message);
    res.status(500).json({ error: err && err.message });
  }
});

// ---------- Fallback root ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Start server ----------
const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
