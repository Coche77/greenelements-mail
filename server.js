require('dotenv').config();
const express = require('express');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const tls = require('tls');
const net = require('net');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let emailCache = [];
let lastFetch = null;

// ── Configuración SMTP ────────────────────────────────────────────
function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: parseInt(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
    tls: { rejectUnauthorized: false }
  });
}

// ── POP3 manual con TLS ───────────────────────────────────────────
function fetchPOP3() {
  return new Promise((resolve, reject) => {
    const host = process.env.MAIL_HOST || 'mail.greenelements.mx';
    const port = parseInt(process.env.POP3_PORT) || 995;
    const user = process.env.MAIL_USER;
    const pass = process.env.MAIL_PASS;

    //console.log(`Conectando POP3 a ${host}:${port}`);

    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      //console.log('TLS conectado');
    });

    const emails = [];
    let buffer = '';
    let state = 'GREETING';
    let msgList = [];
    let currentMsg = 0;
    let msgBuffer = '';
    let inMsg = false;

    socket.on('error', err => {
      console.error('Socket error:', err.message);
      reject(err);
    });

    socket.setTimeout(15000, () => {
      console.error('Timeout POP3');
      socket.destroy();
      reject(new Error('Timeout conectando al servidor POP3'));
    });

    function send(cmd) {
      console.log('>> ' + cmd.replace(pass, '***'));
      socket.write(cmd + '\r\n');
    }

    socket.on('data', async chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop();

      for (const line of lines) {
        console.log('<< ' + line.substring(0, 80));

        if (state === 'GREETING' && line.startsWith('+OK')) {
          state = 'USER';
          send(`USER ${user}`);
        } else if (state === 'USER' && line.startsWith('+OK')) {
          state = 'PASS';
          send(`PASS ${pass}`);
        } else if (state === 'PASS' && line.startsWith('+OK')) {
          state = 'LIST';
          send('LIST');
        } else if (state === 'LIST') {
          if (line.startsWith('+OK')) {
            // esperando lista
          } else if (line === '.') {
            state = 'RETR';
            if (msgList.length === 0) { send('QUIT'); return; }
            const start = Math.max(0, msgList.length - 20);
            msgList = msgList.slice(start);
            currentMsg = 0;
            send(`RETR ${msgList[0].num}`);
          } else if (/^\d+/.test(line)) {
            const parts = line.split(' ');
            msgList.push({ num: parseInt(parts[0]), size: parseInt(parts[1]) });
          }
        } else if (state === 'RETR') {
          if (line.startsWith('+OK')) {
            inMsg = true;
            msgBuffer = '';
          } else if (line === '.' && inMsg) {
            inMsg = false;
            try {
              const parsed = await simpleParser(msgBuffer);
              emails.unshift({
                id: msgList[currentMsg].num,
                from: parsed.from?.text || '',
                fromEmail: parsed.from?.value?.[0]?.address || '',
                to: parsed.to?.text || '',
                subject: parsed.subject || '(Sin asunto)',
                preview: (parsed.text || '').slice(0, 100).replace(/\n/g, ' '),
                date: parsed.date,
                unread: true,
                text: parsed.text || '',
                html: parsed.html || parsed.text || ''
              });
            } catch(e) { console.error('Parse error:', e.message); }
            currentMsg++;
            if (currentMsg < msgList.length) {
              send(`RETR ${msgList[currentMsg].num}`);
            } else {
              send('QUIT');
            }
          } else if (inMsg) {
            msgBuffer += (line === '..' ? '.' : line) + '\r\n';
          }
        } else if (state === 'QUIT' || line.startsWith('+OK Bye')) {
          socket.destroy();
          resolve(emails);
        }

        if (line.startsWith('-ERR')) {
          console.error('POP3 Error:', line);
          socket.destroy();
          reject(new Error('POP3: ' + line));
        }
      }
    });

    socket.on('close', () => {
      if (state !== 'QUIT') resolve(emails);
    });
  });
}

// ── GET /api/emails ───────────────────────────────────────────────
app.get('/api/emails', async (req, res) => {
  try {
    const now = Date.now();
    if (emailCache.length > 0 && lastFetch && (now - lastFetch) < 120000) {
      return res.json(emailCache);
    }
    console.log('Fetching emails via POP3...');
    const emails = await fetchPOP3();
    emailCache = emails;
    lastFetch = now;
    console.log(`Fetched ${emails.length} emails`);
    res.json(emails);
  } catch(e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/emails/:id ───────────────────────────────────────────
app.get('/api/emails/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const cached = emailCache.find(e => e.id === id);
  if (cached) return res.json(cached);
  res.status(404).json({ error: 'Correo no encontrado' });
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
    const info = await createTransporter().sendMail({
      from: `"J. Ramírez — Green Elements" <${process.env.MAIL_USER}>`,
      to, cc: cc || undefined, subject,
      text: text || '', html: html || text || '', headers
    });
    res.json({ success: true, messageId: info.messageId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Test conexión ─────────────────────────────────────────────────
app.get('/api/test', async (req, res) => {
  try {
    const emails = await fetchPOP3();
    res.json({ success: true, count: emails.length, message: `Conexión exitosa, ${emails.length} correos encontrados` });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Green Elements Mail (POP3) corriendo en http://localhost:${PORT}`));
