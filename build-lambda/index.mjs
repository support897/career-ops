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
    const users = await sql`
      SELECT user_id, scan_mode, scan_frequency_hours, preferred_days, preferred_hours,
             timezone, platforms, keywords, location_filter, last_scan_at,
             is_vip, score_threshold
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
          OR
          -- VIP users always get hourly checks
          (is_vip = true
           AND (last_scan_at IS NULL OR last_scan_at < NOW() - INTERVAL '55 minutes'))
        )
    `;

    if (users.length === 0) {
      console.log('[Lambda] No users due for scanning right now');
      return { success: true, message: 'No users due', scannedUsers: 0 };
    }

    console.log(`[Lambda] ${users.length} user(s) due for scanning`);

    prepareWorkDir();
    const results = [];
    const errors = [];

    for (const user of users) {
      try {
        console.log(`[Lambda] Scanning user: ${user.user_id} (mode: ${user.scan_mode}, vip: ${user.is_vip})`);

        // Build scan arguments
        const args = ['scan.mjs', '--userId', user.user_id, '--db'];

        if (user.platforms && user.platforms.length > 0) args.push('--ats', user.platforms.join(','));
        if (user.keywords && user.keywords.length > 0) args.push('--keywords', user.keywords.join(','));
        if (user.location_filter && user.location_filter.length > 0) args.push('--location', user.location_filter[0]);

        const { stdout } = await execFileAsync('node', args, {
          cwd: WORK_DIR,
          env: { ...process.env, NODE_PATH: TASK_DIR + '/node_modules', NODE_OPTIONS: '--max-old-space-size=1536', CAREER_OPS_USER_ID: user.user_id },
          timeout: 240000,
          maxBuffer: 10 * 1024 * 1024,
        });

        const newOffersMatch = stdout.match(/New offers added:\s+(\d+)/);
        const newOffers = newOffersMatch ? parseInt(newOffersMatch[1], 10) : 0;
        const totalFoundMatch = stdout.match(/Total found:\s+(\d+)/);
        const totalFound = totalFoundMatch ? parseInt(totalFoundMatch[1], 10) : 0;

        let applied = 0;
        try {
          console.log(`[Lambda] Running evaluation pipeline (auto-apply) for user: ${user.user_id}...`);
          const { stdout: applyStdout } = await execFileAsync('node', ['auto-apply.mjs', '--userId', user.user_id], {
            cwd: WORK_DIR,
            env: {
              ...process.env,
              NODE_PATH: TASK_DIR + '/node_modules',
              NODE_OPTIONS: '--max-old-space-size=1536',
            },
            timeout: 600000, // 10 minutes for auto-apply
            maxBuffer: 10 * 1024 * 1024,
          });
          const appliedMatch = applyStdout.match(/Applied:\s+(\d+)/);
          applied = appliedMatch ? parseInt(appliedMatch[1], 10) : 0;
          console.log(`[Lambda] Evaluation pipeline complete for user ${user.user_id}`);
        } catch (applyErr) {
          console.error(`[Lambda] Evaluation pipeline failed for ${user.user_id}:`, applyErr.message);
        }

        results.push({
          userId: user.user_id,
          success: true,
          newOffers,
          totalFound,
          applied,
        });

        console.log(`[Lambda] User ${user.user_id}: ${newOffers} new offers, ${applied} drafts created`);

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
    const totalApplied = results.reduce((sum, r) => sum + (r.applied || 0), 0);
    await sql`
      INSERT INTO scan_runs (user_id, started_at, completed_at, users_scanned, new_offers, total_offers, errors)
      VALUES ('system', NOW(), NOW(), ${users.length}, ${totalNewOffers}, ${results.length}, ${errors.length})
    `;

    console.log(`[Lambda] Scheduled scan complete. Scanned: ${results.length}, New offers: ${totalNewOffers}, Gmail drafts: ${totalApplied}, Errors: ${errors.length}`);

    return {
      success: true,
      scannedUsers: results.length,
      totalNewOffers,
      totalApplied,
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

// Daily digest email — sends ONE branded email per day to VIP user
async function sendDailyDigest() {
  console.log('[Lambda] Starting daily digest');
  const sql = await getSql();
  const VIP_USER_ID = 'user_3GfaXsz2WyxzFl0LcD4ktVnNsCS';

  try {
    // Time guard: only send after 4pm Brisbane
    const now = new Date();
    const brisbaneHour = parseInt(now.toLocaleString('en-US', { timeZone: 'Australia/Brisbane', hour: 'numeric', hour12: false }));
    if (brisbaneHour < 16) {
      console.log(`[Lambda] Daily digest: too early (${brisbaneHour}:00 Brisbane), waits until 16:00`);
      return { success: true, message: 'Too early, waits until 4pm Brisbane' };
    }

    // Check VIP
    const [userCheck] = await sql`SELECT vip FROM users WHERE id = ${VIP_USER_ID}`;
    if (!userCheck?.vip) {
      console.log('[Lambda] Daily digest: user is not VIP, skipping');
      return { success: true, message: 'Not VIP' };
    }

    // Claim today's slot atomically (exactly 1 email/day)
    const [claimed] = await sql`INSERT INTO daily_digest_log (sent_date) VALUES (CURRENT_DATE) ON CONFLICT (sent_date) DO NOTHING RETURNING id`;
    if (!claimed) {
      console.log('[Lambda] Daily digest: already sent today, skipping');
      return { success: true, message: 'Already sent today' };
    }

    // Query all data
    const [scansToday, portals, scoredToday, coverLettersToday] = await Promise.all([
      sql`SELECT title, company, platform, location, url FROM jobs WHERE user_id = ${VIP_USER_ID} AND created_at::date = CURRENT_DATE ORDER BY created_at DESC LIMIT 10`,
      sql`SELECT platform, COUNT(*)::int as cnt FROM jobs WHERE user_id = ${VIP_USER_ID} AND created_at::date = CURRENT_DATE GROUP BY platform ORDER BY cnt DESC`,
      sql`SELECT title, company, score, url FROM jobs WHERE user_id = ${VIP_USER_ID} AND created_at::date = CURRENT_DATE AND score IS NOT NULL ORDER BY score DESC LIMIT 5`,
      sql`SELECT COUNT(*)::int as cnt FROM jobs WHERE user_id = ${VIP_USER_ID} AND created_at::date = CURRENT_DATE AND cover_letter IS NOT NULL`,
    ]);

    const [totalScansToday] = await sql`SELECT COUNT(*)::int as cnt FROM jobs WHERE user_id = ${VIP_USER_ID} AND created_at::date = CURRENT_DATE`;

    // Pipeline status counts
    const pipelineRows = await sql`SELECT status, COUNT(*)::int as cnt FROM applications WHERE user_id = ${VIP_USER_ID} GROUP BY status`;
    const pipelineStatuses = {};
    let activeCount = 0;
    for (const row of pipelineRows) {
      pipelineStatuses[row.status] = row.cnt;
      if (['Applied', 'Responded', 'Interview', 'Offer'].includes(row.status)) {
        activeCount += row.cnt;
      }
    }

    // Inbox count
    const [inboxRow] = await sql`SELECT COUNT(*)::int as cnt FROM job_inbox WHERE user_id = ${VIP_USER_ID} AND done = false`;

    const totalScanned = totalScansToday?.cnt ?? 0;
    const emailsSent = coverLettersToday[0]?.cnt ?? 0;
    const evaluated = pipelineStatuses['Evaluated'] || 0;

    // Brisbane date string
    const brisbaneStr = now.toLocaleDateString('en-AU', {
      timeZone: 'Australia/Brisbane',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const timeOfDay = brisbaneHour < 12 ? 'morning' : brisbaneHour < 17 ? 'afternoon' : 'evening';

    // Build scan rows HTML
    function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    const scansHtml = scansToday.length > 0
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;">${scansToday.map(j => `
          <tr><td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;">
            <div style="font-size:14px;font-weight:600;color:#1a1a2e;">${esc(j.company)} — ${esc(j.title)}</div>
            <div style="font-size:12px;color:#888;margin-top:3px;">
              📍 ${esc(j.location || 'Remote')} · ${esc(j.platform || 'unknown')}
              ${j.url ? ` · <a href="${esc(j.url)}" style="color:hsl(187,74%,32%);text-decoration:none;">View →</a>` : ''}
            </div>
          </td></tr>`).join('')}</table>`
      : '';

    const portalsHtml = portals.map(p =>
      `<span style="display:inline-block;padding:3px 8px;margin:2px 4px 2px 0;background-color:#f0f0f0;border-radius:4px;font-size:12px;color:#555;">${esc(p.platform)} <strong>${p.cnt}</strong></span>`
    ).join('');

    const pipelineOrder = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected'];
    const pipelineColors = { Evaluated: '#555', Applied: 'hsl(187,74%,32%)', Responded: 'hsl(270,70%,45%)', Interview: 'hsl(26,73%,51%)', Offer: 'hsl(140,50%,35%)', Rejected: '#cc4444' };
    const pipelineCells = pipelineOrder
      .filter(s => (pipelineStatuses[s] || 0) > 0)
      .map(s => `<td style="padding:8px 10px;text-align:center;background-color:#f7f6f3;border-radius:6px;">
        <div style="font-size:20px;font-weight:700;color:${pipelineColors[s] || '#555'};line-height:1;">${pipelineStatuses[s]}</div>
        <div style="font-size:10px;color:#999;margin-top:3px;text-transform:uppercase;letter-spacing:0.5px;">${s}</div>
      </td>`)
      .join('<td width="6"></td>');

    const scoredHtml = scoredToday.length > 0
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${scoredToday.map(j => `
          <tr><td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">
            <div style="font-size:13px;font-weight:600;color:#1a1a2e;">
              ${esc(j.company)} — ${esc(j.title)}
              <span style="display:inline-block;padding:2px 6px;margin-left:6px;background-color:hsl(140,50%,92%);color:hsl(140,50%,30%);border-radius:4px;font-size:11px;font-weight:700;">${esc(j.score)}</span>
            </div>
            ${j.url ? `<div style="font-size:11px;margin-top:2px;"><a href="${esc(j.url)}" style="color:hsl(187,74%,32%);text-decoration:none;">View →</a></div>` : ''}
          </td></tr>`).join('')}</table>`
      : '';

    const preheader = `${totalScanned} new scans · ${activeCount} active apps`;
    const emailsSectionHtml = emailsSent > 0
      ? `<div style="font-size:13px;color:#555;line-height:1.8;">${emailsSent} cover letter${emailsSent > 1 ? 's' : ''} generated today.<br>0 emails sent (cloud scan mode).</div>`
      : '';

    // Load template
    let template;
    try {
      template = readFileSync(join(TASK_DIR, 'templates', 'daily-digest.html'), 'utf-8');
    } catch {
      template = readFileSync('/var/task/templates/daily-digest.html', 'utf-8');
    }

    // Replace template variables
    let html = template
      .split('{{PREHEADER}}').join(preheader)
      .split('{{DATE}}').join(brisbaneStr)
      .split('{{TIME_OF_DAY}}').join(timeOfDay)
      .split('{{STAT_SCANNED}}').join(String(totalScanned))
      .split('{{STAT_APPLIED}}').join(String(pipelineStatuses['Applied'] || 0))
      .split('{{STAT_EVALUATED}}').join(String(evaluated))
      .split('{{STAT_ACTIVE}}').join(String(activeCount))
      .split('{{STAT_INBOX}}').join(String(inboxRow?.cnt || 0))
      .split('{{SCANS_TOTAL}}').join(String(totalScanned))
      .split('{{SCANS_MORE}}').join(totalScansToday.cnt > 10 ? 'true' : '')
      .split('{{PORTAL_COUNT}}').join(String(portals.length))
      .split('{{PIPELINE_TOTAL}}').join(String(Object.values(pipelineStatuses).reduce((a, b) => a + b, 0)))
      .split('{{SCANS_HTML}}').join(scansHtml)
      .split('{{PORTALS_HTML}}').join(portalsHtml)
      .split('{{PIPELINE_CELLS}}').join(pipelineCells)
      .split('{{SCORED_HTML}}').join(scoredHtml)
      .split('{{EMAILS_HTML}}').join(emailsSectionHtml)
      .split('{{EMAIL}}').join('placenciailse@gmail.com');

    // Handle {{#if SCANS}}...{{/if}} blocks
    html = html.replace(/\{\{#if SCANS\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, block) => totalScanned > 0 ? block : '');
    html = html.replace(/\{\{#if SCANS_MORE\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, block) => totalScansToday.cnt > 10 ? block : '');
    html = html.replace(/\{\{#if EMAILS_SECTION\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, block) => emailsSent > 0 ? block : '');
    html = html.replace(/\{\{#if SCORED\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, block) => scoredToday.length > 0 ? block : '');
    html = html.replace(/\{\{#if ALL_EMPTY\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, block) => totalScanned === 0 && activeCount === 0 ? block : '');

    // Send email via SMTP
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER || 'placenciailse@gmail.com',
        pass: process.env.SMTP_PASS || '',
      },
      connectionTimeout: 10000,
      greetingTimeout: 5000,
      socketTimeout: 15000,
    });

    const info = await transporter.sendMail({
      from: `"Ilse Placencia" <${process.env.SMTP_USER || 'placenciailse@gmail.com'}>`,
      to: 'placenciailse@gmail.com',
      subject: `[Careerflow Daily] ${brisbaneStr} — ${totalScanned} scans, ${activeCount} active`,
      html,
    });

    console.log(`[Lambda] Daily digest email sent: ${info.messageId}`);

    // Record message_id
    await sql`UPDATE daily_digest_log SET message_id = ${info.messageId} WHERE id = ${claimed.id}`;

    return {
      success: true,
      messageId: info.messageId,
      stats: { scansToday: totalScanned, activeApps: activeCount, portals: portals.length },
    };

  } catch (error) {
    console.error('[Lambda] Daily digest error:', error.message);
    return { success: false, error: error.message };
  }
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

    // Handle daily digest email
    if (action === 'daily-digest') {
      if (!validateCronAuth(event)) {
        return {
          statusCode: 401,
          body: JSON.stringify({ error: 'unauthorized' }),
        };
      }
      return await sendDailyDigest();
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
