/**
 * lambda/index.mjs — AWS Lambda handler for Careerflow scanning & applying.
 *
 * Receives events from Vercel Cron or direct API calls.
 * Supported actions:
 *   - scan:  runs scan.mjs --userId
 *   - apply: runs auto-apply.mjs --userId
 *   - scheduled: scans all active users (for EventBridge/cron)
 *
 * Environment variables required:
 *   DATABASE_URL — Neon DB connection string
 *   CAREER_OPS_PORTALS — path to portals.yml (default: /var/task/portals.yml)
 *   CRON_SECRET — Shared secret for cron authentication
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, writeFileSync, mkdirSync, symlinkSync, cpSync, readdirSync, statSync } from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

const TASK_DIR = process.env.LAMBDA_TASK_ROOT || '/var/task';
const WORK_DIR = '/tmp/career-ops';

// Neon PostgreSQL connection
let sql = null;

async function getSql() {
  if (!sql) {
    const { neon } = await import('@neondatabase/serverless');
    sql = neon(process.env.DATABASE_URL);
  }
  return sql;
}

// Copy pipeline scripts to writable /tmp so __dirname works for output/ writes
function prepareWorkDir() {
  if (existsSync(WORK_DIR + '/auto-apply.mjs')) return; // Already prepared for this warm container
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(WORK_DIR + '/output', { recursive: true });
  
  // Copy only .mjs files (scripts, not node_modules)
  for (const entry of readdirSync(TASK_DIR)) {
    const src = path.join(TASK_DIR, entry);
    const dst = path.join(WORK_DIR, entry);
    try {
      if (entry.endsWith('.mjs') || entry.endsWith('.json') || entry === 'portals.yml') {
        cpSync(src, dst, { force: true });
      }
    } catch {}
  }
  
  // Symlink directories (read-only in source, accessed via symlink)
  // data/ must be COPIED (not symlinked) because scan.mjs writes pipeline.md to it
  for (const dir of ['lib', 'providers', 'plugins', 'config', 'modes', 'templates', 'node_modules']) {
    const src = path.join(TASK_DIR, dir);
    const dst = path.join(WORK_DIR, dir);
    try {
      if (existsSync(src) && !existsSync(dst)) {
        symlinkSync(src, dst, 'dir');
      }
    } catch {}
  }
  // data/ needs to be writable — copy it
  const dataSrc = path.join(TASK_DIR, 'data');
  const dataDst = path.join(WORK_DIR, 'data');
  try {
    if (existsSync(dataSrc) && !existsSync(dataDst)) {
      cpSync(dataSrc, dataDst, { recursive: true });
    }
  } catch {}
}

// Validate cron authentication
function validateCronAuth(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error('[Lambda] CRON_SECRET not configured');
    return false;
  }

  // Check Bearer token
  if (authHeader === `Bearer ${cronSecret}`) return true;

  // Check x-vercel-cron header
  const vercelCron = event.headers?.['x-vercel-cron'];
  if (vercelCron) return true;

  return false;
}

// Scheduled scanning: scan users who are DUE based on their per-user settings
async function scheduledScan() {
  console.log('[Lambda] Starting scheduled scan — checking per-user schedules');
  const sql = await getSql();

  try {
    // Query only users whose schedule is due right now
    // Two modes:
    //   scan_mode = 'interval'  → check last_scan_at + frequency <= NOW()
    //   scan_mode = 'schedule'  → check current DOW + hour match preferred_days/hours
    const users = await sql`
      SELECT user_id, scan_mode, scan_frequency_hours, preferred_days, preferred_hours,
             timezone, platforms, keywords, location_filter, last_scan_at
      FROM user_profiles
      WHERE scanning_enabled = true
        AND (
          -- Interval mode: enough time has passed since last scan
          (scan_mode = 'interval'
           AND (last_scan_at IS NULL
                OR last_scan_at + (scan_frequency_hours || ' hours')::interval <= NOW()))
          OR
          -- Schedule mode: current day-of-week and hour match user preferences
          (scan_mode = 'schedule'
           AND EXTRACT(DOW FROM NOW() AT TIME ZONE COALESCE(timezone, 'UTC'))::int = ANY(preferred_days)
           AND EXTRACT(HOUR FROM NOW() AT TIME ZONE COALESCE(timezone, 'UTC'))::int = ANY(preferred_hours)
           AND (last_scan_at IS NULL OR last_scan_at < NOW() - INTERVAL '55 minutes'))
        )
    `;

    if (users.length === 0) {
      console.log('[Lambda] No users due for scanning right now');
      return {
        success: true,
        message: 'No users due',
        scannedUsers: 0,
      };
    }

    console.log(`[Lambda] ${users.length} user(s) due for scanning`);

    prepareWorkDir();
    const results = [];
    const errors = [];

    for (const user of users) {
      try {
        console.log(`[Lambda] Scanning user: ${user.user_id} (mode: ${user.scan_mode})`);

        // Build scan arguments
        const args = ['scan.mjs', '--userId', user.user_id];

        // Add platform filters if specified
        if (user.platforms && user.platforms.length > 0) {
          args.push('--ats', user.platforms.join(','));
        }

        // Add location filter if specified
        if (user.location_filter && user.location_filter.length > 0) {
          args.push('--location', user.location_filter[0]);
        }

        const { stdout, stderr } = await execFileAsync('node', args, {
          cwd: WORK_DIR,
          env: {
            ...process.env,
            NODE_PATH: TASK_DIR + '/node_modules',
            NODE_OPTIONS: '--max-old-space-size=1536',
          },
          timeout: 240000, // 4 minutes per user
          maxBuffer: 10 * 1024 * 1024,
        });

        // Parse results
        const newOffersMatch = stdout.match(/New offers added:\s+(\d+)/);
        const newOffers = newOffersMatch ? parseInt(newOffersMatch[1], 10) : 0;

        const totalFoundMatch = stdout.match(/Total found:\s+(\d+)/);
        const totalFound = totalFoundMatch ? parseInt(totalFoundMatch[1], 10) : 0;

        // Update last_scan_at in database
        await sql`
          UPDATE user_profiles SET last_scan_at = NOW(), updated_at = NOW()
          WHERE user_id = ${user.user_id}
        `;

        results.push({
          userId: user.user_id,
          success: true,
          newOffers,
          totalFound,
        });

        console.log(`[Lambda] User ${user.user_id}: ${newOffers} new offers`);

      } catch (error) {
        console.error(`[Lambda] Error scanning user ${user.user_id}:`, error.message);
        errors.push({
          userId: user.user_id,
          error: error.message,
        });
      }
    }

    // Log scan run
    const totalNewOffers = results.reduce((sum, r) => sum + (r.newOffers || 0), 0);
    await sql`
      INSERT INTO scan_runs (user_id, started_at, completed_at, users_scanned, new_offers, total_offers, errors)
      VALUES ('system', NOW(), NOW(), ${users.length}, ${totalNewOffers}, ${results.length}, ${errors.length})
    `;

    console.log(`[Lambda] Scheduled scan complete. Scanned: ${results.length}, New offers: ${totalNewOffers}, Errors: ${errors.length}`);

    return {
      success: true,
      scannedUsers: results.length,
      totalNewOffers,
      errors: errors.length,
      results,
    };

  } catch (error) {
    console.error('[Lambda] Scheduled scan error:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

// Single user scan
async function scanUser(userId, options = {}) {
  console.log(`[Lambda] Scanning user: ${userId}`);
  prepareWorkDir();

  const args = ['scan.mjs', '--userId', userId];

  // Add optional filters
  if (options.platforms) {
    args.push('--ats', options.platforms.join(','));
  }
  if (options.keywords) {
    args.push('--keywords', options.keywords.join(','));
  }
  if (options.location) {
    args.push('--location', options.location);
  }

  const { stdout, stderr } = await execFileAsync('node', args, {
    cwd: WORK_DIR,
    env: {
      ...process.env,
      NODE_PATH: TASK_DIR + '/node_modules',
      NODE_OPTIONS: '--max-old-space-size=1536',
    },
    timeout: 240000,
    maxBuffer: 10 * 1024 * 1024,
  });

  console.log('[Lambda] Output:', stdout);
  if (stderr) {
    console.log('[Lambda] Stderr:', stderr);
  }

  // Parse results
  const newOffersMatch = stdout.match(/New offers added:\s+(\d+)/);
  const newOffers = newOffersMatch ? parseInt(newOffersMatch[1], 10) : 0;

  const totalFoundMatch = stdout.match(/Total found:\s+(\d+)/);
  const totalFound = totalFoundMatch ? parseInt(totalFoundMatch[1], 10) : 0;

  return {
    success: true,
    userId,
    action: 'scan',
    newOffers,
    totalFound,
    message: `Scan complete. ${newOffers} new jobs found.`,
    output: stdout,
  };
}

// Single user apply
async function applyUser(userId) {
  console.log(`[Lambda] Applying for user: ${userId}`);
  prepareWorkDir();

  const args = ['auto-apply.mjs', '--userId', userId];

  const { stdout, stderr } = await execFileAsync('node', args, {
    cwd: WORK_DIR,
    env: {
      ...process.env,
      NODE_PATH: TASK_DIR + '/node_modules',
      NODE_OPTIONS: '--max-old-space-size=1536',
    },
    timeout: 300000, // 5 minutes for apply
    maxBuffer: 10 * 1024 * 1024,
  });

  console.log('[Lambda] Output:', stdout);
  if (stderr) {
    console.log('[Lambda] Stderr:', stderr);
  }

  // Parse results
  const appliedMatch = stdout.match(/Applied:\s+(\d+)/);
  const applied = appliedMatch ? parseInt(appliedMatch[1], 10) : 0;

  return {
    success: true,
    userId,
    action: 'apply',
    applied,
    message: `Apply pipeline complete. ${applied} applications processed.`,
    output: stdout,
  };
}

export const handler = async (event) => {
  console.log('[Lambda] Event received:', JSON.stringify(event, null, 2));

  try {
    // Parse the event body
    const body = event.body
      ? (typeof event.body === 'string' ? JSON.parse(event.body) : event.body)
      : event;

    const { userId, action = 'scan', platforms, keywords, location, maxResults } = body;

    // Handle scheduled scanning (from Vercel Cron or EventBridge)
    if (action === 'scheduled') {
      // Validate cron authentication
      if (!validateCronAuth(event)) {
        return {
          statusCode: 401,
          body: JSON.stringify({ error: 'unauthorized' }),
        };
      }
      return await scheduledScan();
    }

    // Handle single user operations
    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'userId is required' }),
      };
    }

    if (action === 'apply') {
      return await applyUser(userId);
    }

    return await scanUser(userId, { platforms, keywords, location });

  } catch (error) {
    console.error('[Lambda] Error:', error.message);

    // Check if it's a timeout
    if (error.killed && error.signal === 'SIGTERM') {
      return {
        statusCode: 504,
        body: JSON.stringify({
          error: 'Pipeline timed out',
          message: 'The operation took too long. Try fewer platforms or run locally.',
        }),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Operation failed',
        message: error.message,
      }),
    };
  }
};
