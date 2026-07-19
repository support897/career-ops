// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Findwork.dev provider — developer-focused job board
// API: GET https://findwork.dev/api/jobs/
// Free API key required — register at https://findwork.dev
// Env: FINDWORK_API_KEY
//
// Wire in via a `job_boards:` entry with `provider: findwork`.

const API_URL = 'https://findwork.dev/api/jobs/';
const PER_PAGE = 25;
const DEFAULT_MAX_PAGES = 5;
const MAX_PAGES_CAP = 20;

/** @type {Provider} */
export default {
  id: 'findwork',

  async fetch(entry, ctx) {
    const apiKey = process.env.FINDWORK_API_KEY;
    if (!apiKey) {
      throw new Error('findwork: missing FINDWORK_API_KEY env var — register at https://findwork.dev');
    }

    const keywords = entry.searchKeywords || entry.name || 'AI automation';
    const maxPages = Math.min(entry.max_pages || DEFAULT_MAX_PAGES, MAX_PAGES_CAP);
    const out = [];

    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams({
        search: keywords,
        page: String(page),
        order_by: 'relevance',
      });
      if (entry.searchLocation) params.set('location', entry.searchLocation);
      if (entry.remoteOnly) params.set('remote', 'true');

      const url = `${API_URL}?${params.toString()}`;
      const json = await ctx.fetchJson(url, {
        redirect: 'error',
        headers: { Authorization: `Token ${apiKey}` },
      });

      if (!json || !Array.isArray(json.results)) {
        throw new Error(`findwork: unexpected response on page ${page} — keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
      }

      for (const j of json.results) {
        if (!j || typeof j !== 'object' || typeof j.role !== 'string' || !j.role.trim()) continue;

        let url = '';
        const rawUrl = typeof j.url === 'string' ? j.url.trim() : '';
        if (rawUrl) {
          try {
            const parsed = new URL(rawUrl);
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href;
          } catch { /* malformed */ }
        }
        if (!url) continue;

        out.push({
          title: j.role.trim(),
          url,
          company: typeof j.company_name === 'string' && j.company_name.trim() ? j.company_name.trim()
            : (entry.name || 'Findwork'),
          location: typeof j.location === 'string' ? j.location.trim() : '',
          postedAt: j.date_posted ? new Date(j.date_posted).getTime() || undefined : undefined,
        });
      }

      if (json.results.length < PER_PAGE) break;
    }

    return out;
  },
};
