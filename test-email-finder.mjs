import { readFileSync } from 'fs';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const emailConfig = yaml.parse(readFileSync(join(__dirname, 'config/email.yml'), 'utf-8'));

async function getCompanyDomain(company, url) {
  let domain = '';
  try {
    const parsed = new URL(url);
    domain = parsed.hostname.replace(/^www\./, '');
  } catch (e) {
    domain = company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
  }
  
  const atsDomains = ['greenhouse.io', 'ashbyhq.com', 'lever.co', 'workday.com', 'smartrecruiters.com'];
  const jobBoards = ['seek.com', 'seek.com.au', 'indeed.com', 'jora.com', 'linkedin.com', 'glassdoor.com', 'apply.seek.com.au'];
  const isATS = atsDomains.some(ats => domain.includes(ats));
  const isJobBoard = jobBoards.some(board => domain.includes(board));
  
  if (isATS || isJobBoard) {
    try {
      const res = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(company)}`);
      const data = await res.json();
      if (data && data.length > 0 && data[0].domain) {
        return data[0].domain;
      }
    } catch (e) {}
    return company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
  }
  return domain;
}

console.log(await getCompanyDomain('Atlassian', 'https://seek.com.au/job/12345'));
