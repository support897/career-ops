/**
 * cookie-crypto.mjs — AES-256-GCM encryption for per-user cookies.
 *
 * Each user gets a unique encryption key derived from:
 *   PBKDF2(MASTER_KEY, userId, 100000, 32, 'sha512')
 *
 * Cookie format: base64(iv + authTag + encryptedData)
 *
 * Usage:
 *   import { encryptCookies, decryptCookies } from './lib/cookie-crypto.mjs';
 *   const encrypted = encryptCookies(userId, cookiesArray);
 *   const cookies = decryptCookies(userId, encrypted);
 */

import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;
const DIGEST = 'sha512';

/**
 * Derive a per-user encryption key from the master key + userId.
 *
 * @param {string} userId - The Clerk user ID
 * @param {Buffer} masterKey - The master encryption key (32 bytes)
 * @returns {Buffer} Derived 32-byte key
 */
function deriveKey(userId, masterKey) {
  return pbkdf2Sync(masterKey, userId, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
}

/**
 * Get the master encryption key from environment or generate one.
 * In production, ENCRYPTION_KEY must be set in env.
 *
 * @returns {Buffer} 32-byte master key
 */
function getMasterKey() {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    // Accept hex, base64, or raw string
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
      return Buffer.from(envKey, 'hex');
    }
    if (/^[A-Za-z0-9+/]+=*$/.test(envKey) && envKey.length >= 44) {
      return Buffer.from(envKey, 'base64');
    }
    // Derive from string passphrase
    return pbkdf2Sync(envKey, 'career-ops-salt', 100000, KEY_LENGTH, DIGEST);
  }
  // Development fallback — NOT secure for production
  console.warn('⚠️  ENCRYPTION_KEY not set — using development key (NOT secure for production)');
  return pbkdf2Sync('career-ops-dev-key', 'career-ops-salt', 100000, KEY_LENGTH, DIGEST);
}

/**
 * Encrypt an array of cookie objects.
 *
 * @param {string} userId - The Clerk user ID (used for key derivation)
 * @param {Array<{name: string, value: string, domain?: string, path?: string, httpOnly?: boolean, secure?: boolean, sameSite?: string, expires?: number}>} cookies
 * @returns {string} Base64-encoded encrypted payload
 */
export function encryptCookies(userId, cookies) {
  if (!userId || !cookies || cookies.length === 0) return null;

  const masterKey = getMasterKey();
  const derivedKey = deriveKey(userId, masterKey);
  const iv = randomBytes(IV_LENGTH);

  const plaintext = Buffer.from(JSON.stringify(cookies), 'utf8');

  const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: iv(16) + authTag(16) + encryptedData
  const payload = Buffer.concat([iv, authTag, encrypted]);
  return payload.toString('base64');
}

/**
 * Decrypt an encrypted cookie payload back to an array of cookie objects.
 *
 * @param {string} userId - The Clerk user ID (used for key derivation)
 * @param {string} encryptedPayload - Base64-encoded encrypted payload
 * @returns {Array<{name: string, value: string, domain?: string, ...}>|null} Decrypted cookies or null on failure
 */
export function decryptCookies(userId, encryptedPayload) {
  if (!userId || !encryptedPayload) return null;

  try {
    const masterKey = getMasterKey();
    const derivedKey = deriveKey(userId, masterKey);
    const payload = Buffer.from(encryptedPayload, 'base64');

    if (payload.length < IV_LENGTH + TAG_LENGTH + 1) {
      console.error('[cookie-crypto] Payload too short');
      return null;
    }

    const iv = payload.subarray(0, IV_LENGTH);
    const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = payload.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (e) {
    console.error(`[cookie-crypto] Decryption failed: ${e.message}`);
    return null;
  }
}

/**
 * Convert cookie objects to Puppeteer setCookie format.
 *
 * @param {Array} cookies - Decrypted cookie objects
 * @returns {Array} Puppeteer-compatible cookie objects
 */
export function toPuppeteerCookies(cookies) {
  return cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '',
    path: c.path || '/',
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: c.sameSite || 'Lax',
    expires: c.expires || -1,
  }));
}

/**
 * Convert Playwright context.cookies() output to our storage format.
 *
 * @param {Array} playwrightCookies - Cookies from page.context().cookies()
 * @returns {Array} Normalized cookie objects for storage
 */
export function fromPlaywrightCookies(playwrightCookies) {
  return playwrightCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    expires: c.expires,
  }));
}
