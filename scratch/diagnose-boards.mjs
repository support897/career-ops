import { readFileSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';
import indeed from '../providers/indeed.mjs';
import linkedin from '../providers/linkedin.mjs';
import seek from '../providers/seek.mjs';
import { buildTitleFilter, buildLocationFilter } from '../scan.mjs';
import yaml from 'js-yaml';

// Load config
const portalsConfig = yaml.load(readFileSync('/Users/ilse/career-ops-2/portals.yml', 'utf8'));
const titleFilter = buildTitleFilter(portalsConfig.title_filter);
const locationFilter = buildLocationFilter(portalsConfig.location_filter);

// Load scan history
const scanHistory = new Set();
if (existsSync('/Users/ilse/career-ops-2/data/scan-history.tsv')) {
  const content = readFileSync('/Users/ilse/career-ops-2/data/scan-history.tsv', 'utf8');
  content.split('\n').forEach(line => {
    const parts = line.split('\t');
    if (parts[1]) scanHistory.add(parts[1].trim()); // URL is second column usually
  });
}

function diagnose(providerName, jobs) {
  console.log(`\n=== Diagnosing ${providerName} (${jobs.length} jobs) ===`);
  jobs.forEach((job, i) => {
    const titleLower = (job.title || '').toLowerCase();
    const locLower = (job.location || '').toLowerCase();
    const passTitle = titleFilter(titleLower);
    const passLoc = locationFilter(locLower, job.url);
    const inHistory = scanHistory.has(job.url);

    console.log(`${i + 1}. Title: "${job.title}" | Location: "${job.location}"`);
    console.log(`   URL: ${job.url}`);
    console.log(`   Filters -> Title Match: ${passTitle} | Location Match: ${passLoc} | Already Scanned: ${inHistory}`);
  });
}

async function run() {
  console.log('Fetching from Indeed...');
  try {
    const jobs = await indeed.fetch({ name: 'Indeed test', scan_query: 'AI automation' });
    diagnose('Indeed', jobs);
  } catch (e) {
    console.error('Indeed failed:', e);
  }

  console.log('\nFetching from LinkedIn...');
  try {
    const jobs = await linkedin.fetch({ name: 'LinkedIn test', scan_query: 'AI automation' });
    diagnose('LinkedIn', jobs);
  } catch (e) {
    console.error('LinkedIn failed:', e);
  }

  console.log('\nFetching from SEEK...');
  try {
    const jobs = await seek.fetch({ name: 'SEEK test', scan_query: 'AI automation' });
    diagnose('SEEK', jobs);
  } catch (e) {
    console.error('SEEK failed:', e);
  }
}

run();
