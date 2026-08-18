/**
 * Show one draft by uid. Read-only: no flags set, no expunge.
 */
import 'dotenv/config';
import tls from 'tls';

const UID = process.argv[2];
if (!UID) { console.error('usage: node inspect-draft.mjs <uid>'); process.exit(1); }

const user = process.env.GMAIL_USER;
const pass = process.env.GMAIL_APP_PASSWORD;
if (!user || !pass) { console.error('GMAIL_USER / GMAIL_APP_PASSWORD not set'); process.exit(1); }

const socket = tls.connect({ host: 'imap.gmail.com', port: 993, servername: 'imap.gmail.com', rejectUnauthorized: true });
let buf = '';
let step = 0;

const send = (s) => socket.write(s + '\r\n');

socket.on('data', (d) => {
  buf += d.toString('utf8');
  if (step === 0 && buf.includes('* OK')) { step = 1; buf = ''; send(`a1 LOGIN "${user}" "${pass}"`); return; }
  if (step === 1 && /a1 (OK|NO|BAD)/.test(buf)) {
    if (!/a1 OK/.test(buf)) { console.error('login failed'); socket.end(); process.exit(1); }
    step = 2; buf = ''; send('a2 SELECT "[Gmail]/Drafts"'); return;
  }
  if (step === 2 && /a2 (OK|NO|BAD)/.test(buf)) {
    step = 3; buf = ''; send(`a3 UID FETCH ${UID} (BODY.PEEK[HEADER.FIELDS (SUBJECT TO DATE)])`); return;
  }
  if (step === 3 && /a3 (OK|NO|BAD)/.test(buf)) {
    console.log(buf.split('\r\n').filter((l) => /^(Subject|To|Date):/i.test(l)).join('\n') || '(no such uid)');
    socket.end(); process.exit(0);
  }
});
socket.on('error', (e) => { console.error('socket error:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 45000);
