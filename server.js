require('dotenv').config();
const express = require('express');
const POP3Client = require('poplib');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Cache en memoria para los correos descargados
let emailCache = [];
let lastFetch = null;

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

// ── Descargar correos via POP3 ────────────────────────────────────
function fetchEmailsPOP3() {
  return new Promise((resolve, reject) => {
    const client = new POP3Client(
      parseInt(process.env.POP3_PORT) || 995,
      process.env.MAIL_HOST,
      {
        tlserrs: false,
        enabletls: process.env.POP3_TLS === 'true',
        debug: false
      }
    );

    const emails = [];
    let totalMessages = 0;

    client.on('error', err => reject(err));

    client.on('connect', () => {
      client.login(process.env.MAIL_USER, process.env.MAIL_PASS);
    });

    client.on('invalid-state', cmd => reject(new Error('Invalid state: ' + cmd)));

    client.on('login', (status, data) => {
      if (!status) return reject(new Error('Login fallido: ' + data));
      client.list();
    });

    client.on('list', (status, msgcount, msgnumber, data, rawdata) => {
      if (!status) { client.quit(); return resolve([]); }
      totalMessages = msgcount;
      if (msgcount === 0) { client.quit(); return resolve([]); }
      // Traer los últimos 20 correos
      const start = Math.max(1, msgcount - 19);
      client.retr(start);
    });

    let currentMsg = 0;

    client.on('retr', async (status, msgnumber, data, rawdata) => {
      if (status && data) {
        try {
          const parsed = await simpleParser(data);
          emails.unshift({
            id: msgnumber,
            from: parsed.from?.text || '',
            fromEmail: parsed.from?.value?.[0]?.address || '',
            to: parsed.to?.text || '',
            subject: parsed.subject || '(Sin asunto)',
            preview: (parsed.text || '').slice(0, 100),
            date: parsed.date,
            unread: true,
            text: parsed.text || '',
            html: parsed.html || parsed.text || ''
          });
        } catch(e) {}
      }
      currentMsg = msgnumber;
      const next = msgnumber + 1;
      if (next <= totalMessages && emails.length < 20) {
        client.retr(next);
      } else {
        client.quit();
      }
    });

    client.on('quit', () => resolve(emails));
  });
}

// ── GET /api/emails ───────────────────────────────────────────────
app.get('/api/emails', async (req, res) => {
  try {
    const now = Date.now();
    // Cache de 2 minutos para no sobrecargar el servidor POP3
    if (emailCache.length > 0 && lastFetch && (now - lastFetch) < 120000) {
      return res.json(emailCache);
    }
    const emails = await fetchEmailsPOP3();
    emailCache = emails;
    lastFetch = now;
    res.json(emails);
  } catch(e) {
    console.error('POP3 error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/emails/:id ───────────────────────────────────────────
app.get('/api/emails/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  // Buscar en cache primero
  const cached = emailCache.find(e => e.id === id);
  if (cached) return res.json(cached);
  // Si no está en cache, forzar recarga
  try {
    const emails = await fetchEmailsPOP3();
    emailCache = emails;
    lastFetch = Date.now();
    const found = emails.find(e => e.id === id);
    if (found) res.json(found);
    else res.status(404).json({ error: 'Correo no encontrado' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/emails/check-new ─────────────────────────────────────
app.get('/api/emails/check-new', async (req, res) => {
  try {
    const oldIds = new Set(emailCache.map(e => e.id));
    const emails = await fetchEmailsPOP3();
    emailCache = emails;
    lastFetch = Date.now();
    const newEmails = emails.filter(e => !oldIds.has(e.id));
    res.json({ emails, newCount: newEmails.length, newEmails });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/send ────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  const { to, cc, subject, text, html, requestDelivery, requestRead } = req.body;
  if (!to || !subject || (!text && !html))
    return res.status(400).json({ error: 'Faltan campos: to, subject, text' });

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
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Servir frontend ───────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Green Elements Mail (POP3) corriendo en http://localhost:${PORT}`));
