/**
 * indeed.mjs — Indeed job provider using saved cookies (headless)
 * 
 * Uses Puppeteer Stealth with saved session cookies for headless scraping.
 * Cookie expiration triggers email notification.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import nodemailer from 'nodemailer';

puppeteer.use(StealthPlugin());

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../config/indeed.yml');
const EMAIL_CONFIG_PATH = join(__dirname, '../config/email.yml');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ─── Cookie loading ────────────────────────────────────────────────────────

async function loadCookies(userId) {
  // Try DB first if userId provided
  if (userId) {
    try {
      const { getUserCookies } = await import('../lib/db-reader.mjs');
      const { decryptCookies } = await import('../lib/cookie-crypto.mjs');
      const row = await getUserCookies(userId, 'indeed');
      if (row?.encrypted) {
        const cookies = decryptCookies(userId, row.encrypted);
        if (cookies && cookies.length > 0) {
          console.log(`[indeed] Loaded ${cookies.length} cookies from DB for user ${userId.slice(0, 12)}...`);
          return { cookies, exportedAt: row.exportedAt, source: 'db' };
        }
      }
    } catch (e) {
      console.warn(`[indeed] DB cookie load failed, falling back to file: ${e.message}`);
    }
  }

  // Fallback to local YAML file
  if (!existsSync(CONFIG_PATH)) return null;
  
  const yaml = readFileSync(CONFIG_PATH, 'utf8');
  const cookies = [];
  
  const cookieRegex = /- name:\s*"([^"]+)"\s*\n\s*value:\s*"([^"]+)"/g;
  let match;
  while ((match = cookieRegex.exec(yaml)) !== null) {
    cookies.push({ name: match[1], value: match[2], domain: '.indeed.com' });
  }
  
  const exportedMatch = yaml.match(/exportedAt:\s*"([^"]+)"/);
  const exportedAt = exportedMatch?.[1] ? new Date(exportedMatch[1]) : null;
  
  return { cookies, exportedAt, source: 'file' };
}

function checkCookieAge(exportedAt) {
  if (!exportedAt) return { valid: false, days: -1 };
  const age = Date.now() - exportedAt.getTime();
  const days = Math.round(age / (24 * 60 * 60 * 1000));
  return { valid: days < 30, days };
}

// ─── Expiration email ──────────────────────────────────────────────────────

async function sendExpirationEmail() {
  try {
    if (!existsSync(EMAIL_CONFIG_PATH)) return;
    const emailConfig = readFileSync(EMAIL_CONFIG_PATH, 'utf8');
    const userMatch = emailConfig.match(/user:\s*"([^"]+)"/);
    const passMatch = emailConfig.match(/app_password:\s*"([^"]+)"/);
    if (!userMatch || !passMatch) return;
    
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: userMatch[1], pass: passMatch[1] },
    });
    
    await transporter.sendMail({
      from: `"Career-Ops" <${userMatch[1]}>`,
      to: userMatch[1],
      subject: '[Career-Ops] Indeed Cookies Expired — Please Re-login',
      html: `<h2>Indeed Session Expired</h2>
        <p>Your Indeed cookies have expired.</p>
        <p><strong>To fix:</strong> Run <code>node indeed-save-cookies.js</code></p>`,
    });
  } catch (err) {}
}

// ─── Headless scraping ─────────────────────────────────────────────────────

async function scrapeIndeedJobs(keywords, maxJobs = 25, userId) {
  const data = await loadCookies(userId);
  
  if (!data || data.cookies.length === 0) {
    console.log('  ⚠️  Indeed: No cookies. Run: node indeed-save-cookies.js');
    return [];
  }
  
  const { valid, days } = checkCookieAge(data.exportedAt);
  if (!valid) {
    console.log(`  ❌ Indeed: Cookies expired (${days}d). Re-login needed.`);
    await sendExpirationEmail();
    return [];
  }
  
  if (days > 25) console.log(`  ⚠️  Indeed: Cookies expiring in ${30 - days} days.`);
  
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  
  try {
    const page = await browser.newPage();
    await page.setCookie(...data.cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain || '.indeed.com', path: '/', httpOnly: true, secure: true,
    })));
    
    const params = new URLSearchParams({ q: keywords, l: 'Remote', fromage: '7' });
    await page.goto(`https://www.indeed.com/jobs?${params}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    await page.waitForFunction(() => {
      return document.querySelectorAll('.jobsearch-ResultsList li, .resultContent').length > 0;
    }, { timeout: 15000 }).catch(() => {});
    
    if (page.url().includes('auth')) {
      console.log('  ❌ Indeed: Session expired during scraping.');
      await sendExpirationEmail();
      return [];
    }
    
    const jobs = await page.evaluate((maxJobs) => {
      const cards = document.querySelectorAll('.jobsearch-ResultsList li, .resultContent');
      const seen = new Set();
      
      return Array.from(cards).slice(0, maxJobs).map(card => {
        const titleEl = card.querySelector('h2 a, .jobTitle a');
        const companyEl = card.querySelector('.companyName, .company');
        const locationEl = card.querySelector('.companyLocation');
        
        return {
          title: titleEl?.textContent?.trim() || '',
          company: companyEl?.textContent?.trim() || '',
          url: titleEl?.href?.split('?')[0] || '',
          location: locationEl?.textContent?.trim() || 'Remote',
        };
      }).filter(j => {
        if (!j.title || !j.url || seen.has(j.url)) return false;
        seen.add(j.url);
        return true;
      });
    }, maxJobs);
    
    return jobs;
    
  } catch (err) {
    console.error('  ❌ Indeed:', err.message);
    return [];
  } finally {
    await browser.close();
  }
}

// ─── Provider interface ────────────────────────────────────────────────────

export default {
  id: 'indeed',
  name: 'Indeed Jobs',
  
  detect(ctx) {
    // Cookie-based provider should only run on portal entries that explicitly
    // set `provider: indeed`. URL auto-detection is never safe here.
    return false;
  },

  async fetch(entry, ctx) {
    const keywords = entry.scan_query || entry.name || 'AI automation';
    return scrapeIndeedJobs(keywords, 25, ctx?.userId);
  },
};

// ─── Standalone testing ────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('indeed.mjs')) {
  console.log('\n🔍 Testing Indeed provider (headless)...\n');
  
  const data = loadCookies();
  if (!data) {
    console.log('❌ No config found. Run: node indeed-save-cookies.js');
    process.exit(1);
  }
  
  const { valid, days } = checkCookieAge(data.exportedAt);
  console.log(`Cookie age: ${days} days, Valid: ${valid}`);
  
  if (!valid) {
    console.log('❌ Cookies expired. Run: node indeed-save-cookies.js');
    process.exit(1);
  }
  
  scrapeIndeedJobs('AI automation', 10).then(jobs => {
    console.log(`\n✅ Found ${jobs.length} jobs:\n`);
    jobs.forEach((job, i) => {
      console.log(`${i + 1}. ${job.title} at ${job.company}`);
      console.log(`   ${job.url}\n`);
    });
  }).catch(err => console.error('❌ Error:', err.message));
}
