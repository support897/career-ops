// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Freehire provider — 2.9M+ jobs from 54+ ATS platforms, 120K+ companies
// API: GET https://freehire.dev/api/v1/jobs
// No auth required for read access. Supports faceted search.
//
// Wire in via a `job_boards:` entry with `provider: freehire`.

const API_URL = 'https://freehire.dev/api/v1/jobs';

/** @type {Provider} */
export default {
  id: 'freehire',

  async fetch(entry, ctx) {
    const allJobs = [];
    let offset = 0;
    const limit = 100;
    const maxPages = 5;

    for (let p = 0; p < maxPages; p++) {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        sort: 'relevance',
      });

      // Add keyword search
      const keywords = entry.searchKeywords || entry.name || 'automation';
      if (keywords) params.set('q', keywords);

      // Add location filter
      if (entry._userLocation) params.set('location', entry._userLocation);

      const url = `${API_URL}?${params}`;
      const json = await ctx.fetchJson(url, { redirect: 'error' });

      if (!json?.data?.length) break;

      for (const j of json.data) {
        if (!j || typeof j !== 'object') continue;
        const title = typeof j.title === 'string' ? j.title.trim() : '';
        const jobUrl = typeof j.url === 'string' ? j.url.trim() : '';
        if (!title || !jobUrl || !/^https?:\/\//i.test(jobUrl)) continue;

        allJobs.push({
          title,
          url: jobUrl,
          company: j.company?.name || j.company_name || entry.name || 'Freehire',
          location: j.location || j.remote_location || '',
          salaryMin: j.salary_min || undefined,
          salaryMax: j.salary_max || undefined,
          tags: j.skills || j.tags || [],
        });
      }

      if (json.data.length < limit) break;
      offset += limit;
    }
    return allJobs;
  },
};
