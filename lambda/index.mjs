/**
 * lambda/index.mjs — AWS Lambda handler for career-ops scanning.
 *
 * Receives scan requests from Inngest via API Gateway,
 * runs the scanner with --userId, returns results.
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

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const { userId, platforms, keywords, location, maxResults } = body;

    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'userId is required' }),
      };
    }

    console.log(`[Lambda] Scanning for user: ${userId}`);
    console.log(`[Lambda] Platforms: ${platforms?.join(', ') || 'all'}`);
    console.log(`[Lambda] Keywords: ${keywords || 'none'}`);

    // Build scan command
    const args = ['scan.mjs', '--userId', userId];

    if (platforms && platforms.length > 0) {
      // Scan specific platforms (filtered by provider)
      // Note: scan.mjs --company filters by company name, not platform
      // For platform filtering, we rely on DB config
    }

    // Set working directory to where career-ops code lives
    const careerOpsDir = process.env.LAMBDA_TASK_ROOT || '/var/task';

    // Ensure DATABASE_URL is available
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    console.log(`[Lambda] Running: node ${args.join(' ')}`);
    console.log(`[Lambda] Working directory: ${careerOpsDir}`);

    // Run the scanner
    const { stdout, stderr } = await execFileAsync('node', args, {
      cwd: careerOpsDir,
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=1536', // Lambda has 2GB, leave headroom
      },
      timeout: 240000, // 4 minutes (Lambda timeout is 5 min)
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    console.log('[Lambda] Scanner output:', stdout);
    if (stderr) {
      console.log('[Lambda] Scanner stderr:', stderr);
    }

    // Parse results from stdout
    const newOffersMatch = stdout.match(/New offers added:\s+(\d+)/);
    const newOffers = newOffersMatch ? parseInt(newOffersMatch[1], 10) : 0;

    const totalFoundMatch = stdout.match(/Total found:\s+(\d+)/);
    const totalFound = totalFoundMatch ? parseInt(totalFoundMatch[1], 10) : 0;

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        userId,
        newOffers,
        totalFound,
        message: `Scan complete. ${newOffers} new jobs found and added to database.`,
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
          error: 'Scan timed out',
          message: 'The scan took too long. Try scanning fewer platforms.',
        }),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Scan failed',
        message: error.message,
        stderr: error.stderr,
      }),
    };
  }
};
