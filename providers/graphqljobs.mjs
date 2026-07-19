// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// GraphQL Jobs provider — dev/remote jobs via GraphQL API
// (https://graphql.jobs). No auth required.
// Returns dev-focused remote jobs with company info.
//
// Wire in via a `job_boards:` entry with `provider: graphqljobs`.

const FEED_URL = 'https://graphql.jobs';

/** @type {Provider} */
export default {
  id: 'graphqljobs',

  /**
   * Fetches and normalizes postings from the GraphQL Jobs API.
   * @param {{ name?: string }} entry - The job_boards entry being processed.
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual', method?: string, body?: string, headers?: Record<string,string> }) => Promise<any> }} ctx - HTTP context.
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string}>>}
   */
  async fetch(entry, ctx) {
    const query = `{
      jobs(first: 100) {
        edges {
          node {
            id
            title
            slug
            url
            remote
            tags { name }
            company {
              name
              slug
            }
            cities { name }
            countries { name }
          }
        }
      }
    }`;

    const json = await ctx.fetchJson(FEED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      redirect: 'error',
    });

    if (!json?.data?.jobs?.edges) {
      throw new Error(`graphqljobs: unexpected response — ${JSON.stringify(Object.keys(json || {}))}`);
    }

    const jobs = [];
    for (const edge of json.data.jobs.edges) {
      const j = edge?.node;
      if (!j || typeof j !== 'object') continue;

      const title = typeof j.title === 'string' ? j.title.trim() : '';
      if (!title) continue;

      // Build URL from slug
      const jobUrl = j.url || (j.slug ? `https://graphql.jobs/j/${j.slug}` : '');
      if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) continue;

      // Build location string
      const cities = Array.isArray(j.cities) ? j.cities.map(c => c.name).filter(Boolean) : [];
      const countries = Array.isArray(j.countries) ? j.countries.map(c => c.name).filter(Boolean) : [];
      const location = j.remote ? `Remote (${[...cities, ...countries].join(', ') || 'Worldwide'})` : [...cities, ...countries].join(', ');

      jobs.push({
        title,
        url: jobUrl,
        company: j.company?.name || entry.name || 'GraphQL Jobs',
        location,
        tags: Array.isArray(j.tags) ? j.tags.map(t => t.name).filter(Boolean) : [],
      });
    }
    return jobs;
  },
};
