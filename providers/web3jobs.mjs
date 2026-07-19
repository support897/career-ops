// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Web3 Jobs provider — crypto/blockchain/Web3 remote jobs
// API: GET https://web3.career/web3-jobs-api
// No auth required. Returns JSON array of jobs.
//
// Wire in via a `job_boards:` entry with `provider: web3jobs`.

const API_URL = 'https://web3.career/web3-jobs-api';

/** @type {Provider} */
export default {
  id: 'web3jobs',

  async fetch(entry, ctx) {
    const json = await ctx.fetchJson(API_URL, { redirect: 'error' });
    if (!Array.isArray(json)) {
      throw new Error(`web3jobs: unexpected response — expected array, got ${typeof json}`);
    }

    return json
      .filter(j => j && typeof j === 'object'
        && typeof j.title === 'string' && j.title.trim()
        && typeof j.url === 'string' && /^https?:\/\//i.test(j.url.trim()))
      .map(j => ({
        title: j.title.trim(),
        url: j.url.trim(),
        company: j.company_name || j.company || entry.name || 'Web3 Jobs',
        location: j.location || j.remote ? 'Remote' : '',
        tags: j.tags || [],
        salaryMin: j.salary_min || undefined,
        salaryMax: j.salary_max || undefined,
      }));
  },
};
