// server.js - Full VJ Gateway (copy/paste ready for Hotmail SMTP)
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

// env
const {
  GITHUB_TOKEN,
  REPO_OWNER,
  REPO_NAME,
  SITE_URL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_SENDER,
  WEBHOOK_SECRET,
  ADMIN_SECRET,
  PORT
} = process.env;

// Octokit
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Nodemailer transporter (explicit host/port for Hotmail/Outlook)
const transporter = nodemailer.createTransport({
  host: SMTP_HOST || 'smtp.office365.com',
  port: SMTP_PORT ? Number(SMTP_PORT) : 587,
  secure: (SMTP_SECURE === 'true'), // false for STARTTLS
  auth: {
    user: SMTP_USER || '',
    pass: SMTP_PASS || ''
  },
  tls: {
    ciphers: 'TLSv1.2',
    rejectUnauthorized: false
  },
  connectionTimeout: 30 * 1000
});

// Database (sqlite3)
const dbFile = path.join(__dirname, 'db.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) console.error('Failed to open sqlite db:', err.message);
  else console.log('Connected to sqlite db:', dbFile);
});

// Promisified helpers
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

// Create tables
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
  );`, (err) => { if (err) console.error('create requests error:', err && err.message); });

  db.run(`CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    action TEXT,
    max_uses INTEGER DEFAULT 0,
    uses INTEGER DEFAULT 0,
    owner_id TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`, (err) => { if (err) console.error('create referrals error:', err && err.message); });

  db.run(`CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER,
    type TEXT,
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`, (err) => { if (err) console.error('create audit_events error:', err && err.message); });
});

// Utilities
function genToken() {
  return 'VJ-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

async function safeSendMail(mailOptions) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.log('SMTP not configured; would send:', mailOptions);
    return;
  }
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info && (info.messageId || info.response));
  } catch (err) {
    console.error('Email send failed:', err && err.message);
    throw err;
  }
}

// SSE clients
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
    try { c.res.write(payload); } catch (e) {}
  });
}

// API: create request
app.post('/api/request', async (req, res) => {
  try {
    const { name, email, purpose, message, referral } = req.body || {};
    if (!name || !email || !purpose || !message) {
      return res.status(400).json({ error: 'missing fields: name, email, purpose, message required' });
    }

    // check referral
    let refRow = null;
    if (referral) {
      try { refRow = await getAsync('SELECT * FROM referrals WHERE code = ?', [referral]); } catch(e){ refRow = null; }
      if (refRow) {
        if (refRow.expires_at && new Date(refRow.expires_at) < new Date()) refRow = null;
        if (refRow.max_uses && refRow.uses >= refRow.max_uses) refRow = null;
      }
    }

    const token = genToken();
    const issueBody = `Token: ${token}\nName: ${name}\nEmail: ${email}\nPurpose: ${purpose}\nReferral: ${referral || 'none'}\n\nMessage:\n${message}`;
    const labels = ['status:received'];
    if (refRow) {
      if (refRow.action === 'fast-track') labels.push('priority:fast-track');
      else if (refRow.action === 'team-verification') labels.push('status:team-verification');
      else if (refRow.action === 'office-verification') labels.push('status:office-verification');
      labels.push(`referral:${refRow.code}`);
    }

    // create GitHub issue
    const issue = await octokit.issues.create({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      title: `Request: ${name} — ${purpose}`,
      body: issueBody,
      labels
    });

    // persist
    await runAsync(`INSERT INTO requests (token,name,email,purpose,message,referral,issue_number,status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [token, name, email, purpose, message, referral || null, issue.data.number, 'received']);

    if (refRow) await runAsync('UPDATE referrals SET uses = uses + 1 WHERE id = ?', [refRow.id]);

    const statusUrl = `${(SITE_URL || '').replace(/\/$/,'')}/status.html?token=${token}`;

    // send email
    try {
      await safeSendMail({
        from: EMAIL_SENDER || SMTP_USER,
        to: email,
        subject: `Request received — ${token}`,
        text: `Thanks. Track your request: ${statusUrl}\nToken: ${token}`
      });
    } catch (err) {
      // still return success so request exists on GitHub; log error
      console.error('Warning: email failed to send for token', token);
    }

    // audit
    const inserted = await getAsync('SELECT * FROM requests WHERE token = ?', [token]);
    if (inserted) await runAsync('INSERT INTO audit_events (request_id, type, payload) VALUES (?, ?, ?)', [inserted.id, 'created', JSON.stringify({ issue: issue.data.number })]);

    res.json({ ok: true, token, statusUrl });
  } catch (err) {
    console.error('POST /api/request error:', err && err.message);
    res.status(500).json({ error: 'server error' });
  }
});

// API: status lookup
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

    res.json({
      token: row.token,
      name: row.name,
      email: row.email,
      purpose: row.purpose,
      status: issue.data.state,
      labels: issue.data.labels.map(l => (typeof l === 'string' ? l : l.name)),
      body: issue.data.body
    });
  } catch (err) {
    console.error('GET /api/status error:', err && err.message);
    res.status(500).json({ error: 'server error' });
  }
});

// Admin: update status (protected)
const VALID_STATUS_LABELS = [
  'status:received','status:under-review','status:team-verification',
  'status:office-verification','status:approved','status:chat-unlocked',
  'status:appointment','status:closed'
];

async function setIssueLabels(issue_number, newStatusLabel, extraLabels = []) {
  const issue = await octokit.issues.get({ owner: REPO_OWNER, repo: REPO_NAME, issue_number });
  const existing = issue.data.labels.map(l => (typeof l === 'string' ? l : l.name));
  const other = existing.filter(l => !l.startsWith('status:'));
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
    await runAsync('UPDATE requests SET status = ? WHERE issue_number = ?', [new_status, issueNum]);

    if (comment) {
      await octokit.issues.createComment({ owner: REPO_OWNER, repo: REPO_NAME, issue_number: issueNum, body: comment });
      const rowNow = await getAsync('SELECT * FROM requests WHERE issue_number = ?', [issueNum]);
      if (rowNow) await runAsync('INSERT INTO audit_events (request_id, type, payload) VALUES (?, ?, ?)', [rowNow.id, 'admin_comment', JSON.stringify({ comment })]);
    }

    const rowNow = await getAsync('SELECT * FROM requests WHERE issue_number = ?', [issueNum]);
    if (rowNow) broadcastSSE({ type: 'status_update', token: rowNow.token, new_status, issue_number: issueNum });

    res.json({ ok: true, labels });
  } catch (err) {
    console.error('POST /api/admin/update-status error:', err && err.message);
    res.status(500).json({ error: 'server error' });
  }
});

// Webhook endpoint (verify signature)
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
      const statusLabel = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name)).find(l => l.startsWith('status:')) || (issue.state === 'closed' ? 'status:closed' : 'status:received');
      const row = await getAsync('SELECT * FROM requests WHERE issue_number = ?', [issueNum]);
      if (row) {
        await runAsync('UPDATE requests SET status = ? WHERE id = ?', [statusLabel, row.id]);
        await runAsync('INSERT INTO audit_events (request_id, type, payload) VALUES (?, ?, ?)', [row.id, 'webhook_issues', JSON.stringify({ action: payload.action })]);
        broadcastSSE({ type: 'status_update', token: row.token, new_status: statusLabel, issue_number: issueNum });
      }
    } else if (event === 'issue_comment') {
      const issueNum = payload.issue.number;
      const row = await getAsync('SELECT * FROM requests WHERE issue_number = ?', [issueNum]);
      if (row) {
        await runAsync('INSERT INTO audit_events (request_id, type, payload) VALUES (?, ?, ?)', [row.id, 'issue_comment', JSON.stringify(payload.comment)]);
        broadcastSSE({ type: 'comment', token: row.token, comment: { body: payload.comment.body, user: payload.comment.user.login } });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('/webhook error:', err && err.message);
    res.status(500).json({ error: 'server error' });
  }
});

// TEST endpoint to check email sending quickly
app.get('/test-email', async (req, res) => {
  try {
    const to = req.query.to || SMTP_USER;
    const subject = 'VJ-Gateway: Test email';
    const text = `Test email from VJ-Gateway at ${new Date().toISOString()}`;
    await safeSendMail({ from: EMAIL_SENDER || SMTP_USER, to, subject, text });
    res.json({ ok: true, to });
  } catch (err) {
    console.error('test-email error', err && err.message);
    res.status(500).json({ error: err && err.message });
  }
});

// fallback
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// start
const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
