// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Adzuna provider — global job aggregator with structured salary data
// API: GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}
// Free API key required — register at https://developer.adzuna.com
// Env: ADZUNA_APP_ID, ADZUNA_APP_KEY
// VIP-only: requiresVip flag skips this provider for non-VIP users.
//
// Wire in via a `job_boards:` entry with `provider: adzuna`.

const API_BASE = 'https://api.adzuna.com/v1/api/jobs';
const PER_PAGE = 50;
const DEFAULT_MAX_PAGES = 5;
const MAX_PAGES_CAP = 50;

/** @type {Provider} */
export default {
  id: 'adzuna',
  requiresVip: true,

  async fetch(entry, ctx) {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    if (!appId || !appKey) {
      throw new Error('adzuna: missing ADZUNA_APP_ID and/or ADZUNA_APP_KEY env vars — register at https://developer.adzuna.com');
    }

    const country = entry.adzunaCountry || 'au'; // default Australia
    const keywords = entry.searchKeywords || entry.name || 'AI automation';
    // Adzuna's 'what' param works best with 1-2 keywords; take the first role
    const searchKeywords = Array.isArray(entry.searchKeywords)
      ? entry.searchKeywords[0]
      : (entry.searchKeywords || '').split(/\s{2,}/)[0] || keywords;
    const maxPages = Math.min(entry.max_pages || DEFAULT_MAX_PAGES, MAX_PAGES_CAP);
    const out = [];

    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        results_per_page: String(PER_PAGE),
        what: searchKeywords,
      });
      if (entry.searchLocation) params.set('where', entry.searchLocation);
      else if (entry._userLocation) params.set('where', entry._userLocation);
      if (entry.salaryMin) params.set('salary_min', String(entry.salaryMin));

      const url = `${API_BASE}/${country}/search/${page}?${params.toString()}`;
      const json = await ctx.fetchJson(url, { redirect: 'error' });

      if (!json || !Array.isArray(json.results)) {
        throw new Error(`adzuna: unexpected response on page ${page} — keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
      }

      for (const j of json.results) {
        if (!j || typeof j !== 'object' || typeof j.title !== 'string' || !j.title.trim()) continue;

        let url = '';
        const rawUrl = typeof j.redirect_url === 'string' ? j.redirect_url.trim() : '';
        if (rawUrl) {
          try {
            const parsed = new URL(rawUrl);
            if (parsed.protocol === 'https:') url = parsed.href;
          } catch { /* malformed */ }
        }
        if (!url) continue;

        const job = {
          title: j.title.trim(),
          url,
          company: typeof j.company === 'object' && j.company !== null && typeof j.company.display_name === 'string'
            ? j.company.display_name.trim()
            : (entry.name || 'Adzuna'),
          location: typeof j.location === 'object' && j.location !== null && typeof j.location.display_name === 'string'
            ? j.location.display_name.trim()
            : typeof j.location === 'string' ? j.location.trim()
            : '',
          postedAt: j.created ? new Date(j.created).getTime() || undefined : undefined,
        };

        // Structured salary data when available
        if (Number.isFinite(j.salary_is_predicted) && j.salary_is_predicted > 0) {
          job.salary = j.salary_min || j.salary_max || undefined;
          job.salaryMin = Number.isFinite(j.salary_min) ? j.salary_min : undefined;
          job.salaryMax = Number.isFinite(j.salary_max) ? j.salary_max : undefined;
          job.currency = typeof j.salary_currency === 'string' ? j.salary_currency : 'AUD';
        }

        out.push(job);
      }

      if (json.results.length < PER_PAGE) break;
    }

    return out;
  },
};
