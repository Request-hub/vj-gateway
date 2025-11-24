cat > server.js <<'EOF'
/* server.js - VJ Gateway MVP backend */
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./db.sqlite');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

const db = new Database('db.sqlite');
db.prepare(`CREATE TABLE IF NOT EXISTS requests (
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
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  action TEXT,
  max_uses INTEGER DEFAULT 0,
  uses INTEGER DEFAULT 0,
  owner_id TEXT,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

if (!process.env.GITHUB_TOKEN) {
  console.warn('WARNING: GITHUB_TOKEN not set in environment. Create one and set it for production.');
}

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const transporter = nodemailer.createTransport({
  service: process.env.SMTP_SERVICE || 'gmail',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

function genToken() {
  return 'VJ-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

/* Create request */
app.post('/api/request', async (req, res) => {
  try {
    const { name, email, purpose, message, referral } = req.body;
    if (!name || !email || !purpose || !message) {
      return res.status(400).json({ error: 'missing fields' });
    }

    // check referral validity (optional)
    let refRow = null;
    if (referral) {
      refRow = db.prepare('SELECT * FROM referrals WHERE code = ?').get(referral);
      if (!refRow) {
        refRow = null;
      } else {
        if (refRow.expires_at && new Date(refRow.expires_at) < new Date()) {
          refRow = null;
        } else if (refRow.max_uses && refRow.uses >= refRow.max_uses) {
          refRow = null;
        }
      }
    }

    const token = genToken();

    const body = `Token: ${token}\nName: ${name}\nEmail: ${email}\nPurpose: ${purpose}\nReferral: ${referral || 'none'}\n\nMessage:\n${message}`;

    const labels = ['status:received'];
    if (refRow) {
      if (refRow.action === 'fast-track') labels.push('priority:fast-track');
      else if (refRow.action === 'team-verification') labels.push('status:team-verification');
      else if (refRow.action === 'office-verification') labels.push('status:office-verification');
      labels.push(`referral:${refRow.code}`);
    }

    const issue = await octokit.issues.create({
      owner: process.env.REPO_OWNER,
      repo: process.env.REPO_NAME,
      title: `Request: ${name} — ${purpose}`,
      body,
      labels
    });

    const insert = db.prepare(`INSERT INTO requests (token,name,email,purpose,message,referral,issue_number,status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(token, name, email, purpose, message, referral || null, issue.data.number, 'received');

    if (refRow) {
      db.prepare('UPDATE referrals SET uses = uses + 1 WHERE id = ?').run(refRow.id);
    }

    const statusUrl = `${process.env.SITE_URL}/status.html?token=${token}`;
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      await transporter.sendMail({
        from: process.env.EMAIL_SENDER || process.env.SMTP_USER,
        to: email,
        subject: `Request received — ${token}`,
        text: `Thanks. Track your request: ${statusUrl}\nToken: ${token}`
      }).catch(err => {
        console.log('Email send failed (continue):', err.message);
      });
    } else {
      console.log(`No SMTP configured. Would send email to ${email} with status URL: ${statusUrl}`);
    }

    res.json({ ok: true, token, statusUrl });
  } catch (err) {
    console
