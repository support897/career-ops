/**
 * linkedin.mjs — LinkedIn job provider using Puppeteer Stealth (headless)
 * 
 * Uses puppeteer-extra with stealth plugin to bypass LinkedIn's bot detection.
 * Runs completely in background — no browser window, no user interaction.
 * 
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
const CONFIG_PATH = join(__dirname, '../config/linkedin.yml');
const EMAIL_CONFIG_PATH = join(__dirname, '../config/email.yml');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ─── Cookie loading ────────────────────────────────────────────────────────

async function loadCookies(userId) {
  // Try DB first if userId provided
  if (userId) {
    try {
      const { getUserCookies } = await import('../lib/db-reader.mjs');
      const { decryptCookies } = await import('../lib/cookie-crypto.mjs');
      const row = await getUserCookies(userId, 'linkedin');
      if (row?.encrypted) {
        const cookies = decryptCookies(userId, row.encrypted);
        if (cookies && cookies.length > 0) {
          console.log(`[linkedin] Loaded ${cookies.length} cookies from DB for user ${userId.slice(0, 12)}...`);
          return { cookies, exportedAt: row.exportedAt, source: 'db' };
        }
      }
    } catch (e) {
      console.warn(`[linkedin] DB cookie load failed, falling back to file: ${e.message}`);
    }
  }

  // Fallback to local YAML file
  if (!existsSync(CONFIG_PATH)) return null;
  
  const yaml = readFileSync(CONFIG_PATH, 'utf8');
  const cookies = [];
  
  const cookieRegex = /- name:\s*"([^"]+)"\s*\n\s*value:\s*"([^"]+)"/g;
  let match;
  while ((match = cookieRegex.exec(yaml)) !== null) {
    cookies.push({ name: match[1], value: match[2], domain: '.linkedin.com' });
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
      auth: {
        user: userMatch[1],
        pass: passMatch[1],
      },
    });
    
    await transporter.sendMail({
      from: `"Career-Ops" <${userMatch[1]}>`,
      to: userMatch[1],
      subject: '[Career-Ops] LinkedIn Cookies Expired — Please Re-login',
      html: `
        <h2>LinkedIn Session Expired</h2>
        <p>Your LinkedIn cookies have expired. The system can no longer scrape LinkedIn job listings.</p>
        <p><strong>To fix this:</strong></p>
        <ol>
          <li>Open terminal in the career-ops folder</li>
          <li>Run: <code>node linkedin-auto-save.js</code></li>
          <li>Log in to LinkedIn in the browser window</li>
          <li>Wait for "Cookies saved" message</li>
        </ol>
        <p>This takes about 30 seconds. The system will automatically use the new cookies.</p>
        <hr>
        <p><small>— Career-Ops Automation</small></p>
      `,
    });
    
    console.log('📧 Expiration email sent');
  } catch (err) {
    // Silent fail on email
  }
}

// ─── Headless scraping with Puppeteer Stealth ──────────────────────────────

async function scrapeLinkedInJobs(keywords, maxJobs = 25, userId) {
  const data = await loadCookies(userId);
  
  if (!data || data.cookies.length === 0) {
    console.log('  ⚠️  LinkedIn: No cookies. Run: node linkedin-auto-save.js');
    return [];
  }
  
  const { valid, days } = checkCookieAge(data.exportedAt);
  
  if (!valid) {
    console.log(`  ❌ LinkedIn: Cookies expired (${days}d). Re-login needed.`);
    await sendExpirationEmail();
    return [];
  }
  
  if (days > 25) {
    console.log(`  ⚠️  LinkedIn: Cookies expiring in ${30 - days} days.`);
  }
  
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // Inject saved cookies
    await page.setCookie(...data.cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.linkedin.com',
      path: '/',
      httpOnly: true,
      secure: true,
    })));
    
    // Build search URL
    const params = new URLSearchParams({
      keywords,
      f_WT: '2',         // Remote
      f_TPR: 'r604800',  // Last 7 days
      sortBy: 'DD',      // Date Descending
    });
    
    const url = `https://www.linkedin.com/jobs/search/?${params}`;
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Wait for SPA to render job cards
    await page.waitForFunction(() => {
      return document.querySelectorAll('a[href*="/jobs/view/"]').length > 0 ||
             document.querySelector('.jobs-search-no-results') !== null;
    }, { timeout: 30000 }).catch(() => {});
    
    // Check if redirected to login
    if (page.url().includes('/login') || page.url().includes('checkpoint') || page.url().includes('authwall')) {
      console.log('  ❌ LinkedIn: Session expired during scraping.');
      await sendExpirationEmail();
      return [];
    }
    
    // Scrape jobs
    const jobs = await page.evaluate((maxJobs) => {
      const links = document.querySelectorAll('a[href*="/jobs/view/"]');
      const seen = new Set();
      
      return Array.from(links)
        .map(a => {
          // Clean up title (LinkedIn duplicates text)
          let title = a.textContent.trim();
          const half = Math.floor(title.length / 2);
          if (title.length > 4 && title.substring(0, half) === title.substring(half)) {
            title = title.substring(0, half);
          }
          
          return {
            title: title,
            url: a.href.split('?')[0],
          };
        })
        .filter(j => {
          if (!j.title || seen.has(j.url)) return false;
          seen.add(j.url);
          return true;
        })
        .slice(0, maxJobs);
    }, maxJobs);
    
    return jobs;
    
  } catch (err) {
    if (err.message.includes('timeout')) {
      console.log('  ⚠️  LinkedIn: Scraping timeout.');
    } else {
      console.error('  ❌ LinkedIn:', err.message);
    }
    return [];
  } finally {
    await browser.close();
  }
}

// ─── Provider interface (default export for registry) ─────────────────────

export default {
  id: 'linkedin',
  name: 'LinkedIn Jobs',
  
  detect(ctx) {
    // Cookie-based provider should only run on portal entries that explicitly
    // set `provider: linkedin`. URL auto-detection is never safe because most
    // company pages are not LinkedIn job listings.
    return false;
  },

  async fetch(entry, ctx) {
    const keywords = entry.scan_query || entry.name || 'AI automation';
    return scrapeLinkedInJobs(keywords, 25, ctx?.userId);
  },
};

// ─── Standalone testing ────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('linkedin.mjs')) {
  console.log('\n🔍 Testing LinkedIn provider (headless)...\n');
  
  const data = loadCookies();
  if (!data) {
    console.log('❌ No config found. Run: node linkedin-auto-save.js');
    process.exit(1);
  }
  
  const { valid, days } = checkCookieAge(data.exportedAt);
  console.log(`Cookie age: ${days} days, Valid: ${valid}`);
  
  if (!valid) {
    console.log('❌ Cookies expired. Run: node linkedin-auto-save.js');
    process.exit(1);
  }
  
  scrapeLinkedInJobs('AI automation', 10).then(jobs => {
    console.log(`\n✅ Found ${jobs.length} jobs:\n`);
    jobs.forEach((job, i) => {
      console.log(`${i + 1}. ${job.title}`);
      console.log(`   ${job.url}\n`);
    });
  }).catch(err => {
    console.error('❌ Error:', err.message);
  });
}
