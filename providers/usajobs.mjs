// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// USAJobs provider — US federal government job listings
// API: GET https://data.usajobs.gov/api/Search
// Free API key required — register at developer.usajobs.gov
// Env: USAJOBS_API_KEY, USAJOBS_USER_AGENT (email)
//
// Wire in via a `job_boards:` entry with `provider: usajobs`.

const API_URL = 'https://data.usajobs.gov/api/Search';

/** @type {Provider} */
export default {
  id: 'usajobs',

  async fetch(entry, ctx) {
    const apiKey = process.env.USAJOBS_API_KEY;
    const userAgent = process.env.USAJOBS_USER_AGENT || 'career-ops@ilseplacencia.shop';
    if (!apiKey) {
      throw new Error('usajobs: missing USAJOBS_API_KEY env var — register at https://developer.usajobs.gov');
    }

    const params = new URLSearchParams({
      Keyword: entry.searchKeywords || entry.name || 'automation',
      ResultsPerPage: '100',
      Page: '1',
    });

    const url = `${API_URL}?${params}`;
    const json = await ctx.fetchJson(url, {
      redirect: 'error',
      headers: {
        'Authorization-Key': apiKey,
        'User-Agent': userAgent,
        'Host': 'data.usajobs.gov',
      },
    });

    if (!json?.SearchResult?.SearchResultItems) {
      throw new Error(`usajobs: unexpected response — ${JSON.stringify(Object.keys(json || {}))}`);
    }

    return json.SearchResult.SearchResultItems
      .filter(j => j?.MatchedObjectDescriptor)
      .map(j => {
        const d = j.MatchedObjectDescriptor;
        return {
          title: d.PositionTitle || '',
          url: d.PositionURI || d.ApplyURI?.[0] || '',
          company: d.OrganizationName || 'USAJobs',
          location: [d.PositionLocation?.CityName, d.PositionLocation?.CountrySubDivisionCode].filter(Boolean).join(', ') || '',
        };
      })
      .filter(j => j.title && j.url && /^https?:\/\//i.test(j.url));
  },
};
