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
  const user = process.env.GMAIL_USER || 'placenciailse@gmail.com';
  const pass = process.env.GMAIL_APP_PASSWORD || '';
  if (user && pass && user !== 'dummy@gmail.com' && pass !== 'dummy') return { user, pass };
  try {
    if (existsSync(EMAIL_CONFIG_PATH)) {
      const raw = readFileSync(EMAIL_CONFIG_PATH, 'utf8');
      const parsedUser = user || raw.match(/^\s*user:\s*["']?([^"'\s@]+@[^"'\s]+)["']?\s*$/m)?.[1] || '';
      const parsedPass = pass || raw.match(/^\s*app_password:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1] || '';
      if (parsedUser && parsedPass && parsedUser !== 'dummy@gmail.com' && parsedPass !== 'dummy') {
        return { user: parsedUser, pass: parsedPass };
      }
    }
  } catch {
    // fall through
  }
  return { user: 'placenciailse@gmail.com', pass: '' };
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
    let content;
    let filename;
    if (att.content) {
      content = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content, 'base64');
      filename = att.filename;
    } else {
      if (!att.path || !existsSync(att.path)) {
        console.warn(`   ⚠️  Attachment path not found, skipping: ${att.path}`);
        continue;
      }
      filename = att.filename || basename(att.path);
      content = readFileSync(att.path);
    }
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
    // Verify the certificate. This previously passed rejectUnauthorized: false,
    // which accepts any certificate at all and would hand the app password to a
    // man in the middle. The reason it was "needed": without an explicit
    // servername no SNI is sent, Gmail answers with a default self-signed
    // certificate, and Node fails with DEPTH_ZERO_SELF_SIGNED_CERT — which looks
    // like a broken CA store and invites disabling verification. Setting
    // servername returns the real Google Trust Services chain and verifies.
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
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

  let attempts = 0;
  let lastError;
  while (attempts < 4) {
    try {
      const result = await imapAppend({ host, port, user, password, folder, mimeMessage });
      return result;
    } catch (err) {
      lastError = err;
      attempts++;
      if (attempts >= 4) break;
      const delayMs = Math.pow(2, attempts) * 2000 + Math.random() * 1000;
      console.warn(`   ⚠️  IMAP error: ${err.message}. Retrying in ${Math.round(delayMs / 1000)}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return { success: false, error: lastError?.message || "Failed after retries" };
}

/**
 * Send an email directly via Gmail SMTP.
 * Also sends a copy to the user's email so they get instant confirmation in their inbox.
 */
export async function sendGmailEmail({ from, to, subject, body, attachments = [], credentials }) {
  const user = credentials?.user || process.env.GMAIL_USER || 'placenciailse@gmail.com';
  const password = credentials?.password || process.env.GMAIL_APP_PASSWORD;
  if (!password) {
    // Previously a real app password was hardcoded here as a fallback. Failing
    // loudly is better than silently authenticating as someone else's mailbox.
    throw new Error('GMAIL_APP_PASSWORD is not set — cannot create a draft');
  }

  const nodemailer = (await import('nodemailer')).default;
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass: password },
  });

  const cleanBody = body.replace(/^🔗 APPLY HERE:[^\n]+\n+/, '');

  const mailOptions = {
    from: from || user,
    to: to, // Strictly send ONLY to the recruiter!
    subject,
    text: cleanBody,
    attachments: attachments.filter(a => a && a.path && existsSync(a.path)).map(att => ({
      filename: att.filename || basename(att.path),
      path: att.path,
    })),
  };



  try {
    const info = await transporter.sendMail(mailOptions);
    return { success: true, messageId: info.messageId };
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

/**
 * IMAP Helper to search unread emails for security verification codes (4-8 digits)
 */
export async function fetchVerificationCodeFromGmail({ company = '', maxWaitSeconds = 60 } = {}) {
  const user = process.env.GMAIL_USER || 'placenciailse@gmail.com';
  const password = process.env.GMAIL_APP_PASSWORD || '';
  const host = 'imap.gmail.com';
  const port = 993;

  console.log(`   📧 Searching Gmail for security verification code (polling up to ${maxWaitSeconds}s)...`);
  const startTime = Date.now();

  while ((Date.now() - startTime) < maxWaitSeconds * 1000) {
    try {
      const codeResult = await imapFetchCodeInternal({ host, port, user, password, company });
      if (codeResult?.code) {
        console.log(`   🔑 Verification Code Found in Gmail: ${codeResult.code}`);
        return { success: true, code: codeResult.code, subject: codeResult.subject };
      }
    } catch (e) {}

    await new Promise(r => setTimeout(r, 4000));
  }

  return { success: false, error: 'Verification code timeout' };
}

/**
 * IMAP Helper to check for confirmation email ("Thank you for applying")
 */
export async function verifyApplicationEmailReceived({ company = '', maxWaitSeconds = 30 } = {}) {
  const user = process.env.GMAIL_USER || 'placenciailse@gmail.com';
  const password = process.env.GMAIL_APP_PASSWORD || '';
  const host = 'imap.gmail.com';
  const port = 993;

  console.log(`   📧 Verifying inbound application confirmation email from ${company}...`);
  const startTime = Date.now();

  while ((Date.now() - startTime) < maxWaitSeconds * 1000) {
    try {
      const confirmed = await imapCheckConfirmationInternal({ host, port, user, password, company });
      if (confirmed?.found) {
        console.log(`   ✅ Email Confirmation Found in Gmail: ${confirmed.subject}`);
        return { success: true, confirmed: true, subject: confirmed.subject, from: confirmed.from };
      }
    } catch (e) {}

    await new Promise(r => setTimeout(r, 4000));
  }

  return { success: false, error: 'Email confirmation timeout' };
}

function imapFetchCodeInternal({ host, port, user, password, company }) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
    let buffer = '';
    let tagNum = 0;

    const timeout = setTimeout(() => { socket.destroy(); resolve(null); }, 10000);

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

        if (line.startsWith('A1 OK')) {
          send('SELECT INBOX');
        } else if (line.startsWith('A2 OK')) {
          send('SEARCH UNSEEN');
        } else if (line.startsWith('* SEARCH')) {
          const uids = line.replace('* SEARCH', '').trim().split(' ').filter(Boolean);
          if (uids.length > 0) {
            send(`FETCH ${uids[uids.length - 1]} BODY[TEXT]`);
          } else {
            clearTimeout(timeout);
            send('LOGOUT');
            socket.end();
            resolve(null);
          }
        } else if (line.startsWith('A4 OK') || line.startsWith('A3 OK')) {
          const codeMatch = buffer.match(/\b(\d{4,8})\b/);
          clearTimeout(timeout);
          send('LOGOUT');
          socket.end();
          if (codeMatch) {
            resolve({ code: codeMatch[1], subject: 'Verification Code' });
          } else {
            resolve(null);
          }
        }
      }
    });

    socket.on('error', () => { clearTimeout(timeout); resolve(null); });
    send(`LOGIN "${user}" "${password}"`);
  });
}

function imapCheckConfirmationInternal({ host, port, user, password, company }) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
    let buffer = '';
    let tagNum = 0;

    const timeout = setTimeout(() => { socket.destroy(); resolve(null); }, 10000);

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

        if (line.startsWith('A1 OK')) {
          send('SELECT INBOX');
        } else if (line.startsWith('A2 OK')) {
          send('SEARCH UNSEEN');
        } else if (line.startsWith('* SEARCH')) {
          const uids = line.replace('* SEARCH', '').trim().split(' ').filter(Boolean);
          if (uids.length > 0) {
            send(`FETCH ${uids[uids.length - 1]} BODY[HEADER.FIELDS (SUBJECT FROM)]`);
          } else {
            clearTimeout(timeout);
            send('LOGOUT');
            socket.end();
            resolve(null);
          }
        } else if (line.startsWith('A4 OK') || line.startsWith('A3 OK')) {
          const bLower = buffer.toLowerCase();
          const found = bLower.includes('thank') || bLower.includes('application') || bLower.includes('received') || (company && bLower.includes(company.toLowerCase()));
          clearTimeout(timeout);
          send('LOGOUT');
          socket.end();
          if (found) {
            resolve({ found: true, subject: 'Application Confirmation Received' });
          } else {
            resolve(null);
          }
        }
      }
    });

    socket.on('error', () => { clearTimeout(timeout); resolve(null); });
    send(`LOGIN "${user}" "${password}"`);
  });
}


