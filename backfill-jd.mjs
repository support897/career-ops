#!/usr/bin/env node
/**
 * backfill-jd.mjs — fetch and store the real job description for inbox rows.
 *
 * Why this exists: every row in job_inbox had jd_text = NULL, so both the
 * scorer and the document generators fell back to "Role: <title> at <company>".
 * That fallback is what produced keyword-stuffed "core competencies" like
 * "Specialist / Housing / Australia" and made LLM scores meaningless.
 *
 * Usage:
 *   node backfill-jd.mjs                # all rows missing jd_text
 *   node backfill-jd.mjs --limit 50     # first 50
 *   node backfill-jd.mjs --concurrency 3
 *   node backfill-jd.mjs --refetch      # also redo rows that already have text
 */
import pg from 'pg';
import { config as loadEnv } from 'dotenv';
loadEnv();

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const LIMIT = parseInt(flag('limit', '0'), 10) || 0;
const CONCURRENCY = Math.max(1, parseInt(flag('concurrency', '3'), 10));
const REFETCH = args.includes('--refetch');
const MIN_CHARS = 300;
const MAX_CHARS = 8000;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function extractFrom(page) {
  return page.evaluate(() => {
    const strip = (root) => {
      if (!root) return '';
      const clone = root.cloneNode(true);
      clone
        .querySelectorAll('script,style,noscript,nav,header,footer,svg,form')
        .forEach((n) => n.remove());
      return clone.innerText || '';
    };
    const sels = [
      '[data-automation-id="jobPostingDescription"]', // Workday
      '.job-description',
      '[class*="jobDescription"]',
      '[class*="job-details"]',
      'article',
      'main',
      '[role="main"]',
      '#content',
      '.content',
    ];
    let best = '';
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        const t = strip(el);
        if (t.length > best.length) best = t;
      }
    }
    const body = strip(document.body);
    return (best.length > 400 ? best : body) || '';
  });
}

async function scrapeOne(browser, url) {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  // Block heavy assets: big speed + memory win on a 4 GB box.
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    let text = await extractFrom(page);
    if (text.replace(/\s+/g, ' ').trim().length < MIN_CHARS) {
      // JS-rendered (Workday, Greenhouse embeds) — give it longer.
      try {
        await page.waitForLoadState('networkidle', { timeout: 12000 });
      } catch {}
      await page.waitForTimeout(2500);
      text = await extractFrom(page);
    }
    return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CHARS);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main() {
  const where = REFETCH
    ? '1=1'
    : "(jd_text IS NULL OR length(jd_text) < 300)";
  const { rows } = await pool.query(
    `SELECT id, url, company, role FROM job_inbox
      WHERE ${where} AND url IS NOT NULL AND url <> ''
      ORDER BY created_at DESC ${LIMIT ? `LIMIT ${LIMIT}` : ''}`
  );
  console.log(`[jd] ${rows.length} jobs need a job description (concurrency ${CONCURRENCY})`);
  if (!rows.length) return;

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  let ok = 0, empty = 0, failed = 0, done = 0;
  const queue = [...rows];

  async function worker(id) {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      const t0 = Date.now();
      let text = '';
      let err = null;
      try {
        text = await scrapeOne(browser, job.url);
      } catch (e) {
        err = e.message.slice(0, 60);
      }
      done++;
      if (text && text.length >= MIN_CHARS) {
        await pool.query(
          'UPDATE job_inbox SET jd_text=$1, updated_at=now() WHERE id=$2',
          [text, job.id]
        );
        ok++;
        console.log(
          `[jd ${done}/${rows.length}] OK ${text.length}c ${Date.now() - t0}ms — ${job.company} / ${job.role}`
        );
      } else if (err) {
        failed++;
        console.log(`[jd ${done}/${rows.length}] FAIL ${err} — ${job.company}`);
      } else {
        empty++;
        console.log(
          `[jd ${done}/${rows.length}] EMPTY (${text.length}c, likely expired/login-walled) — ${job.company}`
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, rows.length) }, (_, i) => worker(i))
  );
  await browser.close().catch(() => {});
  console.log(`\n[jd] done — stored ${ok}, empty ${empty}, failed ${failed}`);
}

main()
  .catch((e) => {
    console.error('[jd] fatal', e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
