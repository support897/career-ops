#!/usr/bin/env node
/**
 * requeue-unsynced.mjs — re-open pipeline entries that never reached the database.
 *
 * Two bugs made the pipeline mark jobs done while recording nothing:
 *
 *   1. syncToInbox() wrote a generation_method column that did not exist, so
 *      every INSERT was rejected. The pipeline logged one warning per job and
 *      carried on, ticking each entry off in pipeline.md.
 *   2. Scoring silently fell back to keyword matching (Ollama absent, Gemini
 *      never tried), which tops out below the 4.0 document threshold — so even
 *      the jobs that did land were scored by a scorer that could not qualify
 *      them for documents.
 *
 * Both are fixed, but the affected entries stay ticked and would never be
 * looked at again. This re-opens exactly those: checked in pipeline.md, absent
 * from job_inbox. Anything already in the database is left alone, so it is safe
 * to run repeatedly.
 *
 * Pre-screen still applies afterwards, so stale postings get dropped on age
 * rather than costing an LLM call.
 *
 *   node requeue-unsynced.mjs            # report only
 *   node requeue-unsynced.mjs --apply    # rewrite pipeline.md (backs up first)
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: [join(__dirname, '.env.local'), join(__dirname, '.env')] });

const APPLY = process.argv.includes('--apply');
const PIPELINE = join(__dirname, 'data/pipeline.md');

if (!existsSync(PIPELINE)) {
  console.error(`No pipeline file at ${PIPELINE}`);
  process.exit(1);
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query('SELECT url FROM job_inbox');
const inDb = new Set(rows.map(r => r.url));
console.log(`job_inbox holds ${inDb.size} url(s).`);

const text = readFileSync(PIPELINE, 'utf8');
const lines = text.split('\n');

let checked = 0;
let requeued = 0;
const out = lines.map((line) => {
  const m = line.match(/^- \[x\] (\S+)/);
  if (!m) return line;
  checked++;
  const url = m[1];
  if (inDb.has(url)) return line;
  requeued++;
  // Flip only the checkbox; the trailing metadata (company, role, location,
  // posted date) must survive untouched or the re-evaluation loses its context.
  return line.replace('- [x] ', '- [ ] ');
});

console.log(`checked entries      : ${checked}`);
console.log(`already in database  : ${checked - requeued}`);
console.log(`to re-queue          : ${requeued}`);

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to rewrite pipeline.md.');
} else if (requeued === 0) {
  console.log('\nNothing to do.');
} else {
  const backup = `${PIPELINE}.bak-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
  copyFileSync(PIPELINE, backup);
  writeFileSync(PIPELINE, out.join('\n'));
  console.log(`\nBacked up to ${backup}`);
  console.log(`Re-queued ${requeued} entr${requeued === 1 ? 'y' : 'ies'} in ${PIPELINE}`);
}

await pool.end();
