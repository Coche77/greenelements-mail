require('dotenv').config();
const express = require('express');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const tls = require('tls');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let emailCache = [];
let lastFetch = null;

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    tls: { rejectUnauthorized: false }
  });
}

function fetchPOP3() {
  return new Promise((resolve, reject) => {
    const host = process.env.MAIL_HOST || 'mail.greenelements.mx';
    const port = parseInt(process.env.POP3_PORT) || 995;
    const user = process.env.MAIL_USER;
    const pass = process.env.MAIL_PASS;

    const socket = tls.connect({ host, port, rejectUnauthorized: false });
    const emails = [];
    let buffer = '';
    let state = 'GREETING';
    let msgList = [];
    let currentMsg = 0;
    let msgBuffer = '';
    let inMsg = false;

    socket.on('error', err => reject(err));
    socket.setTimeout(20000, () => { socket.destroy(); reject(new Error('Timeout POP3')); });

    function send(cmd) { socket.write(cmd + '\r\n'); }

    socket.on('data', async chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (state === 'GREETING' && line.startsWith('+OK')) {
          state = 'USER'; send(`USER ${user}`);
        } else if (state === 'USER' && line.startsWith('+OK')) {
          state = 'PASS'; send(`PASS ${pass}`);
        } else if (state === 'PASS' && line.startsWith('+OK')) {
          state = 'LIST'; send('LIST');
        } else if (state === 'LIST') {
          if (line === '.') {
            state = 'RETR';
            if (msgList.length === 0) { send('QUIT'); return; }
            const start = Math.max(0, msgList.length - 20);
            msgList = msgList.slice(start);
            currentMsg = 0;
            send(`RETR ${msgList[0].num}`);
          } else if (/^\d+/.test(line)) {
            const parts = line.split(' ');
            msgList.push({ num: parseInt(parts[0]) });
          }
        } else if (state === 'RETR') {
          if (line.startsWith('+OK')) {
            inMsg = true; msgBuffer = '';
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
            } catch(e) {}
            currentMsg++;
            if (currentMsg < msgList.length) send(`RETR ${msgList[currentMsg].num}`);
            else send('QUIT');
          } else if (inMsg) {
            msgBuffer += (line === '..' ? '.' : line) + '\r\n';
          }
        }
        if (line.startsWith('-ERR')) { socket.destroy(); reject(new Error(line)); }
      }
    });

    socket.on('close', () => resolve(emails));
  });
}

app.get('/api/emails', async (req, res) => {
  try {
    const now = Date.now();
    if (emailCache.length > 0 && lastFetch && (now - lastFetch) < 120000)
      return res.json(emailCache);
    const emails = await fetchPOP3();
    emailCache = emails; lastFetch = now;
    res.json(emails);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/emails/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const cached = emailCache.find(e => e.id === id);
  if (cached) return res.json(cached);
  res.status(404).json({ error: 'No encontrado' });
});

app.post('/api/send', async (req, res) => {
  const { to, cc, subject, text, html, requestDelivery, requestRead } = req.body;
  if (!to || !subject || (!text && !html))
    return res.status(400).json({ error: 'Faltan campos' });
  const headers = {};
  if (requestDelivery) headers['Disposition-Notification-To'] = process.env.MAIL_USER;
  if (requestRead) headers['Return-Receipt-To'] = process.env.MAIL_USER;
  try {
    await createTransporter().sendMail({
      from: `"J. Ramírez — Green Elements" <${process.env.MAIL_USER}>`,
      to, cc: cc || undefined, subject,
      text: text || '', html: html || text || '', headers
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/test', async (req, res) => {
  try {
    const emails = await fetchPOP3();
    res.json({ success: true, count: emails.length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/test-smtp', async (req, res) => {
  try {
    await createTransporter().verify();
    res.json({ success: true, message: 'SMTP OK' });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT);
