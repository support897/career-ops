// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Careerjet provider — global job search engine
// (https://search.api.careerjet.net). Free partner key required.
// Supports location + radius filtering, 28+ locales.
//
// Wire in via a `job_boards:` entry with `provider: careerjet`.
// Env: CAREERJET_AFFID (partner affiliate ID)

const FEED_URL = 'https://search.api.careerjet.net/search';

/** @type {Provider} */
export default {
  id: 'careerjet',

  /**
   * Fetches and normalizes postings from the Careerjet API.
   * @param {{ name?: string }} entry - The job_boards entry being processed.
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any> }} ctx - HTTP context.
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string}>>}
   */
  async fetch(entry, ctx) {
    const affid = process.env.CAREERJET_AFFID;
    if (!affid) {
      throw new Error('careerjet: missing CAREERJET_AFFID env var — register at https://www.careerjet.com/partners/api');
    }

    const allJobs = [];
    let page = 1;
    // Fetch up to 5 pages (75 jobs per page = 375 max)
    for (let p = 1; p <= 5; p++) {
      const params = new URLSearchParams({
        affid,
        keywords: 'automation OR AI OR marketing OR operations OR growth OR revops',
        location: entry.searchLocation || entry._userLocation || 'remote',
        locale_code: 'en_AU',
        sort: 'date',
        pagesize: '75',
        page: String(p),
      });

      const url = `${FEED_URL}?${params}`;
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      if (!json || !Array.isArray(json.jobs) || json.jobs.length === 0) break;

      for (const j of json.jobs) {
        if (!j || typeof j !== 'object') continue;
        const title = typeof j.title === 'string' ? j.title.trim() : '';
        const jobUrl = typeof j.url === 'string' ? j.url.trim() : '';
        if (!title || !jobUrl || !/^https?:\/\//i.test(jobUrl)) continue;

        allJobs.push({
          title,
          url: jobUrl,
          company: typeof j.company === 'string' && j.company.trim()
            ? j.company.trim()
            : (entry.name || 'Careerjet'),
          location: typeof j.locations === 'string' ? j.locations.trim() : '',
        });
      }

      if (!json.more_pages || json.jobs.length < 75) break;
    }
    return allJobs;
  },
};
