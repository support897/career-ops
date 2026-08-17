// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// SEEK provider — public JobSearch v5 REST API. NO cookies, NO browser, NO key.
//
// This replaces a 362-line Puppeteer + stealth-plugin + saved-cookie scraper that
// failed every run with "Cookies expired (30d). Re-login needed." and emailed a
// reminder about it. Cookies were never the right mechanism here: SEEK exposes the
// same search its own website consumes as an unauthenticated JSON endpoint.
//
// Verified from this VPS on 2026-08-17:
//   GET https://www.seek.com.au/api/jobsearch/v5/search
//       ?siteKey=AU-Main&sourcesystem=houston&keywords=remote
//       &where=All%20Australia&page=1&dateRange=3
//   → HTTP 200, 20 jobs/page, totalCount 5628, no auth of any kind.
//
// Nothing here expires, so this cannot silently rot the way the cookie jar did.
//
// Portal entry fields (all optional):
//   siteKey        — SEEK market key (default "AU-Main"; NZ-Main for seek.co.nz)
//   searchKeywords — keywords; may be a string or an array of strings (each is
//                    searched separately, which returns far more than OR-ing them)
//   searchLocation — `where` value (default "All Australia")
//   sinceDays      — dateRange filter in days (default 14)
//   maxPages       — pages per keyword (default 5, i.e. up to 100 jobs each)

const DEFAULT_ORIGIN = 'https://www.seek.com.au';
const SEARCH_PATH = '/api/jobsearch/v5/search';
const DEFAULT_SITE_KEY = 'AU-Main';
const DEFAULT_LOCATION = 'All Australia';
const DEFAULT_SINCE_DAYS = 14;
const DEFAULT_MAX_PAGES = 5;
const PAGE_DELAY_MS = 250;

// SSRF guard: only SEEK's own hosts, matching the pattern used by the other
// providers in this directory.
const ALLOWED_HOSTS = new Set([
  'www.seek.com.au',
  'seek.com.au',
  'www.seek.co.nz',
  'seek.co.nz',
]);

/** @param {string} origin */
function assertSeekOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`seek: invalid origin: ${origin}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`seek: origin must use HTTPS: ${origin}`);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`seek: untrusted hostname "${parsed.hostname}"`);
  }
  return `${parsed.protocol}//${parsed.hostname}`;
}

/**
 * @param {string} origin
 * @param {{siteKey:string, keywords:string, location:string, page:number, sinceDays:number}} q
 */
function buildSearchUrl(origin, q) {
  const u = new URL(SEARCH_PATH, origin);
  u.searchParams.set('siteKey', q.siteKey);
  u.searchParams.set('sourcesystem', 'houston'); // required; identifies the caller
  if (q.keywords) u.searchParams.set('keywords', q.keywords);
  if (q.location) u.searchParams.set('where', q.location);
  u.searchParams.set('page', String(q.page));
  if (q.sinceDays > 0) u.searchParams.set('dateRange', String(q.sinceDays));
  return u.toString();
}

/**
 * Normalise one v5 result into the scanner's Job shape.
 * @param {any} item
 * @param {string} origin
 * @returns {import('./_types.js').Job | null}
 */
export function parseSeekItem(item, origin = DEFAULT_ORIGIN) {
  const id = item?.id != null ? String(item.id) : '';
  const title = String(item?.title || '').trim();
  if (!id || !title) return null;

  // Company: `advertiser.description` is the display name SEEK shows on the
  // card; `companyName` is present on some records only.
  const company = String(item?.advertiser?.description || item?.companyName || '').trim();

  const location = Array.isArray(item?.locations) && item.locations.length
    ? String(item.locations[0]?.label || '').trim()
    : String(item?.location || '').trim();

  // Build a description from the fields the list payload already carries, so we
  // stay zero-token: no extra request per job. Feeds scan.mjs's content_filter.
  const parts = [];
  if (item?.teaser) parts.push(String(item.teaser).trim());
  if (Array.isArray(item?.bulletPoints) && item.bulletPoints.length) {
    parts.push(item.bulletPoints.map((b) => `• ${String(b).trim()}`).join('\n'));
  }
  if (item?.salaryLabel) parts.push(`Salary: ${String(item.salaryLabel).trim()}`);
  if (Array.isArray(item?.workTypes) && item.workTypes.length) {
    parts.push(`Work type: ${item.workTypes.join(', ')}`);
  }
  // workArrangements marks Remote/Hybrid/On-site — important for the location filter.
  const arrangements = item?.workArrangements?.data;
  if (Array.isArray(arrangements) && arrangements.length) {
    const labels = arrangements.map((a) => String(a?.label || '').trim()).filter(Boolean);
    if (labels.length) parts.push(`Work arrangement: ${labels.join(', ')}`);
  }

  let postedAt;
  if (item?.listingDate) {
    const t = Date.parse(item.listingDate);
    if (!Number.isNaN(t)) postedAt = t;
  }

  /** @type {import('./_types.js').Job} */
  const job = {
    title,
    url: `${origin}/job/${id}`,
    company,
    location,
  };
  if (parts.length) job.description = parts.join('\n');
  if (postedAt) job.postedAt = postedAt;
  return job;
}

/** Normalise the keyword option into a list of separate searches. */
export function keywordList(entry) {
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
  id: 'seek',

  detect(_entry) {
    // SEEK is an aggregator, not a company ATS — require `provider: seek`
    // explicitly in portals.yml, same convention as the jobstreet provider.
    return null;
  },

  async fetch(entry, ctx) {
    const origin = assertSeekOrigin(entry.api || entry.origin || DEFAULT_ORIGIN);
    const siteKey = entry.siteKey || DEFAULT_SITE_KEY;
    const location = entry.searchLocation ?? DEFAULT_LOCATION;
    const sinceDays = Number(entry.sinceDays) || DEFAULT_SINCE_DAYS;
    const maxPages = Number(entry.maxPages) || DEFAULT_MAX_PAGES;
    const keywords = keywordList(entry);

    const jobs = [];
    const seen = new Set();
    let firstError = null;

    for (const kw of keywords) {
      for (let page = 1; page <= maxPages; page++) {
        const url = buildSearchUrl(origin, { siteKey, keywords: kw, location, page, sinceDays });

        let json;
        try {
          json = /** @type {any} */ (await ctx.fetchJson(url));
        } catch (err) {
          // One bad keyword or page must not sink the whole provider — record it
          // and carry on, so a partial result still reaches the pipeline.
          if (!firstError) firstError = err;
          console.error(`seek: "${kw || '(all)'}" page ${page} failed — ${err.message}`);
          break;
        }

        const data = Array.isArray(json?.data) ? json.data : [];
        if (data.length === 0) break;

        for (const item of data) {
          const job = parseSeekItem(item, origin);
          if (!job || seen.has(job.url)) continue;
          seen.add(job.url);
          jobs.push(job);
        }

        // Last page for this keyword.
        if (data.length < 20) break;
        await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      }
    }

    // Only fail loudly if we got literally nothing AND something went wrong;
    // silence here is what let the old cookie scraper rot unnoticed.
    if (jobs.length === 0 && firstError) throw firstError;
    return jobs;
  },
};
