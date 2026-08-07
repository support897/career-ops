// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Jora Australia Provider — https://au.jora.com
// Zero-token HTTP search scraper for Jora Australia jobs.

/** @type {Provider} */
export default {
  id: 'jora',

  async fetch(entry, ctx) {
    const jobs = [];
    const query = entry.query || 'remote';
    const location = entry.location || 'Australia';
    
    const searchUrl = `https://au.jora.com/j?q=${encodeURIComponent(query)}&l=${encodeURIComponent(location)}`;
    
    try {
      const res = await ctx.fetchText(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      });
      if (!res) return jobs;

      const seenUrls = new Set();
      // Match job links of pattern /job/{slug}-{id}
      const matches = res.matchAll(/href="(\/job\/[a-zA-Z0-9_-]+-[a-f0-9]{32}\?[^"]+)"/g);
      for (const m of matches) {
        const rawHref = m[1].replace(/&amp;/g, '&');
        const cleanPath = rawHref.split('?')[0];
        if (seenUrls.has(cleanPath)) continue;
        seenUrls.add(cleanPath);

        // Derive title from job URL slug
        const slug = cleanPath.replace(/\/job\//, '').replace(/-[a-f0-9]{32}$/, '');
        const title = slug.replace(/-/g, ' ').trim();
        const fullUrl = `https://au.jora.com${cleanPath}`;

        if (title && fullUrl) {
          jobs.push({
            title,
            url: fullUrl,
            company: entry.name || 'Jora',
            location,
          });
        }
      }
    } catch (e) {
      console.error(`[Jora Provider] Error fetching query "${query}":`, e.message);
    }

    return jobs;
  },
};
