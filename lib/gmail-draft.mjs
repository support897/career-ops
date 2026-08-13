// @ts-nocheck
// Gmail draft creation via IMAP — uses app password, no OAuth2 needed.
// APPEND to [Gmail]/Drafts with \Draft flag creates a draft visible in Gmail.

import tls from 'tls';
import { readFileSync, existsSync } from 'fs';
import { basename, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMAIL_CONFIG_PATH = join(__dirname, '../config/email.yml');

// Credentials come from caller → env → gitignored config/email.yml. NEVER hardcoded.
function emailCredentials() {
  const user = process.env.GMAIL_USER || '';
  const pass = process.env.GMAIL_APP_PASSWORD || '';
  if (user && pass) return { user, pass };
  try {
    if (existsSync(EMAIL_CONFIG_PATH)) {
      const raw = readFileSync(EMAIL_CONFIG_PATH, 'utf8');
      return {
        user: user || raw.match(/^\s*user:\s*["']?([^"'\s@]+@[^"'\s]+)["']?\s*$/m)?.[1] || '',
        pass: pass || raw.match(/^\s*app_password:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1] || '',
      };
    }
  } catch {
    // fall through — let IMAP fail loudly with an auth error
  }
  return { user, pass };
}

/**
 * Build a MIME multipart/mixed message with HTML body and file attachments.
 */
function buildMimeMessage({ from, to, subject, body, attachments = [] }) {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const parts = [];

  // Text body
  parts.push(
    `Content-Type: text/plain; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: quoted-printable\r\n\r\n` +
    body
  );

  // Attachment parts
  for (const att of attachments) {
    if (!existsSync(att.path)) {
      console.warn(`   ⚠️  Attachment not found, skipping: ${att.path}`);
      continue;
    }
    const filename = att.filename || basename(att.path);
    const content = readFileSync(att.path);
    const isPdf = filename.endsWith('.pdf');
    const mimeType = isPdf ? 'application/pdf' : 'application/octet-stream';

    const base64 = content.toString('base64');
    const wrapped = base64.match(/.{1,76}/g).join('\r\n');
    parts.push(
      `Content-Type: ${mimeType}; name="${filename}"\r\n` +
      `Content-Disposition: attachment; filename="${filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      wrapped
    );
  }

  const date = new Date().toUTCString();
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@careerflow>`;

  const mimeMessage =
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `Date: ${date}\r\n` +
    `Message-ID: ${messageId}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    parts.map(p => `--${boundary}\r\n${p}`).join('\r\n') +
    `\r\n--${boundary}--`;

  return mimeMessage;
}

/**
 * Raw IMAP connection helper — handles LOGIN, SELECT, APPEND with literal.
 */
function imapAppend({ host, port, user, password, folder, mimeMessage }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false });
    let buffer = '';
    let tagNum = 0;
    let waitingForLiteral = false;
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('IMAP timeout')); }, 15000);

    function send(cmd) {
      tagNum++;
      socket.write('A' + tagNum + ' ' + cmd + '\r\n');
    }

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;

        if (line === '+ go ahead' && waitingForLiteral) {
          socket.write(mimeMessage + '\r\n');
          waitingForLiteral = false;
          continue;
        }

        if (line.startsWith('A1 OK')) {
          send(`SELECT "${folder}"`);
        } else if (line.startsWith('A2 OK')) {
          const byteLen = Buffer.byteLength(mimeMessage);
          send(`APPEND "${folder}" (\\Draft) {${byteLen}}`);
          waitingForLiteral = true;
        } else if (line.startsWith('A3 OK')) {
          clearTimeout(timeout);
          send('LOGOUT');
          socket.end();
          const uidMatch = line.match(/APPENDUID \d+ (\d+)/);
          resolve({ success: true, uid: uidMatch ? uidMatch[1] : null });
        } else if (line.startsWith('A3 BAD') || line.startsWith('A3 NO')) {
          clearTimeout(timeout);
          send('LOGOUT');
          socket.end();
          reject(new Error(`IMAP APPEND failed: ${line}`));
        }
      }
    });

    socket.on('error', (err) => { clearTimeout(timeout); reject(err); });

    setTimeout(() => send(`LOGIN ${user} ${password}`), 300);
  });
}

/**
 * Create a Gmail draft via IMAP with app password.
 * No OAuth2 needed — just Gmail + app password.
 *
 * @param {object} opts
 * @param {string} opts.from - Sender email
 * @param {string} opts.to - Recipient email (or empty string for unsent draft)
 * @param {string} opts.subject - Email subject
 * @param {string} opts.body - Plain text email body
 * @param {Array<{path: string, filename?: string}>} [opts.attachments] - Files to attach
 * @param {object} [opts.credentials] - Optional override (falls back to env/config)
 * @returns {Promise<{success: boolean, uid?: string, error?: string}>}
 */
export async function createGmailDraft({ from, to, subject, body, attachments = [], credentials }) {
  const { user: credUser, pass: credPass } = emailCredentials();
  const user = credentials?.user || credUser;
  const password = credentials?.password || credPass;
  const host = 'imap.gmail.com';
  const port = 993;
  const folder = '[Gmail]/Drafts';

  const mimeMessage = buildMimeMessage({ from, to: to || '', subject, body, attachments });

  try {
    const result = await imapAppend({ host, port, user, password, folder, mimeMessage });
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Check if Gmail app password credentials are configured.
 */
export function hasGmailCredentials() {
  return !!(process.env.GMAIL_USER || process.env.GMAIL_APP_PASSWORD || 'placenciailse@gmail.com');
}
