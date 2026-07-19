// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Jobicy provider — remote job aggregator with salary data
// (https://jobicy.com/api/v2/remote-jobs). No auth required.
// Supports geo filtering by country code.
//
// Wire in via a `job_boards:` entry with `provider: jobicy`.

const FEED_URL = 'https://jobicy.com/api/v2/remote-jobs';

/** @type {Provider} */
export default {
  id: 'jobicy',

  /**
   * Fetches and normalizes postings from the Jobicy public feed.
   * @param {{ name?: string }} entry - The job_boards entry being processed.
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any> }} ctx - HTTP context.
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string}>>}
   */
  async fetch(entry, ctx) {
    // No pagination — API returns up to 100 jobs per request
    let url = `${FEED_URL}?count=100`;
    // Jobicy supports geo filtering by country code (e.g. "AU", "US", "GB")
    if (entry._userLocation) {
      // Extract country from location string (e.g. "Gold Coast, Australia" → "AU")
      const countryMap = { 'australia': 'AU', 'united states': 'US', 'united kingdom': 'GB', 'canada': 'CA', 'germany': 'DE', 'france': 'FR', 'netherlands': 'NL', 'singapore': 'SG', 'brazil': 'BR', 'india': 'IN' };
      const locLower = entry._userLocation.toLowerCase();
      for (const [name, code] of Object.entries(countryMap)) {
        if (locLower.includes(name)) { url += `&geo=${code}`; break; }
      }
    }
    const json = await ctx.fetchJson(url, { redirect: 'error' });
    if (!json || !Array.isArray(json.jobs)) {
      throw new Error(`jobicy: unexpected response — keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
    }

    return json.jobs
      .filter(j => j && typeof j === 'object'
        && typeof j.jobTitle === 'string' && j.jobTitle.trim() !== ''
        && typeof j.url === 'string' && /^https?:\/\//i.test(j.url.trim()))
      .map(j => ({
        title: j.jobTitle.trim(),
        url: j.url.trim(),
        company: typeof j.companyName === 'string' && j.companyName.trim()
          ? j.companyName.trim()
          : (entry.name || 'Jobicy'),
        location: typeof j.jobGeo === 'string' ? j.jobGeo.trim() : '',
        salaryMin: typeof j.annualSalaryMin === 'number' ? j.annualSalaryMin : undefined,
        salaryMax: typeof j.annualSalaryMax === 'number' ? j.annualSalaryMax : undefined,
        tags: Array.isArray(j.jobType) ? j.jobType : [],
      }));
  },
};
