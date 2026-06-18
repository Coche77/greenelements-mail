require('dotenv').config();
const express = require('express');
const { simpleParser } = require('mailparser');
const cors = require('cors');
const path = require('path');
const tls = require('tls');
const https = require('https');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let emailCache = [];
let lastFetch = null;
let sentEmails = [];
let readIds = new Set();

function sendViaBrevo(to, subject, text, cc, headers, attachments) {
  return new Promise((resolve, reject) => {
    const payload = {
      sender: { name: 'Joe Ramirez', email: process.env.MAIL_USER },
      to: [{ email: to }],
      subject,
      textContent: text
    };
    if (cc) payload.cc = [{ email: cc }];
    if (headers && Object.keys(headers).length > 0) payload.headers = headers;
    if (attachments && attachments.length > 0) {
      payload.attachment = attachments.map(f => ({
        name: f.originalname,
        content: f.buffer.toString('base64')
      }));
    }
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`Brevo error ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
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
    let buffer = '', state = 'GREETING', msgList = [], currentMsg = 0, msgBuffer = '', inMsg = false;
    socket.on('error', err => reject(err));
    socket.setTimeout(20000, () => { socket.destroy(); reject(new Error('Timeout POP3')); });
    function send(cmd) { socket.write(cmd + '\r\n'); }
    socket.on('data', async chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (state === 'GREETING' && line.startsWith('+OK')) { state = 'USER'; send(`USER ${user}`); }
        else if (state === 'USER' && line.startsWith('+OK')) { state = 'PASS'; send(`PASS ${pass}`); }
        else if (state === 'PASS' && line.startsWith('+OK')) { state = 'LIST'; send('LIST'); }
        else if (state === 'LIST') {
          if (line === '.') {
            state = 'RETR';
            if (!msgList.length) { send('QUIT'); return; }
            const start = Math.max(0, msgList.length - 20);
            msgList = msgList.slice(start);
            currentMsg = 0;
            send(`RETR ${msgList[0].num}`);
          } else if (/^\d+/.test(line)) {
            msgList.push({ num: parseInt(line.split(' ')[0]) });
          }
        } else if (state === 'RETR') {
          if (line.startsWith('+OK')) { inMsg = true; msgBuffer = ''; }
          else if (line === '.' && inMsg) {
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
                html: parsed.html || parsed.text || '',
                attachments: parsed.attachments?.map(a => ({ name: a.filename, size: a.size })) || []
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

function deletePOP3(msgNum) {
  return new Promise((resolve, reject) => {
    const host = process.env.MAIL_HOST || 'mail.greenelements.mx';
    const port = parseInt(process.env.POP3_PORT) || 995;
    const socket = tls.connect({ host, port, rejectUnauthorized: false });
    let buffer = '', state = 'GREETING';
    socket.on('error', err => reject(err));
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('Timeout')); });
    function send(cmd) { socket.write(cmd + '\r\n'); }
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (state === 'GREETING' && line.startsWith('+OK')) { state = 'USER'; send(`USER ${process.env.MAIL_USER}`); }
        else if (state === 'USER' && line.startsWith('+OK')) { state = 'PASS'; send(`PASS ${process.env.MAIL_PASS}`); }
        else if (state === 'PASS' && line.startsWith('+OK')) { state = 'DELE'; send(`DELE ${msgNum}`); }
        else if (state === 'DELE' && line.startsWith('+OK')) { state = 'QUIT'; send('QUIT'); }
        else if (state === 'QUIT') { socket.destroy(); resolve(true); }
        if (line.startsWith('-ERR')) { socket.destroy(); reject(new Error(line)); }
      }
    });
    socket.on('close', () => resolve(true));
  });
}

app.get('/api/emails', async (req, res) => {
  try {
    const folder = req.query.folder || 'INBOX';
    if (folder === 'Sent') return res.json(sentEmails);
    const now = Date.now();
    if (emailCache.length > 0 && lastFetch && (now - lastFetch) < 120000) {
      const withRead = emailCache.map(e => ({ ...e, unread: !readIds.has(e.id) }));
      return res.json(withRead);
    }
    const emails = await fetchPOP3();
    emailCache = emails; lastFetch = now;
    const withRead = emails.map(e => ({ ...e, unread: !readIds.has(e.id) }));
    res.json(withRead);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/emails/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const cached = emailCache.find(e => e.id === id);
  if (cached) {
    readIds.add(id);
    return res.json(cached);
  }
  const sent = sentEmails.find(e => e.id === id);
  if (sent) return res.json(sent);
  res.status(404).json({ error: 'No encontrado' });
});

app.delete('/api/emails/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await deletePOP3(id);
    emailCache = emailCache.filter(e => e.id !== id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send', upload.array('attachments'), async (req, res) => {
  const { to, cc, subject, text, requestDelivery, requestRead } = req.body;
  if (!to || !subject || !text) return res.status(400).json({ error: 'Faltan campos' });
  const headers = {};
  if (requestDelivery) headers['Disposition-Notification-To'] = process.env.MAIL_USER;
  if (requestRead) headers['Return-Receipt-To'] = process.env.MAIL_USER;
  try {
    await sendViaBrevo(to, subject, text, cc, headers, req.files);
    const sentId = Date.now();
    sentEmails.unshift({
      id: sentId,
      from: `Joe Ramirez <${process.env.MAIL_USER}>`,
      fromEmail: process.env.MAIL_USER,
      to, cc: cc || '',
      subject,
      preview: text.slice(0, 100),
      date: new Date().toISOString(),
      unread: false,
      text, html: text,
      attachments: (req.files||[]).map(f => ({ name: f.originalname, size: f.size }))
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
    await sendViaBrevo('jramirez@greenelements.mx', 'Test conexión', 'Prueba desde Green Elements Mail');
    res.json({ success: true, message: 'Correo de prueba enviado' });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(process.env.PORT || 3000);
