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
import yaml from 'js-yaml';
import { encryptCookies } from './lib/cookie-crypto.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually to populate process.env
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  const envText = readFileSync(envPath, 'utf8');
  for (const line of envText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('=');
    const key = parts[0].trim();
    const val = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
    process.env[key] = val;
  }
}

const USER_ID = 'user_3GfaXsz2WyxzFl0LcD4ktVnNsCS';

async function saveToDb(platform, encryptedCookies) {
  const pg = await import('pg');
  const { Pool } = pg.default || pg;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = async (strings, ...values) => {
    const query = strings.reduce((prev, curr, i) => prev + '$' + i + curr);
    const res = await pool.query(query, values);
    return res.rows;
  };
  
  const rowId = `${USER_ID}-${platform}`;
  
  const updateResult = await sql(
    `UPDATE platform_settings
     SET cookies_encrypted = $3, cookies_exported_at = NOW(), cookie_status = 'active'
     WHERE user_id = $1 AND platform = $2
     RETURNING id`,
    [USER_ID, platform, encryptedCookies]
  );
  
  if (!updateResult || updateResult.length === 0) {
    await sql(
      `INSERT INTO platform_settings (id, user_id, platform, enabled, cookies_encrypted, cookies_exported_at, cookie_status)
       VALUES ($1, $2, $3, true, $4, NOW(), 'active')`,
      [rowId, USER_ID, platform, encryptedCookies]
    );
  }
  console.log(`  ✅ ${platform} cookies saved to DB (encrypted, private)`);
}

async function main() {
  console.log('🔐 Uploading existing cookies to DB (AES-256-GCM encrypted, private)\n');

  for (const platform of ['indeed', 'seek', 'linkedin']) {
    const ymlPath = join(__dirname, `config/${platform}.yml`);
    if (!existsSync(ymlPath)) {
      console.log(`  ⏭️  ${platform}: no config file found`);
      continue;
    }

    const raw = readFileSync(ymlPath, 'utf8');
    const data = yaml.load(raw);
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
