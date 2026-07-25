// @ts-check
// Gmail draft creation — builds a MIME message with attachments and creates
// a draft in the user's Gmail Drafts folder via the Gmail API.
//
// Requires OAuth2 credentials: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
// Scopes needed: https://www.googleapis.com/auth/gmail.compose

import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Exchange refresh token for short-lived access token.
 */
async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Gmail token refresh failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Gmail token refresh returned no access_token');
  return data.access_token;
}

/**
 * Encode a string to base64url (Gmail API format).
 */
function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Build a MIME multipart/mixed message with HTML body and file attachments.
 *
 * @param {object} opts
 * @param {string} opts.from - Sender email
 * @param {string} opts.to - Recipient email
 * @param {string} opts.subject - Email subject
 * @param {string} opts.htmlBody - HTML email body
 * @param {Array<{path: string, filename?: string}>} [opts.attachments] - Files to attach
 * @returns {string} Raw MIME message
 */
function buildMimeMessage({ from, to, subject, htmlBody, attachments = [] }) {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const parts = [];

  // HTML body part
  parts.push(
    `Content-Type: text/html; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    base64UrlEncode(htmlBody)
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

    parts.push(
      `Content-Type: ${mimeType}; name="${filename}"\r\n` +
      `Content-Disposition: attachment; filename="${filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      content.toString('base64')
    );
  }

  const mimeBody =
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    parts.map(p => `--${boundary}\r\n${p}`).join('\r\n') +
    `\r\n--${boundary}--`;

  return mimeBody;
}

/**
 * Create a Gmail draft with optional file attachments.
 *
 * @param {object} opts
 * @param {string} opts.from - Sender email
 * @param {string} opts.to - Recipient email (or empty string for unsent draft)
 * @param {string} opts.subject - Email subject
 * @param {string} opts.htmlBody - HTML email body
 * @param {Array<{path: string, filename?: string}>} [opts.attachments] - PDF files to attach
 * @param {object} [opts.credentials] - OAuth2 creds (falls back to env vars)
 * @returns {Promise<{success: boolean, draftId?: string, error?: string}>}
 */
export async function createGmailDraft({ from, to, subject, htmlBody, attachments = [], credentials }) {
  const clientId = credentials?.clientId || process.env.GMAIL_CLIENT_ID;
  const clientSecret = credentials?.clientSecret || process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = credentials?.refreshToken || process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return { success: false, error: 'Missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN' };
  }

  try {
    const accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });

    const mimeMessage = buildMimeMessage({ from, to, subject, htmlBody, attachments });
    const encodedMessage = base64UrlEncode(mimeMessage);

    const res = await fetch(`${GMAIL_API}/drafts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: { raw: encodedMessage } }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      return { success: false, error: `Gmail API ${res.status}: ${errBody.slice(0, 300)}` };
    }

    const draft = await res.json();
    return { success: true, draftId: draft.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Check if Gmail OAuth2 credentials are configured.
 */
export function hasGmailCredentials() {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);
}
