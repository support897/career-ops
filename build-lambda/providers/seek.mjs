/**
 * seek.mjs — SEEK job provider using saved cookies (headless)
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
const CONFIG_PATH = join(__dirname, '../config/seek.yml');
const EMAIL_CONFIG_PATH = join(__dirname, '../config/email.yml');
const CHROME_PATH = process.env.CHROME_PATH
  || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium'
  : existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome'
  : existsSync('/ms-playwright/chromium-1228/chrome-linux/chrome') ? '/ms-playwright/chromium-1228/chrome-linux/chrome'
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

// ─── Cookie loading ────────────────────────────────────────────────────────

async function loadCookies(userId) {
  // Try DB first if userId provided
  if (userId) {
    try {
      const { getUserCookies } = await import('../lib/db-reader.mjs');
      const { decryptCookies } = await import('../lib/cookie-crypto.mjs');
      const row = await getUserCookies(userId, 'seek');
      if (row?.encrypted) {
        const cookies = decryptCookies(userId, row.encrypted);
        if (cookies && cookies.length > 0) {
          console.log(`[seek] Loaded ${cookies.length} cookies from DB for user ${userId.slice(0, 12)}...`);
          return { cookies, exportedAt: row.exportedAt, source: 'db' };
        }
      }
    } catch (e) {
      console.warn(`[seek] DB cookie load failed, falling back to file: ${e.message}`);
    }
  }

  // Fallback to local YAML file
  if (!existsSync(CONFIG_PATH)) return null;
  
  const yaml = readFileSync(CONFIG_PATH, 'utf8');
  const cookies = [];
  
  const cookieRegex = /- name:\s*"([^"]+)"\s*\n\s*value:\s*"([^"]+)"/g;
  let match;
  while ((match = cookieRegex.exec(yaml)) !== null) {
    cookies.push({ name: match[1], value: match[2], domain: '.seek.com.au' });
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
      subject: '[Career-Ops] SEEK Cookies Expired — Please Re-login',
      html: `<h2>SEEK Session Expired</h2>
        <p>Your SEEK cookies have expired.</p>
        <p><strong>To fix:</strong> Run <code>node seek-save-cookies.js</code></p>`,
    });
  } catch (err) {}
}

// ─── Headless scraping ─────────────────────────────────────────────────────

async function scrapeSEEKJobs(keywords, maxJobs = 25, userId) {
  const data = await loadCookies(userId);
  
  if (!data || data.cookies.length === 0) {
    console.log('  ⚠️  SEEK: No cookies. Run: node seek-save-cookies.js');
    return [];
  }
  
  const { valid, days } = checkCookieAge(data.exportedAt);
  if (!valid) {
    console.log(`  ❌ SEEK: Cookies expired (${days}d). Re-login needed.`);
    await sendExpirationEmail();
    return [];
  }
  
  if (days > 25) console.log(`  ⚠️  SEEK: Cookies expiring in ${30 - days} days.`);
  
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  
  try {
    const page = await browser.newPage();
    await page.setCookie(...data.cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain || '.seek.com.au', path: '/', httpOnly: true, secure: true,
    })));
    
    // SEEK search URL
    const searchUrl = `https://www.seek.com.au/${keywords.replace(/\s+/g, '-')}-jobs?daterange=7`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    await page.waitForFunction(() => {
      return document.querySelectorAll('a[href*="/job/"]').length > 0;
    }, { timeout: 15000 }).catch(() => {});
    
    if (page.url().includes('login') || page.url().includes('oauth')) {
      console.log('  ❌ SEEK: Session expired during scraping.');
      await sendExpirationEmail();
      return [];
    }
    
    const jobs = await page.evaluate((maxJobs) => {
      const links = document.querySelectorAll('a[href*="/job/"]');
      const seen = new Set();
      
      return Array.from(links).map(a => {
        const title = a.textContent.trim().substring(0, 100);
        return {
          title,
          url: a.href.split('?')[0],
        };
      }).filter(j => {
        if (!j.title || j.title.length < 5 || seen.has(j.url)) return false;
        seen.add(j.url);
        return true;
      }).slice(0, maxJobs);
    }, maxJobs);
    
    return jobs;
    
  } catch (err) {
    console.error('  ❌ SEEK:', err.message);
    return [];
  } finally {
    await browser.close();
  }
}

// ─── Provider interface ────────────────────────────────────────────────────

export default {
  id: 'seek',
  name: 'SEEK Jobs',
  
  detect(ctx) {
    return false;
  },

  async fetch(entry, ctx) {
    const keywords = entry.scan_query || entry.name || 'AI automation';
    return scrapeSEEKJobs(keywords, 25, ctx?.userId);
  },

  async apply(url, ctx) {
    return applyToJob(url, ctx?.userId, ctx?.candidateInfo || {}, ctx?.cvPath);
  },
};

// ─── Auto-apply to SEEK jobs ────────────────────────────────────────────────

async function applyToJob(url, userId, candidateInfo, cvPath) {
  const data = await loadCookies(userId);
  if (!data || data.cookies.length === 0) {
    return { success: false, error: 'No SEEK cookies available' };
  }

  const { valid } = checkCookieAge(data.exportedAt);
  if (!valid) {
    return { success: false, error: 'SEEK cookies expired' };
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.setCookie(...data.cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain || '.seek.com.au', path: '/', httpOnly: true, secure: true,
    })));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (page.url().includes('login') || page.url().includes('oauth')) {
      return { success: false, error: 'SEEK session expired — re-login needed' };
    }

    await page.waitForSelector('button[data-testid="apply-button"], a[data-testid="apply-button"], button[aria-label*="Apply"]', { timeout: 15000 }).catch(() => {});

    const applyBtn = await page.$('button[data-testid="apply-button"], a[data-testid="apply-button"], button[aria-label*="Apply"]');
    if (!applyBtn) {
      return { success: false, error: 'No Apply button found — may require external redirect' };
    }

    await applyBtn.click();
    await new Promise(r => setTimeout(r, 3000));

    const confirmationPatterns = [/thank you/i, /submitted/i, /application complete/i, /application received/i, /you.?ve applied/i];
    const nextStepSelectors = [
      'button[data-testid="submit-application"]',
      'button[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Review")',
      'button[aria-label*="Submit"]',
    ];

    for (let step = 0; step < 8; step++) {
      if (candidateInfo.email) {
        await page.evaluate((email) => {
          const inputs = document.querySelectorAll('input[name*="email"], input[type="email"], input[placeholder*="email" i]');
          inputs.forEach(i => { i.value = email; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
        }, candidateInfo.email);
      }
      if (candidateInfo.phone) {
        await page.evaluate((phone) => {
          const inputs = document.querySelectorAll('input[name*="phone"], input[type="tel"], input[placeholder*="phone" i]');
          inputs.forEach(i => { i.value = phone; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
        }, candidateInfo.phone);
      }
      if (candidateInfo.firstName) {
        await page.evaluate((name) => {
          const input = document.querySelector('input[name*="first" i], input[placeholder*="first" i]');
          if (input) { input.value = name; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
        }, candidateInfo.firstName);
      }
      if (candidateInfo.lastName) {
        await page.evaluate((name) => {
          const input = document.querySelector('input[name*="last" i], input[placeholder*="last" i]');
          if (input) { input.value = name; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
        }, candidateInfo.lastName);
      }

      if (cvPath && existsSync(cvPath)) {
        const fileInputs = await page.$$('input[type="file"]');
        for (const fi of fileInputs) {
          const visible = await fi.evaluate(el => el.offsetParent !== null).catch(() => false);
          if (visible) {
            try {
              await fi.uploadFile(cvPath);
              await new Promise(r => setTimeout(r, 2000));
            } catch {}
            break;
          }
        }
      }

      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (confirmationPatterns.some(p => p.test(pageText))) {
        return { success: true, method: 'SEEK Apply (step ' + step + ')' };
      }

      let clicked = false;
      for (const sel of nextStepSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn && await btn.isVisible().catch(() => false)) {
            await btn.click();
            clicked = true;
            break;
          }
        } catch {}
      }

      if (clicked) {
        await new Promise(r => setTimeout(r, 3000));
        const afterText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (confirmationPatterns.some(p => p.test(afterText))) {
          return { success: true, method: 'SEEK Apply' };
        }
        continue;
      }

      break;
    }

    return { success: false, error: 'Could not complete SEEK application form' };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// ─── Standalone testing ────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('seek.mjs')) {
  console.log('\n🔍 Testing SEEK provider (headless)...\n');
  
  const data = loadCookies();
  if (!data) {
    console.log('❌ No config found. Run: node seek-save-cookies.js');
    process.exit(1);
  }
  
  const { valid, days } = checkCookieAge(data.exportedAt);
  console.log(`Cookie age: ${days} days, Valid: ${valid}`);
  
  if (!valid) {
    console.log('❌ Cookies expired. Run: node seek-save-cookies.js');
    process.exit(1);
  }
  
  scrapeSEEKJobs('AI automation', 10).then(jobs => {
    console.log(`\n✅ Found ${jobs.length} jobs:\n`);
    jobs.forEach((job, i) => {
      console.log(`${i + 1}. ${job.title}`);
      console.log(`   ${job.url}\n`);
    });
  }).catch(err => console.error('❌ Error:', err.message));
}
