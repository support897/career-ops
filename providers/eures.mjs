// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// EURES provider — EU jobs portal with 3M+ listings across 31 countries
// API: POST https://europa.eu/eures/api/jv-searchengine/public/jv-search/search
// No auth required. Supports keyword/location/occupation/skill filters.
//
// Wire in via a `job_boards:` entry with `provider: eures`.

const API_URL = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search';

/** @type {Provider} */
export default {
  id: 'eures',

  async fetch(entry, ctx) {
    const allJobs = [];
    let page = 0;
    const pageSize = 100;
    const maxPages = 5;

    for (let p = 0; p < maxPages; p++) {
      const body = {
        keywords: entry.searchKeywords || entry.name || 'automation',
        location: entry._userLocation || '',
        page: p,
        pageSize,
        sort: 'RELEVANCE',
      };

      const json = await ctx.fetchJson(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
      });

      if (!json?.results?.length) break;

      for (const j of json.results) {
        if (!j || typeof j !== 'object') continue;
        const title = typeof j.title === 'string' ? j.title.trim() : '';
        if (!title) continue;

        const jobUrl = j.url || j.applyUrl || '';
        if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) continue;

        allJobs.push({
          title,
          url: jobUrl,
          company: j.companyName || j.employer || 'EURES',
          location: j.location || j.country || '',
        });
      }

      if (json.results.length < pageSize) break;
      page++;
    }
    return allJobs;
  },
};
