// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Jooble provider — meta-search engine aggregating 1,000+ job boards
// API: POST https://jooble.org/api/{API_KEY}
// Free API key (GUID) required — register at https://jooble.org/api
// Env: JOOBLE_API_KEY
//
// Wire in via a `job_boards:` entry with `provider: jooble`.

const API_BASE = 'https://jooble.org/api';

/** @type {Provider} */
export default {
  id: 'jooble',

  async fetch(entry, ctx) {
    const apiKey = process.env.JOOBLE_API_KEY;
    if (!apiKey) {
      throw new Error('jooble: missing JOOBLE_API_KEY env var — register at https://jooble.org/api');
    }

    const keywords = entry.searchKeywords || entry.name || 'AI automation';
    const location = entry.searchLocation || entry._userLocation || '';

    const body = { keywords, location, page: 1 };

    const res = await fetch(`${API_BASE}/${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`jooble: HTTP ${res.status}`);
    }

    const json = await res.json();
    if (!json || !Array.isArray(json.jobs)) {
      throw new Error(`jooble: unexpected response — expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
    }

    return json.jobs
      .filter(j => j && typeof j === 'object' && typeof j.title === 'string' && j.title.trim())
      .map(j => {
        let url = '';
        const rawUrl = typeof j.link === 'string' ? j.link.trim() : '';
        if (rawUrl) {
          try {
            const parsed = new URL(rawUrl);
            if (parsed.protocol === 'https:') url = parsed.href;
          } catch { /* malformed */ }
        }
        if (!url) return null;

        return {
          title: j.title.trim(),
          url,
          company: typeof j.company === 'string' && j.company.trim() ? j.company.trim() : (entry.name || 'Jooble'),
          location: typeof j.location === 'string' ? j.location.trim() : '',
          postedAt: j.date ? new Date(j.date).getTime() || undefined : undefined,
        };
      })
      .filter(Boolean);
  },
};
