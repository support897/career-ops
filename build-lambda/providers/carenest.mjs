// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// CareerNest provider — remote jobs aggregator (1.5M+ jobs, 190+ countries)
// API: GET https://careernest.cloud/api/feed
// No auth needed. Supports keyword search, country, type filters.
//
// Wire in via a `job_boards:` entry with `provider: carenest`.

const FEED_URL = 'https://careernest.cloud/api/feed';

/** @type {Provider} */
export default {
  id: 'carenest',

  async fetch(entry, ctx) {
    const params = new URLSearchParams();
    const keywords = entry.searchKeywords || entry.name || 'AI automation';
    if (keywords) params.set('keyword', keywords);
    if (entry.searchCountry) params.set('country', entry.searchCountry);
    if (entry.searchType) params.set('type', entry.searchType);
    params.set('limit', String(entry.pageSize || 100));

    const url = `${FEED_URL}?${params.toString()}`;
    const json = await ctx.fetchJson(url, { redirect: 'error' });

    if (!json) throw new Error('carenest: null response');

    // Response may be { jobs: [...] } or a direct array
    const jobs = Array.isArray(json) ? json : Array.isArray(json.jobs) ? json.jobs : [];
    if (jobs.length === 0) {
      throw new Error(`carenest: unexpected response — keys: [${Object.keys(json).join(', ')}]`);
    }

    return jobs
      .filter(j => j && typeof j === 'object' && typeof j.title === 'string' && j.title.trim())
      .map(j => {
        let url = '';
        const rawUrl = typeof j.url === 'string' ? j.url.trim()
          : typeof j.link === 'string' ? j.link.trim()
          : typeof j.apply_url === 'string' ? j.apply_url.trim()
          : '';
        if (rawUrl) {
          try {
            const parsed = new URL(rawUrl);
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href;
          } catch { /* malformed */ }
        }
        if (!url) return null;

        return {
          title: j.title.trim(),
          url,
          company: typeof j.company === 'string' && j.company.trim() ? j.company.trim()
            : typeof j.company_name === 'string' && j.company_name.trim() ? j.company_name.trim()
            : (entry.name || 'CareerNest'),
          location: typeof j.location === 'string' ? j.location.trim() : '',
          postedAt: j.posted_at ? new Date(j.posted_at).getTime() || undefined
            : j.created_at ? new Date(j.created_at).getTime() || undefined
            : undefined,
        };
      })
      .filter(Boolean);
  },
};
