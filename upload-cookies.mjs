#!/usr/bin/env node

/**
 * upload-cookies.mjs — Read existing cookies from config/indeed.yml + config/seek.yml,
 * encrypt with AES-256-GCM, and save to database platform_settings table.
 *
 * Usage: node upload-cookies.mjs
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { encryptCookies } from './lib/cookie-crypto.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USER_ID = 'user_3GfaXsz2WyxzFl0LcD4ktVnNsCS';

async function saveToDb(platform, encryptedCookies) {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    const rowId = `${USER_ID}-${platform}`;
    const result = await pool.query(
      `UPDATE platform_settings
       SET cookies_encrypted = $3, cookies_exported_at = NOW(), cookie_status = 'active'
       WHERE user_id = $1 AND platform = $2`,
      [USER_ID, platform, encryptedCookies]
    );
    if (result.rowCount === 0) {
      await pool.query(
        `INSERT INTO platform_settings (id, user_id, platform, enabled, cookies_encrypted, cookies_exported_at, cookie_status)
         VALUES ($1, $2, $3, true, $4, NOW(), 'active')`,
        [rowId, USER_ID, platform, encryptedCookies]
      );
    }
    console.log(`  ✅ ${platform} cookies saved to DB (encrypted, private)`);
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log('🔐 Uploading existing cookies to DB (AES-256-GCM encrypted, private)\n');

  for (const platform of ['indeed', 'seek']) {
    const ymlPath = join(__dirname, `config/${platform}.yml`);
    if (!existsSync(ymlPath)) {
      console.log(`  ⏭️  ${platform}: no config file found`);
      continue;
    }

    const raw = readFileSync(ymlPath, 'utf8');
    const data = yaml.parse(raw);
    const cookies = data?.[platform]?.cookies;

    if (!cookies || cookies.length === 0) {
      console.log(`  ⏭️  ${platform}: no cookies in config`);
      continue;
    }

    console.log(`  📦 ${platform}: ${cookies.length} cookies found (exported ${data[platform].exportedAt})`);

    // Normalize to storage format
    const normalized = cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '',
      path: c.path || '/',
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
      sameSite: c.sameSite || 'Lax',
      expires: c.expires || -1,
    }));

    const encrypted = encryptCookies(USER_ID, normalized);
    if (!encrypted) {
      console.log(`  ❌ ${platform}: encryption failed`);
      continue;
    }

    console.log(`  🔒 ${platform}: encrypted (${encrypted.length} chars)`);
    await saveToDb(platform, encrypted);
  }

  console.log('\n✅ Done. Cookies are encrypted with your per-user key — only you can decrypt them.');
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
