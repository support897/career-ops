/**
 * db-writer.mjs — Write scan results to Neon DB for multi-user scanning.
 *
 * When --userId is provided, scan.mjs writes results to the database
 * instead of (or in addition to) local files. This enables per-user
 * job tracking in the web app.
 *
 * Usage:
 *   import { writeJobs, updateJobStatus } from './lib/db-writer.mjs';
 *   await writeJobs(userId, scannedJobs);
 */

import pg from 'pg';

const { Pool } = pg;

let _pool = null;

function getPool() {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set for db-writer');
    _pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  }
  return _pool;
}

/**
 * Write scanned jobs to the jobs table for a specific user.
 * Skips duplicates (same URL + userId).
 *
 * @param {string} userId - The Clerk user ID
 * @param {Array<Object>} jobs - Array of job objects from scanner
 * @returns {number} Number of jobs actually inserted
 */
export async function writeJobs(userId, jobs) {
  const pool = getPool();
  let inserted = 0;

  for (const job of jobs) {
    try {
      // Skip duplicates
      const existing = await pool.query(
        'SELECT id FROM jobs WHERE user_id = $1 AND url = $2 LIMIT 1',
        [userId, job.url]
      );
      if (existing.rows.length > 0) continue;

      await pool.query(
        `INSERT INTO jobs (id, user_id, title, company, url, platform, location,
                           employment_type, salary, score, match_reasons, tags,
                           status, description, company_email, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())`,
        [
          crypto.randomUUID(),
          userId,
          job.title || 'Unknown Title',
          job.company || 'Unknown Company',
          job.url,
          job.platform || job.portal || 'unknown',
          job.location || null,
          job.employmentType || job.type || null,
          job.salary || null,
          job.score || null,
          job.matchReasons || null,
          job.tags || null,
          'pending',
          job.description || null,
          job.companyEmail || null,
        ]
      );
      inserted++;
    } catch (err) {
      // Log but don't fail — one bad job shouldn't stop the scan
      console.error(`[db-writer] Failed to insert job "${job.title}" at "${job.company}": ${err.message}`);
    }
  }

  return inserted;
}

/**
 * Update a job's status (e.g., 'applied', 'auto-applied', 'rejected').
 */
export async function updateJobStatus(jobId, status) {
  const pool = getPool();
  await pool.query(
    'UPDATE jobs SET status = $1 WHERE id = $2',
    [status, jobId]
  );
}

/**
 * Write an application record to the applications table.
 */
export async function writeApplication(userId, jobId, applicationData) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO applications (id, user_id, job_id, resume_url, cover_letter,
                               email_body, email_subject, status, resume_html, applied_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (user_id, job_id) DO UPDATE SET
       resume_url = EXCLUDED.resume_url,
       cover_letter = EXCLUDED.cover_letter,
       email_body = EXCLUDED.email_body,
       email_subject = EXCLUDED.email_subject,
       status = EXCLUDED.status,
       resume_html = EXCLUDED.resume_html,
       applied_at = EXCLUDED.applied_at`,
    [
      crypto.randomUUID(),
      userId,
      jobId,
      applicationData.resumeUrl || null,
      applicationData.coverLetter || null,
      applicationData.emailBody || null,
      applicationData.emailSubject || null,
      applicationData.status || 'draft',
      applicationData.resumeHtml || null,
    ]
  );
}

/**
 * Save encrypted cookies for a user + platform.
 * Stores the encrypted payload and updates cookie status/expiry.
 */
export async function saveUserCookies(userId, platform, encryptedCookies, exportedAt) {
  const pool = getPool();
  await pool.query(
    `UPDATE platform_settings
     SET cookies_encrypted = $3, cookies_exported_at = $4, cookie_status = 'active',
         cookie_expiry = $4 + INTERVAL '30 days', last_sync = NOW()
     WHERE user_id = $1 AND platform = $2`,
    [userId, platform, encryptedCookies, exportedAt || new Date()]
  );
}

/**
 * Update a job's score and match reasons.
 */
export async function updateJobScore(jobId, score, matchReasons) {
  const pool = getPool();
  await pool.query(
    'UPDATE jobs SET score = $1, match_reasons = $2 WHERE id = $3',
    [score, matchReasons || null, jobId]
  );
}

/**
 * Update scan schedule's last_run timestamp.
 */
export async function updateScanScheduleRun(scheduleId) {
  const pool = getPool();
  await pool.query(
    'UPDATE scan_schedules SET last_run = NOW() WHERE id = $1',
    [scheduleId]
  );
}

/**
 * Close the database pool. Call when done writing.
 */
export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
