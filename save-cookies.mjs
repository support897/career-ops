#!/usr/bin/env node

/**
 * save-cookies.mjs — Log into Indeed, SEEK, LinkedIn with Playwright/Puppeteer,
 * extract cookies, encrypt with AES-256-GCM, and save to database.
 *
 * Usage: node save-cookies.mjs [--indeed] [--seek] [--linkedin] [--all] [--headed]
 *   --all      Save cookies for all platforms (default)
 *   --indeed   Save only Indeed cookies
 *   --seek     Save only SEEK cookies
 *   --linkedin Save only LinkedIn cookies
 *   --headed   Show browser window (default: headless)
 *
 * Environment: DATABASE_URL, ENCRYPTION_KEY
 */

import { chromium } from 'playwright';
import { encryptCookies, fromPlaywrightCookies } from './lib/cookie-crypto.mjs';

const USER_ID = 'user_3GfaXsz2WyxzFl0LcD4ktVnNsCS';
const INDEED_EMAIL = 'placenciailse@gmail.com';
const INDEED_PASS = '20inPG05';
const SEEK_EMAIL = 'placenciailse@gmail.com';
const SEEK_PASS = '20inPG05';
const LINKEDIN_EMAIL = 'placenciailse@gmail.com';
const LINKEDIN_PASS = '20inPG05';

const args = process.argv.slice(2);
const doIndeed = args.includes('--indeed') || args.includes('--all') || args.length === 0;
const doSeek = args.includes('--seek') || args.includes('--all') || args.length === 0;
const doLinkedin = args.includes('--linkedin') || args.includes('--all') || args.length === 0;
const headed = args.includes('--headed');

async function saveToDb(platform, encryptedCookies) {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    const rowId = `${USER_ID}-${platform}`;
    // Try update first
    const result = await pool.query(
      `UPDATE platform_settings
       SET cookies_encrypted = $3, cookies_exported_at = NOW(), cookie_status = 'active'
       WHERE user_id = $1 AND platform = $2`,
      [USER_ID, platform, encryptedCookies]
    );
    if (result.rowCount === 0) {
      // Insert new row
      await pool.query(
        `INSERT INTO platform_settings (id, user_id, platform, enabled, cookies_encrypted, cookies_exported_at, cookie_status)
         VALUES ($1, $2, $3, true, $4, NOW(), 'active')`,
        [rowId, USER_ID, platform, encryptedCookies]
      );
    }
    console.log(`  ✅ ${platform} cookies saved to DB (encrypted, user-only)`);
  } finally {
    await pool.end();
  }
}

async function saveIndeedCookies() {
  console.log('\n🍪 Logging into Indeed...');
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto('https://secure.indeed.com/auth', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Check if already logged in
    const currentUrl = page.url();
    if (currentUrl.includes('myjobs') || currentUrl.includes('dashboard')) {
      console.log('  Already logged in to Indeed!');
    } else {
      // Try email login
      const emailInput = await page.$('input[type="email"], input#email, input[name="__cap"]');
      if (emailInput) {
        await emailInput.fill(INDEED_EMAIL);
        // Click continue/next button
        const continueBtn = await page.$('button[type="submit"], #登录, button:has-text("Continue"), button:has-text("Next"), button:has-text("Sign in")');
        if (continueBtn) await continueBtn.click();
        await page.waitForTimeout(3000);

        // Try password
        const passInput = await page.$('input[type="password"], input#password, input[name="password"]');
        if (passInput) {
          await passInput.fill(INDEED_PASS);
          const signInBtn = await page.$('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")');
          if (signInBtn) await signInBtn.click();
          await page.waitForTimeout(5000);
        } else {
          console.log('  ⚠️  No password field found — Indeed may be using Google OAuth.');
          console.log('     If browser is headed, complete login manually and press Enter in terminal.');
        }
      } else {
        console.log('  ⚠️  No email field found. Page may have changed layout.');
        console.log(`     Current URL: ${page.url()}`);
      }
    }

    // Wait for navigation to settle
    await page.waitForTimeout(3000);

    // Extract all cookies
    const allCookies = await context.cookies();
    const indeedCookies = allCookies.filter(c =>
      c.domain.includes('indeed.com') || c.domain.includes('indeed')
    );

    if (indeedCookies.length === 0) {
      console.log('  ❌ No Indeed cookies captured. Login may have failed.');
      console.log(`     Current URL: ${page.url()}`);
      await browser.close();
      return false;
    }

    console.log(`  📦 Captured ${indeedCookies.length} Indeed cookies`);

    // Encrypt with per-user key
    const normalized = fromPlaywrightCookies(indeedCookies);
    const encrypted = encryptCookies(USER_ID, normalized);

    if (!encrypted) {
      console.log('  ❌ Encryption failed');
      await browser.close();
      return false;
    }

    // Save to DB
    await saveToDb('indeed', encrypted);
    await browser.close();
    return true;

  } catch (e) {
    console.log(`  ❌ Indeed error: ${e.message.slice(0, 120)}`);
    await browser.close();
    return false;
  }
}

async function saveSeekCookies() {
  console.log('\n🍪 Logging into SEEK...');
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto('https://www.seek.com.au/oauth/login', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (currentUrl.includes('my-activity') || currentUrl.includes('dashboard')) {
      console.log('  Already logged in to SEEK!');
    } else {
      // Try email login
      const emailInput = await page.$('input[type="email"], input[name="email"], input#email');
      if (emailInput) {
        await emailInput.fill(SEEK_EMAIL);
        const continueBtn = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Next"), button:has-text("Log in")');
        if (continueBtn) await continueBtn.click();
        await page.waitForTimeout(3000);

        const passInput = await page.$('input[type="password"], input[name="password"]');
        if (passInput) {
          await passInput.fill(SEEK_PASS);
          const signInBtn = await page.$('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")');
          if (signInBtn) await signInBtn.click();
          await page.waitForTimeout(5000);
        } else {
          console.log('  ⚠️  No password field found — SEEK may be using Google/Apple OAuth.');
        }
      } else {
        console.log('  ⚠️  No email field found on SEEK login page.');
        console.log(`     Current URL: ${page.url()}`);
      }
    }

    await page.waitForTimeout(3000);

    const allCookies = await context.cookies();
    const seekCookies = allCookies.filter(c =>
      c.domain.includes('seek.com.au') || c.domain.includes('seek.com')
    );

    if (seekCookies.length === 0) {
      console.log('  ❌ No SEEK cookies captured. Login may have failed.');
      console.log(`     Current URL: ${page.url()}`);
      await browser.close();
      return false;
    }

    console.log(`  📦 Captured ${seekCookies.length} SEEK cookies`);

    const normalized = fromPlaywrightCookies(seekCookies);
    const encrypted = encryptCookies(USER_ID, normalized);

    if (!encrypted) {
      console.log('  ❌ Encryption failed');
      await browser.close();
      return false;
    }

    await saveToDb('seek', encrypted);
    await browser.close();
    return true;

  } catch (e) {
    console.log(`  ❌ SEEK error: ${e.message.slice(0, 120)}`);
    await browser.close();
    return false;
  }
}

async function saveLinkedinCookies() {
  console.log('\n🍪 Logging into LinkedIn (Puppeteer Stealth)...');
  
  const puppeteer = await import('puppeteer-extra');
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
  puppeteer.default.use(StealthPlugin());
  
  const browser = await puppeteer.default.launch({
    headless: !headed,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    // Check if already logged in
    if (page.url().includes('/feed') || page.url().includes('/mynetwork')) {
      console.log('  Already logged in to LinkedIn!');
    } else {
      // Fill email
      const emailInput = await page.$('input#username, input[name="session_key"]');
      if (emailInput) {
        await emailInput.type(LINKEDIN_EMAIL, { delay: 50 });
        await page.waitForTimeout(500);
        
        // Fill password
        const passInput = await page.$('input#password, input[name="session_password"]');
        if (passInput) {
          await passInput.type(LINKEDIN_PASS, { delay: 50 });
          await page.waitForTimeout(500);
          
          // Click sign in
          const signInBtn = await page.$('button[type="submit"], button:has-text("Sign in")');
          if (signInBtn) await signInBtn.click();
          
          // Wait for navigation
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(5000);
          
          // Check if we landed on feed or got blocked
          const finalUrl = page.url();
          if (finalUrl.includes('/checkpoint') || finalUrl.includes('/challenge')) {
            console.log('  ⚠️  LinkedIn security challenge detected — manual login required');
            console.log('     Re-run with --headed to complete login manually');
          } else if (finalUrl.includes('/feed') || finalUrl.includes('/mynetwork')) {
            console.log('  ✅ LinkedIn login successful!');
          } else {
            console.log(`  ⚠️  Unexpected page: ${finalUrl}`);
          }
        } else {
          console.log('  ⚠️  No password field found');
        }
      } else {
        console.log('  ⚠️  No email field found — LinkedIn layout may have changed');
        console.log(`     Current URL: ${page.url()}`);
      }
    }
    
    await page.waitForTimeout(3000);
    
    // Extract cookies
    const allCookies = await page.cookies();
    const linkedinCookies = allCookies.filter(c =>
      c.domain.includes('linkedin.com')
    );
    
    if (linkedinCookies.length === 0) {
      console.log('  ❌ No LinkedIn cookies captured');
      await browser.close();
      return false;
    }
    
    console.log(`  📦 Captured ${linkedinCookies.length} LinkedIn cookies`);
    
    // Convert Puppeteer cookies to our format and encrypt
    const normalized = linkedinCookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires || -1,
      httpOnly: c.httpOnly || false,
      secure: c.secure || false,
      sameSite: c.sameSite || 'Lax',
    }));
    
    const encrypted = encryptCookies(USER_ID, normalized);
    if (!encrypted) {
      console.log('  ❌ Encryption failed');
      await browser.close();
      return false;
    }
    
    await saveToDb('linkedin', encrypted);
    await browser.close();
    return true;
    
  } catch (e) {
    console.log(`  ❌ LinkedIn error: ${e.message.slice(0, 120)}`);
    await browser.close();
    return false;
  }
}

async function main() {
  console.log('🔐 Saving encrypted cookies to your profile (private, per-user AES-256-GCM)');
  console.log(`   User: ${USER_ID}`);
  const platforms = [];
  if (doIndeed) platforms.push('Indeed');
  if (doSeek) platforms.push('SEEK');
  if (doLinkedin) platforms.push('LinkedIn');
  console.log(`   Platforms: ${platforms.join(', ')}`);
  console.log(`   Mode: ${headed ? 'headed (visible browser)' : 'headless'}`);

  const results = {};

  if (doIndeed) {
    results.indeed = await saveIndeedCookies();
  }
  if (doSeek) {
    results.seek = await saveSeekCookies();
  }
  if (doLinkedin) {
    results.linkedin = await saveLinkedinCookies();
  }

  console.log('\n📊 Summary:');
  for (const [platform, ok] of Object.entries(results)) {
    console.log(`   ${ok ? '✅' : '❌'} ${platform}`);
  }
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
