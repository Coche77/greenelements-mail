require('dotenv').config();
const express = require('express');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Configuración IMAP ─────────────────────────────────────────────
function createImap() {
  return new Imap({
    user: process.env.MAIL_USER,
    password: process.env.MAIL_PASS,
    host: process.env.MAIL_HOST,
    port: parseInt(process.env.IMAP_PORT) || 993,
    tls: process.env.IMAP_TLS === 'true',
    tlsOptions: { rejectUnauthorized: false }
  });
}

// ── Configuración SMTP ─────────────────────────────────────────────
function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: parseInt(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS
    },
    tls: { rejectUnauthorized: false }
  });
}

// ── Helper: abrir carpeta IMAP ────────────────────────────────────
function openMailbox(imap, folder) {
  return new Promise((resolve, reject) => {
    imap.openBox(folder, false, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

// ── GET /api/emails — listar correos ─────────────────────────────
app.get('/api/emails', (req, res) => {
  const folder = req.query.folder || 'INBOX';
  const limit = parseInt(req.query.limit) || 20;
  const imap = createImap();
  const emails = [];

  imap.once('ready', async () => {
    try {
      await openMailbox(imap, folder);
      imap.search(['ALL'], (err, uids) => {
        if (err || !uids.length) { imap.end(); return res.json([]); }
        const recent = uids.slice(-limit).reverse();
        const fetch = imap.fetch(recent, {
          bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'],
          struct: true,
          envelope: true
        });
        fetch.on('message', (msg, seqno) => {
          const email = { id: null, seqno };
          msg.on('attributes', attrs => { email.id = attrs.uid; email.flags = attrs.flags; });
          msg.on('body', stream => {
            let buf = '';
            stream.on('data', c => buf += c.toString('utf8'));
            stream.once('end', () => {
              const lines = buf.split('\r\n');
              lines.forEach(l => {
                if (l.startsWith('From:')) email.from = l.replace('From:', '').trim();
                if (l.startsWith('To:')) email.to = l.replace('To:', '').trim();
                if (l.startsWith('Subject:')) email.subject = l.replace('Subject:', '').trim();
                if (l.startsWith('Date:')) email.date = l.replace('Date:', '').trim();
              });
              email.unread = !email.flags || !email.flags.includes('\\Seen');
            });
          });
          msg.once('end', () => emails.push(email));
        });
        fetch.once('error', err => { imap.end(); res.status(500).json({ error: err.message }); });
        fetch.once('end', () => { imap.end(); res.json(emails); });
      });
    } catch (e) { imap.end(); res.status(500).json({ error: e.message }); }
  });

  imap.once('error', err => res.status(500).json({ error: err.message }));
  imap.connect();
});

// ── GET /api/emails/:uid — leer correo completo ──────────────────
app.get('/api/emails/:uid', (req, res) => {
  const uid = parseInt(req.params.uid);
  const folder = req.query.folder || 'INBOX';
  const imap = createImap();

  imap.once('ready', async () => {
    try {
      await openMailbox(imap, folder);
      const fetch = imap.fetch([uid], { bodies: '', uid: true, markSeen: true });
      fetch.on('message', msg => {
        let buffer = '';
        msg.on('body', stream => stream.on('data', c => buffer += c.toString('utf8')));
        msg.once('end', async () => {
          const parsed = await simpleParser(buffer);
          res.json({
            id: uid,
            from: parsed.from?.text || '',
            to: parsed.to?.text || '',
            subject: parsed.subject || '(Sin asunto)',
            date: parsed.date,
            text: parsed.text || '',
            html: parsed.html || parsed.text || ''
          });
        });
      });
      fetch.once('error', err => { imap.end(); res.status(500).json({ error: err.message }); });
      fetch.once('end', () => imap.end());
    } catch (e) { imap.end(); res.status(500).json({ error: e.message }); }
  });

  imap.once('error', err => res.status(500).json({ error: err.message }));
  imap.connect();
});

// ── GET /api/folders — listar carpetas ───────────────────────────
app.get('/api/folders', (req, res) => {
  const imap = createImap();
  imap.once('ready', () => {
    imap.getBoxes((err, boxes) => {
      imap.end();
      if (err) return res.status(500).json({ error: err.message });
      const list = [];
      function walk(b, prefix='') {
        Object.keys(b).forEach(k => {
          list.push(prefix + k);
          if (b[k].children) walk(b[k].children, prefix + k + b[k].delimiter);
        });
      }
      walk(boxes);
      res.json(list);
    });
  });
  imap.once('error', err => res.status(500).json({ error: err.message }));
  imap.connect();
});

// ── POST /api/send — enviar correo ───────────────────────────────
app.post('/api/send', async (req, res) => {
  const { to, cc, subject, text, html, requestDelivery, requestRead } = req.body;
  if (!to || !subject || (!text && !html))
    return res.status(400).json({ error: 'Faltan campos requeridos: to, subject, text' });

  const headers = {};
  if (requestDelivery) headers['Disposition-Notification-To'] = process.env.MAIL_USER;
  if (requestRead) headers['Return-Receipt-To'] = process.env.MAIL_USER;

  try {
    const transporter = createTransporter();
    const info = await transporter.sendMail({
      from: `"J. Ramírez — Green Elements" <${process.env.MAIL_USER}>`,
      to, cc: cc || undefined,
      subject,
      text: text || '',
      html: html || text || '',
      headers
    });
    res.json({ success: true, messageId: info.messageId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/emails/:uid — mover a papelera ───────────────────
app.delete('/api/emails/:uid', (req, res) => {
  const uid = parseInt(req.params.uid);
  const imap = createImap();
  imap.once('ready', async () => {
    try {
      await openMailbox(imap, 'INBOX');
      imap.addFlags([uid], '\\Deleted', err => {
        if (err) { imap.end(); return res.status(500).json({ error: err.message }); }
        imap.expunge(err2 => {
          imap.end();
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ success: true });
        });
      });
    } catch (e) { imap.end(); res.status(500).json({ error: e.message }); }
  });
  imap.once('error', err => res.status(500).json({ error: err.message }));
  imap.connect();
});

// ── Servir frontend ───────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Green Elements Mail corriendo en http://localhost:${PORT}`));
