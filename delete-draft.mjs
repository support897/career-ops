/**
 * Delete ONE draft by uid, but only if its subject contains an expected string.
 *
 * The guard exists because uid-based deletion is unforgiving: a stale uid would
 * silently destroy a real application draft. Requires both the uid and a
 * substring of the subject to agree before anything is flagged.
 *
 * Usage: node delete-draft.mjs <uid> "<expected subject substring>"
 */
import 'dotenv/config';
import tls from 'tls';

const UID = process.argv[2];
const EXPECT = process.argv[3];
if (!UID || !EXPECT) {
  console.error('usage: node delete-draft.mjs <uid> "<expected subject substring>"');
  process.exit(1);
}

const user = process.env.GMAIL_USER;
const pass = process.env.GMAIL_APP_PASSWORD;
if (!user || !pass) { console.error('GMAIL_USER / GMAIL_APP_PASSWORD not set'); process.exit(1); }

const socket = tls.connect({ host: 'imap.gmail.com', port: 993, servername: 'imap.gmail.com', rejectUnauthorized: true });
const send = (s) => socket.write(s + '\r\n');
let buf = '';
let step = 0;

socket.on('data', (d) => {
  buf += d.toString('utf8');

  if (step === 0 && buf.includes('* OK')) { step = 1; buf = ''; send(`a1 LOGIN "${user}" "${pass}"`); return; }

  if (step === 1 && /a1 (OK|NO|BAD)/.test(buf)) {
    if (!/a1 OK/.test(buf)) { console.error('login failed'); socket.end(); process.exit(1); }
    step = 2; buf = ''; send('a2 SELECT "[Gmail]/Drafts"'); return;
  }

  if (step === 2 && /a2 (OK|NO|BAD)/.test(buf)) {
    step = 3; buf = ''; send(`a3 UID FETCH ${UID} (BODY.PEEK[HEADER.FIELDS (SUBJECT)])`); return;
  }

  if (step === 3 && /a3 (OK|NO|BAD)/.test(buf)) {
    const subject = (buf.match(/^Subject:\s*(.*)$/im) || [, ''])[1];
    console.log(`uid ${UID} subject: ${subject || '(none)'}`);
    // Decode just enough of RFC 2047 to match on the readable part.
    const readable = subject.replace(/=\?UTF-8\?Q\?/i, '').replace(/\?=/g, '').replace(/_/g, ' ');
    if (!readable.includes(EXPECT)) {
      console.error(`REFUSING: subject does not contain "${EXPECT}". Nothing was changed.`);
      socket.end(); process.exit(1);
    }
    console.log('guard passed — flagging deleted');
    step = 4; buf = ''; send(`a4 UID STORE ${UID} +FLAGS (\\Deleted)`); return;
  }

  if (step === 4 && /a4 (OK|NO|BAD)/.test(buf)) {
    if (!/a4 OK/.test(buf)) { console.error('store failed'); socket.end(); process.exit(1); }
    step = 5; buf = ''; send('a5 EXPUNGE'); return;
  }

  if (step === 5 && /a5 (OK|NO|BAD)/.test(buf)) {
    console.log(/a5 OK/.test(buf) ? `deleted draft ${UID} (moved to Trash)` : 'expunge failed');
    socket.end(); process.exit(0);
  }
});

socket.on('error', (e) => { console.error('socket error:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 60000);
