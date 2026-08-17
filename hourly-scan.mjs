#!/usr/bin/env node
/**
 * hourly-scan.mjs — Local hourly job scan orchestrator
 *
 * Runs every hour (via launchd/cron-local.sh) to:
 *   1. Scan jobs — 60% budget on Seek/Indeed/LinkedIn, 40% on 200+ ATS providers
 *   2. Score each job (threshold: 4.0/5)
 *   3. For jobs above threshold: generate tailored CV + cover letter
 *   4. Create Gmail DRAFT (NEVER sends) with apply link at top + CV attachment
 *   5. Log everything to data/hourly-scan-log.jsonl
 *
 * Usage:
 *   node hourly-scan.mjs                # normal run
 *   node hourly-scan.mjs --dry-run      # test without creating drafts
 *   node hourly-scan.mjs --limit 10     # cap total jobs to process
 *   node hourly-scan.mjs --boards-only  # only scan Seek/Indeed/LinkedIn (60%)
 *   node hourly-scan.mjs --ats-only     # only scan ATS providers (40%)
 */

import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const jsyaml = require('js-yaml');

// Load environment variables. The repo-root `.env` is AUTHORITATIVE: it holds the
// canonical DATABASE_URL for the CLI and the 24/7 daemon. `web/.env.local` is
// loaded afterwards only to fill in keys the root file lacks — dotenv never
// overrides an already-set variable, so root always wins.
// This ordering matters: these two files drifted apart once before (root pointed
// at local Postgres while web/.env.local still pointed at a dead Neon instance),
// which silently split the runner and the dashboard across two databases.
const dotenv = require('dotenv');
const projectRoot = dirname(fileURLToPath(import.meta.url));
for (const envPath of [join(projectRoot, '.env'), join(projectRoot, 'web', '.env.local')]) {
  if (existsSync(envPath)) dotenv.config({ path: envPath });
}



const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Flags ──────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');
const BOARDS_ONLY = process.argv.includes('--boards-only');
const ATS_ONLY = process.argv.includes('--ats-only');
const LIMIT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--limit') || '0') || null;

// ── Config ─────────────────────────────────────────────────────────────────
const MIN_SCORE = 3.0;          // Only draft above this score
const JOB_BOARDS = ['seek', 'indeed', 'linkedin'];  // 60% budget platforms
const LOG_FILE = join(__dirname, 'data/hourly-scan-log.jsonl');
const LOCK_FILE = join(__dirname, 'data/.hourly-scan.lock');

// ── Lock (prevent overlapping runs) ────────────────────────────────────────
function acquireLock() {
  if (existsSync(LOCK_FILE)) {
    const lockAge = Date.now() - parseInt(readFileSync(LOCK_FILE, 'utf8') || '0');
    if (lockAge < 55 * 60 * 1000) { // 55 min stale threshold
      console.log(`⚠️  Another scan is running (lock age: ${Math.round(lockAge / 60000)}m). Exiting.`);
      process.exit(0);
    }
    console.log(`⚠️  Stale lock detected (${Math.round(lockAge / 60000)}m old). Clearing.`);
  }
  writeFileSync(LOCK_FILE, String(Date.now()));
}

function releaseLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const content = readFileSync(LOCK_FILE, 'utf8');
      if (content === String(process.pid) || content.length > 0) {
        writeFileSync(LOCK_FILE, ''); // Clear without deleting
      }
    }
  } catch {}
}

// ── Logging ─────────────────────────────────────────────────────────────────
function log(entry) {
  mkdirSync(join(__dirname, 'data'), { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

// ── Run a child script with timeout ─────────────────────────────────────────
async function runScript(script, args = [], opts = {}) {
  const timeout = opts.timeout || 10 * 60 * 1000; // 10 min default
  try {
    const nodeBin = process.execPath || 'node';
    const { stdout, stderr } = await execFileAsync(nodeBin, [script, ...args], {
      cwd: __dirname,
      timeout,
      env: { ...process.env, PATH: `${dirname(nodeBin)}:${process.env.PATH || ''}` },
      maxBuffer: 20 * 1024 * 1024,
    });
    return { success: true, stdout, stderr };
  } catch (err) {
    return { success: false, stdout: err.stdout || '', stderr: err.stderr || err.message };
  }
}

// ── Parse scan output for new job URLs ──────────────────────────────────────
function parseNewJobs(stdout) {
  const jobs = [];
  const lines = stdout.split('\n');
  // scan.mjs outputs lines like: "✅  New: Company — Role (https://...)"
  for (const line of lines) {
    const match = line.match(/New:\s+(.+?)\s+—\s+(.+?)\s+\((https?:\/\/[^)]+)\)/);
    if (match) {
      jobs.push({ company: match[1], role: match[2], url: match[3] });
    }
  }
  // Also parse "Added N new offers to pipeline"
  const totalMatch = stdout.match(/Added (\d+) new offer/);
  const total = totalMatch ? parseInt(totalMatch[1]) : jobs.length;
  return { jobs, total };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  const runId = `scan-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  console.log('\n' + '═'.repeat(60));
  console.log(`🕐  Hourly Scan — ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}`);
  console.log(`    Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'} | Min Score: ${MIN_SCORE} | 60% Boards / 40% ATS`);
  console.log('═'.repeat(60) + '\n');

  const results = {
    runId,
    startedAt: new Date().toISOString(),
    boardsScanned: 0,
    atsScanned: 0,
    totalNewJobs: 0,
    jobsAboveThreshold: 0,
    draftsCreated: 0,
    errors: [],
  };

  try {
    // ── Phase 1: Scan job boards (Seek / Indeed / LinkedIn) — 60% ────────────
    if (!ATS_ONLY) {
      console.log('📋  Phase 1 of 2 — Scanning job boards (Seek / Indeed / LinkedIn) — 60% budget\n');

      const boardArgs = ['--quiet'];
      if (DRY_RUN) boardArgs.push('--dry-run');
      if (LIMIT) boardArgs.push('--limit', String(Math.round(LIMIT * 0.6)));

      // Run scan.mjs with job_boards filter (seek, indeed, linkedin providers)
      const boardResult = await runScript('scan.mjs', [...boardArgs, '--provider', 'seek', '--provider', 'indeed', '--provider', 'linkedin'], { timeout: 18 * 60 * 1000 });

      if (!boardResult.success && boardResult.stderr) {
        console.error('⚠️  Job boards scan had errors:', boardResult.stderr.slice(0, 200));
        results.errors.push({ phase: 'boards', error: boardResult.stderr.slice(0, 200) });
      }

      const boardJobs = parseNewJobs(boardResult.stdout);
      results.boardsScanned = boardJobs.total;
      console.log(`   ✅  Job boards: ${boardJobs.total} new offers found\n`);
    }

    // ── Phase 2: Scan ATS providers — 40% ────────────────────────────────────
    if (!BOARDS_ONLY) {
      console.log('🏢  Phase 2 of 2 — Scanning 200+ ATS providers (Greenhouse / Ashby / Lever / ...) — 40% budget\n');

      const atsArgs = ['--quiet'];
      if (DRY_RUN) atsArgs.push('--dry-run');
      if (LIMIT) atsArgs.push('--limit', String(Math.round(LIMIT * 0.4)));

      // Run scan.mjs excluding the job boards (everything else = ATS providers)
      const atsResult = await runScript('scan.mjs', [...atsArgs, '--exclude-provider', 'seek', '--exclude-provider', 'indeed', '--exclude-provider', 'linkedin'], { timeout: 18 * 60 * 1000 });

      if (!atsResult.success && atsResult.stderr) {
        console.error('⚠️  ATS scan had errors:', atsResult.stderr.slice(0, 200));
        results.errors.push({ phase: 'ats', error: atsResult.stderr.slice(0, 200) });
      }

      const atsJobs = parseNewJobs(atsResult.stdout);
      results.atsScanned = atsJobs.total;
      console.log(`   ✅  ATS providers: ${atsJobs.total} new offers found\n`);
    }

    results.totalNewJobs = results.boardsScanned + results.atsScanned;

    // ── Phase 3: Process pipeline with strict 65% / 35% resource allocation ────
    console.log(`\n📨  Phase 3a — Processing Primary Tech pipeline (65% allocation, score ≥ ${MIN_SCORE} → Gmail draft)\n`);

    const applyArgsDefault = [
      '--local-vip',
      '--min-score', String(MIN_SCORE),
      '--keep-pipeline',
      '--max-age', '14'
    ];
    if (DRY_RUN) applyArgsDefault.push('--dry-run');
    applyArgsDefault.push('--limit', String(Math.max(1, Math.round((LIMIT || 1000) * 0.65))));

    const applyResult = await runScript('auto-apply.mjs', applyArgsDefault, { timeout: 25 * 60 * 1000 });

    console.log(`\n📨  Phase 3b — Processing Support Coordinator pipeline (35% allocation, support_worker account)\n`);
    const applyArgsSupport = [
      '--userId', 'support_worker',
      '--min-score', String(MIN_SCORE),
      '--read-local-pipeline'
    ];
    if (DRY_RUN) applyArgsSupport.push('--dry-run');
    applyArgsSupport.push('--limit', String(Math.max(1, Math.round((LIMIT || 1000) * 0.35))));

    await runScript('auto-apply.mjs', applyArgsSupport, { timeout: 25 * 60 * 1000 });

    if (!applyResult.success && applyResult.stderr) {
      console.error('⚠️  Apply pipeline had errors:', applyResult.stderr.slice(0, 200));
      results.errors.push({ phase: 'apply', error: applyResult.stderr.slice(0, 200) });
    }

    // Parse draft count from output
    const draftMatch = applyResult.stdout.match(/Gmail draft created.*?(\d+)/g);
    results.draftsCreated = draftMatch ? draftMatch.length : 0;
    const aboveMatch = applyResult.stdout.match(/Processed:\s+(\d+)/);
    results.jobsAboveThreshold = aboveMatch ? parseInt(aboveMatch[1]) : 0;

    // Print auto-apply summary
    const summaryLines = applyResult.stdout.split('\n').filter(l =>
      l.includes('✅') || l.includes('⚠️') || l.includes('Gmail draft') || l.includes('Scanned:') || l.includes('Applied:')
    );
    for (const line of summaryLines.slice(0, 20)) console.log('  ', line);

  } catch (err) {
    console.error('❌  Fatal error:', err.message);
    results.errors.push({ phase: 'fatal', error: err.message });
  } finally {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    results.finishedAt = new Date().toISOString();
    results.elapsedSeconds = elapsed;

    console.log('\n' + '─'.repeat(60));
    console.log(`✅  Scan complete in ${elapsed}s`);
    console.log(`   Job boards (60%):  ${results.boardsScanned} new`);
    console.log(`   ATS providers (40%): ${results.atsScanned} new`);
    console.log(`   Total new jobs:      ${results.totalNewJobs}`);
    console.log(`   Above threshold (≥${MIN_SCORE}): ${results.jobsAboveThreshold}`);
    console.log(`   Gmail drafts created: ${results.draftsCreated}`);
    if (results.errors.length > 0) {
      console.log(`   Errors: ${results.errors.length} (see log)`);
    }
    console.log('─'.repeat(60) + '\n');

    log(results);
  }
}



// ── Infinite Loop Runner (24/7 scanning every 10 mins) ────────────────────────
const SLEEP_MS = 10 * 60 * 1000; // 10 minutes

async function startDaemon() {
  console.log(`🚀 Daemon started. Loop interval set to ${SLEEP_MS / 60000} minutes.`);
  while (true) {
    if (existsSync(join(__dirname, 'data', '.pause_scans'))) {
      console.log(`⏸️  Scans are paused by user. Checking again in 1 minute...`);
      await new Promise(resolve => setTimeout(resolve, 60000));
      continue;
    }

    try {
      await main();
    } catch (err) {
      console.error('❌ Loop cycle error:', err.message);
    }
    console.log(`💤 Sleeping for ${SLEEP_MS / 60000} minutes before next sweep...`);
    await new Promise(resolve => setTimeout(resolve, SLEEP_MS));
  }
}

startDaemon().catch(err => {
  console.error('❌ Daemon fatal crash:', err);
  process.exit(1);
});
