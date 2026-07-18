/**
 * save-cookies-to-db.mjs — Capture cookies from a Puppeteer session, encrypt, and save to DB.
 *
 * This script opens a visible browser window for the user to log in manually.
 * After login, it captures all cookies, encrypts them with AES-256-GCM, and
 * stores them in the platform_settings table for the specified user.
 *
 * Usage:
 *   node save-cookies-to-db.mjs --platform linkedin --userId <clerk_user_id>
 *   node save-cookies-to-db.mjs --platform indeed --userId <clerk_user_id>
 *   node save-cookies-to-db.mjs --platform seek --userId <clerk_user_id>
 *
 * Cookie domains:
 *   linkedin → .linkedin.com (login at linkedin.com/login)
 *   indeed   → .indeed.com   (login at indeed.com)
 *   seek     → .seek.com.au  (login at seek.com.au)
 */

import { parseArgs } from 'util';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const { values } = parseArgs({
  options: {
    platform: { type: 'string' },
    userId:   { type: 'string' },
  },
});

const platform = values.platform;
const userId   = values.userId;

if (!platform || !userId) {
  console.error('Usage: node save-cookies-to-db.mjs --platform <linkedin|indeed|seek> --userId <clerk_user_id>');
  process.exit(1);
}

const PLATFORM_CONFIG = {
  linkedin: {
    loginUrl: 'https://www.linkedin.com/login',
    cookieDomain: '.linkedin.com',
  },
  indeed: {
    loginUrl: 'https://au.indeed.com/account/login',
    cookieDomain: '.indeed.com',
  },
  seek: {
    loginUrl: 'https://www.seek.com.au/oauth/login',
    cookieDomain: '.seek.com.au',
  },
};

const config = PLATFORM_CONFIG[platform];
if (!config) {
  console.error(`Unknown platform: ${platform}. Supported: linkedin, indeed, seek`);
  process.exit(1);
}

console.log(`\n🔐 ${platform.toUpperCase()} Cookie Capture`);
console.log(`   User: ${userId}`);
console.log(`   Login URL: ${config.loginUrl}`);
console.log(`\nA browser window will open. Log in manually, then press Enter in this terminal.\n`);

const browser = await puppeteer.launch({
  headless: false,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  userDataDir: `/tmp/cookie-capture-${platform}-${userId.slice(-8)}`,
  args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
});

const page = await browser.newPage();
await page.goto(config.loginUrl, { waitUntil: 'networkidle2' });

// Wait for user to log in (press Enter in terminal)
await new Promise(resolve => {
  process.stdout.write('\n✅ Logged in? Press Enter here to capture cookies: ');
  process.stdin.once('data', resolve);
});

// Capture all cookies for this domain
const allCookies = await page.cookies();
const platformCookies = allCookies.filter(c =>
  c.domain.includes(config.cookieDomain.replace(/^\./, ''))
);

console.log(`\n📸 Captured ${platformCookies.length} cookies for ${platform}`);

if (platformCookies.length === 0) {
  console.error('❌ No cookies captured. Did you log in successfully?');
  await browser.close();
  process.exit(1);
}

// Encrypt and save to DB
try {
  const { encryptCookies } = await import('./lib/cookie-crypto.mjs');
  const pg = (await import('pg')).default;
  const { Pool } = pg;

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const encrypted = encryptCookies(userId, platformCookies);
  if (!encrypted) throw new Error('Encryption returned null');

  const now = new Date();
  await pool.query(
    `UPDATE platform_settings
     SET cookies_encrypted = $3, cookies_exported_at = $4, cookie_status = 'active',
         cookie_expiry = $4 + INTERVAL '30 days', last_sync = NOW()
     WHERE user_id = $1 AND platform = $2`,
    [userId, platform, encrypted, now]
  );

  console.log(`\n✅ ${platformCookies.length} cookies encrypted and saved to DB for user ${userId.slice(0, 12)}...`);
  console.log(`   Cookie expiry: ${new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}`);
  console.log(`   Encryption: AES-256-GCM with per-user derived key`);

  await pool.end();
} catch (e) {
  console.error(`\n❌ DB save failed: ${e.message}`);
  console.error('Cookies were captured but not saved. Check DATABASE_URL and ENCRYPTION_KEY.');
}

await browser.close();
console.log('\nDone. Browser closed.');
