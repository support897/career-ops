// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// MeetFrank provider — AI-optimized job feed
// API: GET https://api.meetfrank.com/ai/jobs
// No auth needed. Returns JSON or Markdown. Designed for agents.
// Supports: keyword, city, country, remote, skills, seniority filters.
//
// Wire in via a `job_boards:` entry with `provider: meetfrank`.

const FEED_URL = 'https://api.meetfrank.com/ai/jobs';

/** @type {Provider} */
export default {
  id: 'meetfrank',

  async fetch(entry, ctx) {
    const params = new URLSearchParams();
    const keywords = entry.searchKeywords || entry.name || 'AI automation';
    if (keywords) params.set('keyword', keywords);
    if (entry.searchCity) params.set('city', entry.searchCity);
    if (entry.searchCountry) params.set('country', entry.searchCountry);
    if (entry.remoteOnly) params.set('remote', 'true');
    if (entry.searchSeniority) params.set('seniority', entry.searchSeniority);

    const url = `${FEED_URL}?${params.toString()}`;
    const text = await ctx.fetchText(url, { redirect: 'error' });

    if (!text || !text.trim()) throw new Error('meetfrank: empty response');

    // Try JSON first
    let jobs;
    try {
      const json = JSON.parse(text);
      jobs = Array.isArray(json) ? json : Array.isArray(json.jobs) ? json.jobs : [];
    } catch {
      // Not JSON — might be Markdown format, skip
      throw new Error('meetfrank: response is not valid JSON — API may have changed');
    }

    return jobs
      .filter(j => j && typeof j === 'object' && typeof j.title === 'string' && j.title.trim())
      .map(j => {
        let url = '';
        const rawUrl = typeof j.applyUrl === 'string' ? j.applyUrl.trim()
          : typeof j.url === 'string' ? j.url.trim()
          : typeof j.link === 'string' ? j.link.trim()
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
            : (entry.name || 'MeetFrank'),
          location: typeof j.location === 'string' ? j.location.trim()
            : typeof j.city === 'string' ? j.city.trim()
            : '',
          postedAt: j.posted_at ? new Date(j.posted_at).getTime() || undefined
            : j.created_at ? new Date(j.created_at).getTime() || undefined
            : undefined,
        };
      })
      .filter(Boolean);
  },
};
