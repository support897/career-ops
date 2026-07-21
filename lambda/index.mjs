/**
 * lambda/index.mjs — AWS Lambda handler for career-ops scanning & applying.
 *
 * Receives events from Inngest via API Gateway.
 * Supported actions:
 *   - scan:  runs scan.mjs --userId
 *   - apply: runs auto-apply.mjs --userId
 *
 * Environment variables required:
 *   DATABASE_URL — Neon DB connection string
 *   CAREER_OPS_PORTALS — path to portals.yml (default: /var/task/portals.yml)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, writeFileSync, mkdirSync, symlinkSync, cpSync, readdirSync, statSync } from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

const TASK_DIR = process.env.LAMBDA_TASK_ROOT || '/var/task';
const WORK_DIR = '/tmp/career-ops';

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
  for (const dir of ['lib', 'providers', 'plugins', 'config', 'modes', 'templates', 'data', 'node_modules']) {
    const src = path.join(TASK_DIR, dir);
    const dst = path.join(WORK_DIR, dir);
    try {
      if (existsSync(src) && !existsSync(dst)) {
        symlinkSync(src, dst, 'dir');
      }
    } catch {}
  }
}

export const handler = async (event) => {
  console.log('[Lambda] Event received:', JSON.stringify(event, null, 2));

  let userId, platforms, keywords, location, maxResults;
  let action = 'scan';
  try {
    // Handle both SDK invoke (event is the payload) and Function URL (payload in event.body)
    const body = event.body
      ? (typeof event.body === 'string' ? JSON.parse(event.body) : event.body)
      : event;
    ({ userId, platforms, keywords, location, maxResults, action = 'scan' } = body);

    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'userId is required' }),
      };
    }

    console.log(`[Lambda] Action: ${action} for user: ${userId}`);

    prepareWorkDir();

    let args;
    if (action === 'apply') {
      args = ['auto-apply.mjs', '--userId', userId];
    } else {
      args = ['scan.mjs', '--userId', userId];
    }

    console.log(`[Lambda] Running: node ${args.join(' ')}`);
    console.log(`[Lambda] Working directory: ${WORK_DIR}`);

    const { stdout, stderr } = await execFileAsync('node', args, {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        NODE_PATH: TASK_DIR + '/node_modules',
        NODE_OPTIONS: '--max-old-space-size=1536',
      },
      timeout: action === 'apply' ? 300000 : 240000,
      maxBuffer: 10 * 1024 * 1024,
    });

    console.log('[Lambda] Output:', stdout);
    if (stderr) {
      console.log('[Lambda] Stderr:', stderr);
    }

    // Parse results from stdout
    const newOffersMatch = stdout.match(/New offers added:\s+(\d+)/);
    const newOffers = newOffersMatch ? parseInt(newOffersMatch[1], 10) : 0;

    const totalFoundMatch = stdout.match(/Total found:\s+(\d+)/);
    const totalFound = totalFoundMatch ? parseInt(totalFoundMatch[1], 10) : 0;

    const appliedMatch = stdout.match(/Applied:\s+(\d+)/);
    const applied = appliedMatch ? parseInt(appliedMatch[1], 10) : 0;

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        userId,
        action,
        newOffers,
        totalFound,
        applied,
        message: action === 'apply'
          ? `Apply pipeline complete. ${applied} applications processed.`
          : `Scan complete. ${newOffers} new jobs found and added to database.`,
        output: stdout,
      }),
    };
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
        error: `${action} failed`,
        message: error.message,
        stderr: error.stderr,
      }),
    };
  }
};
