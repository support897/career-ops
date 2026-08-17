// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// LinkedIn provider — public guest job-search endpoint. NO cookies, NO browser.
//
// Replaces a 648-line Puppeteer + stealth + saved-cookie scraper that reported
// "Cookies expired (30d). Re-login needed." on every run. LinkedIn serves its
// job cards to logged-out visitors from a guest endpoint, which is what the
// "See more jobs" button on a public search page calls:
//
//   GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
//       ?keywords=<kw>&location=Australia&start=<n>
//   → HTTP 200, an HTML fragment of ~25 job cards (verified from this VPS
//     2026-08-17, no auth of any kind).
//
// It returns HTML rather than JSON, so this parses the card attributes with
// scoped regexes. That is deliberate: adding a DOM parser dependency for five
// fields is not worth it, and the card markup is stable and simple. Every
// extraction is defensive — a markup change costs us fields, never a crash.
//
// Portal entry fields (all optional):
//   searchKeywords — string or array of strings (each searched separately)
//   searchLocation — `location` value (default "Australia")
//   maxPages       — pages per keyword, 25 cards each (default 3)

const ORIGIN = 'https://www.linkedin.com';
const GUEST_PATH = '/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DEFAULT_LOCATION = 'Australia';
const DEFAULT_MAX_PAGES = 3;
const PAGE_SIZE = 25;
const PAGE_DELAY_MS = 400;

/** Decode the handful of HTML entities that show up in job titles. */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Strip tags and collapse whitespace. */
function text(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Normalise a LinkedIn job URL: strip tracking query params, keep the stable
 * /jobs/view/<slug-id> path so it can serve as a dedup key.
 * @param {string} href
 */
export function cleanJobUrl(href) {
  if (!href) return '';
  let u;
  try {
    u = new URL(decodeEntities(href), ORIGIN);
  } catch {
    return '';
  }
  if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return '';
  return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
}

/**
 * Parse the guest endpoint's HTML fragment into Job objects.
 * Exported for unit testing without a network call.
 * @param {string} html
 * @returns {import('./_types.js').Job[]}
 */
export function parseGuestCards(html) {
  const out = [];
  if (!html) return out;

  // Each result is one <li>. Split on it rather than trying to match a single
  // giant pattern, so one malformed card cannot swallow its neighbours.
  const chunks = String(html).split(/<li[\s>]/i).slice(1);

  for (const chunk of chunks) {
    const hrefM = chunk.match(/href="([^"]*\/jobs\/view\/[^"]*)"/i);
    const url = cleanJobUrl(hrefM?.[1] || '');
    if (!url) continue;

    const titleM =
      chunk.match(/class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\//i) ||
      chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const title = text(titleM?.[1] || '');
    if (!title) continue;

    const companyM =
      chunk.match(/class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/i) ||
      chunk.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
    const company = text(companyM?.[1] || '');

    const locM = chunk.match(/class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\//i);
    const location = text(locM?.[1] || '');

    let postedAt;
    const dateM = chunk.match(/datetime="([^"]+)"/i);
    if (dateM) {
      const t = Date.parse(dateM[1]);
      if (!Number.isNaN(t)) postedAt = t;
    }

    /** @type {import('./_types.js').Job} */
    const job = { title, url, company, location };
    if (postedAt) job.postedAt = postedAt;
    out.push(job);
  }
  return out;
}

/** Normalise the keyword option into a list of separate searches. */
function keywordList(entry) {
  const raw = entry?.searchKeywords ?? entry?.keywords ?? '';
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const k of list) {
    const s = String(k ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.length ? out : [''];
}

/** @type {Provider} */
export default {
  id: 'linkedin',

  detect(_entry) {
    // Aggregator, not a company ATS — requires `provider: linkedin` in portals.yml.
    return null;
  },

  async fetch(entry, ctx) {
    const location = entry.searchLocation ?? DEFAULT_LOCATION;
    const maxPages = Number(entry.maxPages) || DEFAULT_MAX_PAGES;
    const keywords = keywordList(entry);

    const jobs = [];
    const seen = new Set();
    let firstError = null;

    for (const kw of keywords) {
      for (let page = 0; page < maxPages; page++) {
        const u = new URL(GUEST_PATH, ORIGIN);
        if (kw) u.searchParams.set('keywords', kw);
        if (location) u.searchParams.set('location', location);
        u.searchParams.set('start', String(page * PAGE_SIZE));

        let html;
        try {
          // The endpoint returns text/html, so use the text fetcher when the
          // scanner provides one and fall back to global fetch otherwise.
          if (typeof ctx?.fetchText === 'function') {
            html = await ctx.fetchText(u.toString());
          } else {
            const r = await fetch(u.toString(), {
              headers: {
                accept: 'text/html,application/xhtml+xml',
                'accept-language': 'en-AU,en;q=0.9',
                'user-agent':
                  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              },
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            html = await r.text();
          }
        } catch (err) {
          if (!firstError) firstError = err;
          console.error(`linkedin: "${kw || '(all)'}" page ${page} failed — ${err.message}`);
          break;
        }

        const batch = parseGuestCards(html);
        if (batch.length === 0) break;

        for (const job of batch) {
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          jobs.push(job);
        }

        if (batch.length < PAGE_SIZE) break;
        await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      }
    }

    if (jobs.length === 0 && firstError) throw firstError;
    return jobs;
  },
};
