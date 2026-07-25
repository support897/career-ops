// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Himalayas provider — remote job board with transparent salary data
// (https://himalayas.app/jobs/api). No auth required.
// Returns jobs with salary ranges, company size, and tech stack.
//
// Wire in via a `job_boards:` entry with `provider: himalayas`.

const FEED_URL = 'https://himalayas.app/jobs/api';

/** @type {Provider} */
export default {
  id: 'himalayas',

  /**
   * Fetches and normalizes postings from the Himalayas public feed.
   * @param {{ name?: string }} entry - The job_boards entry being processed.
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any> }} ctx - HTTP context.
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string}>>}
   */
  async fetch(entry, ctx) {
    const allJobs = [];
    let offset = 0;
    const limit = 100;
    // Fetch up to 1000 jobs (10 pages)
    for (let page = 0; page < 10; page++) {
      const url = `${FEED_URL}?offset=${offset}&limit=${limit}`;
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      if (!json || !Array.isArray(json.jobs) || json.jobs.length === 0) break;

      for (const j of json.jobs) {
        if (!j || typeof j !== 'object') continue;
        const title = typeof j.title === 'string' ? j.title.trim() : '';
        // Himalayas uses applicationLink, not url
        const jobUrl = typeof j.applicationLink === 'string' ? j.applicationLink.trim()
          : typeof j.url === 'string' ? j.url.trim() : '';
        if (!title || !jobUrl || !/^https?:\/\//i.test(jobUrl)) continue;

        // Himalayas uses locationRestrictions array, not location string
        const locs = Array.isArray(j.locationRestrictions) ? j.locationRestrictions : [];
        const location = locs.length > 0 ? locs.join(', ') : '';

        allJobs.push({
          title,
          url: jobUrl,
          company: typeof j.companyName === 'string' && j.companyName.trim()
            ? j.companyName.trim()
            : (entry.name || 'Himalayas'),
          location,
          salaryMin: typeof j.minSalary === 'number' ? j.minSalary : undefined,
          salaryMax: typeof j.maxSalary === 'number' ? j.maxSalary : undefined,
          tags: Array.isArray(j.categories) ? j.categories : [],
        });
      }

      if (json.jobs.length < limit) break;
      offset += limit;
    }
    return allJobs;
  },
};
