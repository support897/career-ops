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
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

// Lambda has limited /tmp — use it for scan output
const WORK_DIR = '/tmp/career-ops';
mkdirSync(WORK_DIR, { recursive: true });

export const handler = async (event) => {
  console.log('[Lambda] Event received:', JSON.stringify(event, null, 2));

  let userId, platforms, keywords, location, maxResults;
  let action = 'scan';
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    ({ userId, platforms, keywords, location, maxResults, action = 'scan' } = body);

    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'userId is required' }),
      };
    }

    console.log(`[Lambda] Action: ${action} for user: ${userId}`);

    // Set working directory to where career-ops code lives
    const careerOpsDir = process.env.LAMBDA_TASK_ROOT || '/var/task';

    // Ensure DATABASE_URL is available
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    let args;
    if (action === 'apply') {
      args = ['auto-apply.mjs', '--userId', userId];
    } else {
      args = ['scan.mjs', '--userId', userId];
      // Future: pass platform filters from `platforms` if scan.mjs supports it
    }

    console.log(`[Lambda] Running: node ${args.join(' ')}`);
    console.log(`[Lambda] Working directory: ${careerOpsDir}`);

    // Run the requested script
    const { stdout, stderr } = await execFileAsync('node', args, {
      cwd: careerOpsDir,
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=1536', // Lambda has 2GB, leave headroom
      },
      timeout: action === 'apply' ? 300000 : 240000, // apply can take longer
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
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
