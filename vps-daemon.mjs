#!/usr/bin/env node
/**
 * vps-daemon.mjs — 24/7 career-ops cycle runner for the VPS.
 *
 * Runs one auto-apply cycle per interval, sequentially, with three guards that
 * exist because the box has a hard 3.8 GB ceiling and previously accumulated 28
 * orphaned `auto-apply.mjs` processes (1.7 GB) that had to be killed by hand:
 *
 *   1. LOCKFILE — only one cycle may run at a time, even across a pm2 restart or
 *      a manual invocation. A lock whose PID is dead is treated as stale.
 *   2. TIMEOUT — a cycle that exceeds CYCLE_TIMEOUT_MS is killed, child tree and
 *      all, instead of hanging forever holding memory.
 *   3. ORPHAN SWEEP — before each cycle, any `auto-apply.mjs` process that is not
 *      a descendant of this daemon and is older than the timeout is terminated.
 *
 * Env overrides: CYCLE_INTERVAL_MIN (default 60), CYCLE_TIMEOUT_MIN (default 40).
 */
import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The daemon needs the env itself, not just the child: VIP_USER_ID below
// decides which tenant every scored job is written under, and an unset value
// silently sends the whole run to 'default' where the dashboard never looks.
// Root .env wins, matching auto-apply.mjs and hourly-scan.mjs.
loadEnv({ path: [join(__dirname, 'web', '.env.local'), join(__dirname, '.env')] });
const LOCK_PATH = join(__dirname, 'data', '.cycle.lock');
const INTERVAL_MS = (parseInt(process.env.CYCLE_INTERVAL_MIN || '60', 10) || 60) * 60 * 1000;
const TIMEOUT_MS = (parseInt(process.env.CYCLE_TIMEOUT_MIN || '40', 10) || 40) * 60 * 1000;
// The dashboard reads job_inbox for VIP_USER_ID. Hardcoding 'default' here
// wrote every scored job, document and draft under a tenant the UI never
// queries: 190 processed jobs sat invisible while the dashboard showed the 12
// older rows. Fall back to 'default' only if the id is genuinely unset.
const RUN_USER_ID = process.env.VIP_USER_ID || process.env.NEXT_PUBLIC_USER_ID || 'default';
const ARGS = ['auto-apply.mjs', '--userId', RUN_USER_ID, '--local-vip', '--min-score', '4.0', '--max-age', '14'];

let holdsLock = false; // only the instance that acquired the lock may release it

const ts = () => new Date().toISOString();
const log = (m) => console.log(`[${ts()}] ${m}`);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Acquire the cycle lock. Returns false if a live cycle already holds it. */
function acquireLock() {
  try { mkdirSync(dirname(LOCK_PATH), { recursive: true }); } catch { /* exists */ }
  if (existsSync(LOCK_PATH)) {
    const raw = readFileSync(LOCK_PATH, 'utf8').trim();
    const pid = parseInt(raw.split(/\s+/)[0], 10);
    if (Number.isFinite(pid) && pidAlive(pid)) {
      log(`⏸  cycle already running (pid ${pid}) — skipping this tick`);
      return false;
    }
    log(`🧹 clearing stale lock (pid ${raw || 'unknown'} is gone)`);
    try { unlinkSync(LOCK_PATH); } catch { /* raced */ }
  }
  writeFileSync(LOCK_PATH, `${process.pid} ${ts()}\n`);
  holdsLock = true;
  return true;
}

/**
 * Release the lock, but ONLY if this process acquired it. A tick that skipped
 * because another cycle held the lock must never delete that cycle's lock.
 */
function releaseLock() {
  if (!holdsLock) return;
  try { if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH); } catch { /* ignore */ }
  holdsLock = false;
}

/**
 * Kill stray auto-apply processes left by an earlier crash, a pm2 restart, or a
 * manual run. Only touches processes older than the cycle timeout, so a healthy
 * concurrent cycle is never disturbed.
 */
function sweepOrphans() {
  let out = '';
  try {
    out = execSync('ps -eo pid,etimes,cmd | grep "auto-apply.mjs" | grep -v grep || true',
      { encoding: 'utf8', timeout: 15000 });
  } catch { return; }
  const cutoff = Math.floor(TIMEOUT_MS / 1000);
  let killed = 0;
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const age = parseInt(m[2], 10);
    if (pid === process.pid || age <= cutoff) continue;
    try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
  }
  if (killed) log(`🧹 swept ${killed} orphaned auto-apply process(es) older than ${cutoff}s`);
}

/** Run one cycle, enforcing the timeout by killing the whole process group. */
function runCycle() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ARGS, {
      cwd: __dirname,
      stdio: 'inherit',
      env: { ...process.env },
      detached: true, // own process group, so we can kill the whole tree
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`⏱  cycle exceeded ${TIMEOUT_MS / 60000} min — terminating process group ${child.pid}`);
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 15000);
    }, TIMEOUT_MS);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) resolve({ ok: false, reason: 'timeout' });
      else if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, reason: `exit ${code}${signal ? ` (${signal})` : ''}` });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message });
    });
  });
}

async function main() {
  log('🚀 [24/7 VPS Daemon] career-ops auto-apply service starting');
  log(`   interval ${INTERVAL_MS / 60000} min · cycle timeout ${TIMEOUT_MS / 60000} min · lock ${LOCK_PATH}`);

  const shutdown = (sig) => { log(`received ${sig} — releasing lock and exiting`); releaseLock(); process.exit(0); };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  for (;;) {
    sweepOrphans();
    if (acquireLock()) {
      log('⏰ launching cycle');
      const started = Date.now();
      try {
        const r = await runCycle();
        const mins = ((Date.now() - started) / 60000).toFixed(1);
        if (r.ok) log(`✅ cycle completed in ${mins} min`);
        else log(`⚠️  cycle failed after ${mins} min: ${r.reason}`);
      } finally {
        releaseLock();
      }
    }
    log(`💤 sleeping ${INTERVAL_MS / 60000} min until next cycle`);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error('Fatal daemon crash:', err);
  releaseLock();
  process.exit(1);
});
