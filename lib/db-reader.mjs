/**
 * db-reader.mjs — Read user config from Neon DB for multi-user scanning.
 *
 * When --userId is provided, scan.mjs reads preferences from the database
 * instead of local YAML files. This enables per-user scanning isolation.
 *
 * Usage:
 *   import { getUserProfile, getUserScanConfig, getUserCredentials } from './lib/db-reader.mjs';
 *   const profile = await getUserProfile(userId);
 *   const scanConfig = await getUserScanConfig(userId);
 */

import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

let _pool = null;

function getPool() {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set for db-reader');
    _pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  }
  return _pool;
}

/**
 * Read user profile from the profiles table.
 * Returns target roles, salary range, location, employment type, etc.
 */
export async function getUserProfile(userId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT full_name, phone, location, country, target_roles, job_type,
            employment_type, salary_min, salary_max, resume_url, resume_name,
            linkedin_url, portfolio_url
     FROM profiles WHERE id = $1`,
    [userId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    fullName: row.full_name,
    phone: row.phone,
    location: row.location,
    country: row.country,
    targetRoles: row.target_roles || [],
    jobType: row.job_type || ['remote'],
    employmentType: row.employment_type || ['contract'],
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    resumeUrl: row.resume_url,
    resumeName: row.resume_name,
    linkedinUrl: row.linkedin_url,
    portfolioUrl: row.portfolio_url,
  };
}

/**
 * Read user's enabled scan schedules.
 * Returns array of schedule configs with platforms, keywords, etc.
 */
export async function getUserScanSchedules(userId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, name, enabled, frequency, interval_value, time_of_day,
            day_of_week, platforms, keywords, location, exclude_keywords,
            max_results, last_run, next_run
     FROM scan_schedules WHERE user_id = $1 AND enabled = true
     ORDER BY created_at ASC`,
    [userId]
  );
  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    frequency: row.frequency,
    intervalValue: row.interval_value,
    timeOfDay: row.time_of_day,
    dayOfWeek: row.day_of_week,
    platforms: row.platforms || [],
    keywords: row.keywords || '',
    location: row.location || '',
    excludeKeywords: row.exclude_keywords || '',
    maxResults: row.max_results || 50,
    lastRun: row.last_run,
    nextRun: row.next_run,
  }));
}

/**
 * Read user's platform settings (enabled platforms, cookie status, credentials).
 */
export async function getUserPlatformSettings(userId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT platform, enabled, auto_apply, cookie_status, cookie_expiry, last_sync
     FROM platform_settings WHERE user_id = $1`,
    [userId]
  );
  return result.rows.map(row => ({
    platform: row.platform,
    enabled: row.enabled,
    autoApply: row.auto_apply,
    cookieStatus: row.cookie_status,
    cookieExpiry: row.cookie_expiry,
    lastSync: row.last_sync,
  }));
}

/**
 * Read encrypted cookies for a specific user + platform.
 * Returns the encrypted payload (decrypt with cookie-crypto).
 */
export async function getUserCookies(userId, platform) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT cookies_encrypted, cookies_exported_at, cookie_status, cookie_expiry
     FROM platform_settings WHERE user_id = $1 AND platform = $2`,
    [userId, platform]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    encrypted: row.cookies_encrypted,
    exportedAt: row.cookies_exported_at,
    status: row.cookie_status,
    expiry: row.cookie_expiry,
  };
}

/**
 * Build a portals.yml-compatible config object from DB user preferences.
 * This transforms the DB profile + scan schedules into the format scan.mjs expects.
 */
export async function buildScanConfigFromDB(userId) {
  const [profile, schedules, platforms] = await Promise.all([
    getUserProfile(userId),
    getUserScanSchedules(userId),
    getUserPlatformSettings(userId),
  ]);

  if (!profile) {
    throw new Error(`No profile found for user ${userId}. Run onboarding first.`);
  }

  // Build title_filter from target roles
  const titleFilter = {
    positive: profile.targetRoles || [],
    negative: [],
  };

  // Build location_filter from profile location
  const locationFilter = {
    positive: profile.location ? [profile.location] : [],
    negative: [],
  };

  // Build salary_filter from profile salary range
  let salaryFilter = null;
  if (profile.salaryMin || profile.salaryMax) {
    salaryFilter = {
      min: profile.salaryMin || 0,
      max: profile.salaryMax || 999999,
    };
  }

  // Collect enabled platforms from schedules
  const enabledPlatforms = new Set();
  for (const schedule of schedules) {
    for (const p of (schedule.platforms || [])) {
      enabledPlatforms.add(p);
    }
  }

  // If no schedules or no platforms specified, enable all configured platforms
  if (enabledPlatforms.size === 0) {
    for (const p of platforms) {
      if (p.enabled) enabledPlatforms.add(p.platform);
    }
  }

  return {
    profile,
    schedules,
    platforms,
    titleFilter,
    locationFilter,
    salaryFilter,
    enabledPlatforms: [...enabledPlatforms],
  };
}

/**
 * Read a job by ID for a specific user.
 */
export async function getUserJob(userId, jobId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, user_id, title, company, url, platform, location,
            employment_type, salary, score, status, description,
            company_email, match_reasons, tags, cover_letter,
            email_body, email_subject, posted_at
     FROM jobs WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    company: row.company,
    url: row.url,
    platform: row.platform,
    location: row.location,
    employmentType: row.employment_type,
    salary: row.salary,
    score: row.score,
    status: row.status,
    description: row.description,
    companyEmail: row.company_email,
    matchReasons: row.match_reasons || [],
    tags: row.tags || [],
    coverLetter: row.cover_letter,
    emailBody: row.email_body,
    emailSubject: row.email_subject,
    postedAt: row.posted_at,
  };
}

/**
 * Get pending jobs for a user (status = 'pending').
 */
export async function getUserPendingJobs(userId, limit = 10) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, user_id, title, company, url, platform, location,
            employment_type, salary, score, status, description,
            company_email, match_reasons, tags
     FROM jobs WHERE user_id = $1 AND status = 'pending'
     ORDER BY score DESC NULLS LAST, created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    title: row.title,
    company: row.company,
    url: row.url,
    platform: row.platform,
    location: row.location,
    employmentType: row.employment_type,
    salary: row.salary,
    score: row.score,
    status: row.status,
    description: row.description,
    companyEmail: row.company_email,
    matchReasons: row.match_reasons || [],
    tags: row.tags || [],
  }));
}

/**
 * Get user's auto-apply setting.
 */
export async function getUserAutoApplySetting(userId) {
  const pool = getPool();
  const result = await pool.query(
    'SELECT auto_apply_enabled FROM users WHERE id = $1',
    [userId]
  );
  if (result.rows.length === 0) return false;
  return result.rows[0].auto_apply_enabled === true;
}

/**
 * Check if a user is VIP.
 */
export async function getUserVipStatus(userId) {
  const pool = getPool();
  const result = await pool.query(
    'SELECT vip FROM users WHERE id = $1',
    [userId]
  );
  if (result.rows.length === 0) return false;
  return result.rows[0].vip === true;
}

/**
 * Get user email settings (for VIP email automation).
 * Returns encrypted password — caller must decrypt.
 */
export async function getUserEmailSettings(userId) {
  const pool = getPool();
  const result = await pool.query(
    'SELECT email_address, email_app_password FROM users WHERE id = $1',
    [userId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    emailAddress: row.email_address || null,
    encryptedAppPassword: row.email_app_password || null,
  };
}

/**
 * Decrypt an AES-256-GCM encrypted password.
 */
export function decryptPassword(userId, payload) {
  const ALGORITHM = 'aes-256-gcm';
  const KEY_LENGTH = 32;
  const IV_LENGTH = 16;
  const TAG_LENGTH = 16;
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'e6372655010edff3b49a51385cc08e23f3e4126616e11f0963a7711c5a402503';
  try {
    const masterKey = crypto.pbkdf2Sync(ENCRYPTION_KEY, 'career-ops-salt', 100000, KEY_LENGTH, 'sha512');
    const key = crypto.pbkdf2Sync(masterKey, userId, 100000, KEY_LENGTH, 'sha512');
    const data = Buffer.from(payload, 'base64');
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Close the database pool. Call when done scanning.
 */
export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
