#!/usr/bin/env node

/**
 * easy-apply.mjs — Automated Easy Apply for Indeed and SEEK
 * 
 * Logs into job boards, finds Easy Apply options, fills forms, uploads resume.
 * Falls back to company website when Easy Apply isn't available.
 * 
 * Usage: node easy-apply.mjs <url> [--cv path] [--dry-run]
 * Output: JSON with success, method used, and confirmation details
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const url = args.find(a => a.startsWith('http'));
const DRY_RUN = args.includes('--dry-run');
const cvFlag = args.includes('--cv') ? args[args.indexOf('--cv') + 1] : null;

if (!url) {
  console.error('Usage: node easy-apply.mjs <url> [--cv path] [--dry-run]');
  process.exit(1);
}

// ─── Config ────────────────────────────────────────────────────────────────

function loadYAML(path) {
  const full = join(__dirname, path);
  if (!existsSync(full)) return null;
  return yaml.parse(readFileSync(full, 'utf8'));
}

const emailConfig = loadYAML('config/email.yml');
const profile = loadYAML('config/profile.yml');

const C = {
  firstName: profile?.candidate?.full_name?.split(' ')[0] || 'Ilse',
  lastName: profile?.candidate?.full_name?.split(' ').slice(1).join(' ') || 'Placencia',
  fullName: profile?.candidate?.full_name || 'Ilse Placencia',
  email: profile?.candidate?.email || 'placenciailse@gmail.com',
  phone: profile?.candidate?.phone || '+61498570497',
  linkedin: profile?.candidate?.linkedin || '',
  website: profile?.candidate?.portfolio_url || 'https://www.ilseplacencia.shop',
  location: profile?.candidate?.location || 'Gold Coast, QLD, Australia',
  salary: profile?.compensation?.target_range || 'Market rate',
};

// ─── Job Board Detector ────────────────────────────────────────────────────

function detectJobBoard(url) {
  const u = url.toLowerCase();
  if (u.includes('indeed.com')) return 'indeed';
  if (u.includes('seek.com.au') || u.includes('seek.co.nz')) return 'seek';
  return 'unknown';
}

// ─── Find Latest CV ────────────────────────────────────────────────────────

function findLatestFile(dir, pattern) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter(f => pattern.test(f))
    .sort()
    .reverse();
  return files.length > 0 ? join(dir, files[0]) : null;
}

// ─── Indeed Easy Apply ─────────────────────────────────────────────────────

async function indeedEasyApply(page, cvPath) {
  console.log('   🔍 Attempting Indeed Easy Apply...');
  
  const credentials = emailConfig?.job_boards?.indeed;
  if (!credentials) {
    console.log('   ⚠️  No Indeed credentials found in config/email.yml');
    return { success: false, method: 'none', error: 'No credentials' };
  }

  // Check if already logged in
  const isLoggedIn = await page.$('button[data-testid="user-menu"]') || 
                     await page.$('[data-testid="signed-in"]') ||
                     await page.$('nav[aria-label="User menu"]');
  
  if (!isLoggedIn) {
    console.log('   🔐 Logging into Indeed...');
    
    // Navigate to Indeed sign-in
    await page.goto('https://secure.indeed.com/auth', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    // Check if Google login is needed
    const googleBtn = await page.$('button:has-text("Continue with Google"), div[role="button"]:has-text("Google")');
    if (googleBtn) {
      console.log('   🔐 Using Google login...');
      await googleBtn.click();
      await page.waitForTimeout(3000);
      
      // Fill Google email
      const emailInput = await page.$('input[type="email"]');
      if (emailInput) {
        await emailInput.fill(credentials.email);
        await page.click('button:has-text("Next"), #identifierNext');
        await page.waitForTimeout(2000);
        
        // Fill Google password
        const passwordInput = await page.$('input[type="password"]');
        if (passwordInput) {
          await passwordInput.fill(credentials.password);
          await page.click('button:has-text("Next"), #passwordNext');
          await page.waitForTimeout(3000);
        }
      }
    } else {
      // Regular email/password login
      const emailInput = await page.$('input#email, input[name="email"], input[type="email"]');
      const passwordInput = await page.$('input#password, input[name="password"], input[type="password"]');
      
      if (emailInput && passwordInput) {
        await emailInput.fill(credentials.email);
        await passwordInput.fill(credentials.password);
        await page.click('button[type="submit"], button:has-text("Sign in")');
        await page.waitForTimeout(3000);
      }
    }
  }

  // Check for Easy Apply button
  const easyApplyBtn = await page.$('button:has-text("Easy Apply"), button[data-testid="easy-apply-button"]');
  if (!easyApplyBtn) {
    console.log('   ⚠️  No Easy Apply button found on this listing');
    return { success: false, method: 'none', error: 'No Easy Apply button' };
  }

  console.log('   📝 Clicking Easy Apply...');
  await easyApplyBtn.click();
  await page.waitForTimeout(2000);

  // Fill application form
  const allInputs = await page.$$('input[type="text"], input[type="email"], input[type="tel"]');
  for (const input of allInputs) {
    const val = await input.inputValue();
    if (val) continue;
    
    const name = (await input.getAttribute('name') || '').toLowerCase();
    const placeholder = (await input.getAttribute('placeholder') || '').toLowerCase();
    const field = name + ' ' + placeholder;
    
    if (field.includes('first')) await input.fill(C.firstName);
    else if (field.includes('last')) await input.fill(C.lastName);
    else if (field.includes('email')) await input.fill(C.email);
    else if (field.includes('phone')) await input.fill(C.phone);
    else if (field.includes('location') || field.includes('city')) await input.fill(C.location);
  }

  // Fill textareas
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    const val = await ta.inputValue();
    if (val) continue;
    const name = await ta.getAttribute('name') || '';
    await ta.fill('I have 4+ years of experience building AI-powered automation systems across marketing, sales, and operations. I am passionate about building intelligent systems that replace manual workflows.');
    console.log(`     ✅ Answered: ${name.slice(0, 60)}`);
  }

  // Upload resume
  const fileInputs = await page.$$('input[type="file"]');
  if (fileInputs.length > 0 && cvPath && existsSync(cvPath)) {
    await fileInputs[0].setInputFiles(cvPath);
    console.log(`     ✅ Resume uploaded`);
  }

  // Handle multi-step forms
  for (let step = 0; step < 5; step++) {
    const continueBtn = await page.$('button:has-text("Continue"), button:has-text("Next"), button:has-text("Submit")');
    if (!continueBtn) break;
    
    const text = await continueBtn.textContent();
    if (text.includes('Submit')) {
      if (!DRY_RUN) {
        console.log('   📤 Submitting application...');
        await continueBtn.click();
        await page.waitForTimeout(3000);
        
        const bodyText = await page.textContent('body');
        if (bodyText.includes('applied') || bodyText.includes('submitted') || bodyText.includes('thank')) {
          console.log('   ✅ Indeed Easy Apply submitted!');
          return { success: true, method: 'indeed_easy_apply' };
        }
      } else {
        console.log('   [DRY RUN] Would submit Indeed application');
        return { success: true, method: 'indeed_easy_apply', dryRun: true };
      }
    }
    
    await continueBtn.click();
    await page.waitForTimeout(2000);
  }

  return { success: false, method: 'none', error: 'Form completion failed' };
}

// ─── SEEK Easy Apply ───────────────────────────────────────────────────────

async function seekEasyApply(page, cvPath) {
  console.log('   🔍 Attempting SEEK Easy Apply...');
  
  const credentials = emailConfig?.job_boards?.seek;
  if (!credentials) {
    console.log('   ⚠️  No SEEK credentials found in config/email.yml');
    return { success: false, method: 'none', error: 'No credentials' };
  }

  // Check if already logged in
  const isLoggedIn = await page.$('a[data-testid="nav-item-profile"]') || 
                     await page.$('[data-automation="signInLink"]');
  
  if (!isLoggedIn) {
    console.log('   🔐 Logging into SEEK...');
    
    // Navigate to SEEK sign-in
    await page.goto('https://www.seek.com.au/oauth/login', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    // Fill email
    const emailInput = await page.$('input[type="email"], input[name="email"]');
    if (emailInput) {
      await emailInput.fill(credentials.email);
      await page.click('button[type="submit"], button:has-text("Continue")');
      await page.waitForTimeout(2000);
      
      // Fill password
      const passwordInput = await page.$('input[type="password"], input[name="password"]');
      if (passwordInput) {
        await passwordInput.fill(credentials.password);
        await page.click('button[type="submit"], button:has-text("Sign in")');
        await page.waitForTimeout(3000);
      }
    }
  }

  // Check for Apply button
  const applyBtn = await page.$('button[data-automation="applyButton"], button:has-text("Apply")');
  if (!applyBtn) {
    console.log('   ⚠️  No Apply button found on this listing');
    return { success: false, method: 'none', error: 'No Apply button' };
  }

  console.log('   📝 Clicking Apply...');
  await applyBtn.click();
  await page.waitForTimeout(2000);

  // Check if it's a SEEK Easy Apply or redirects to company website
  const currentUrl = page.url();
  if (currentUrl.includes('apply') && !currentUrl.includes('seek.com.au')) {
    console.log('   🔗 Redirected to company website for application');
    return { success: false, method: 'redirect', redirectUrl: currentUrl };
  }

  // Fill SEEK application form
  const allInputs = await page.$$('input[type="text"], input[type="email"], input[type="tel"]');
  for (const input of allInputs) {
    const val = await input.inputValue();
    if (val) continue;
    
    const name = (await input.getAttribute('name') || '').toLowerCase();
    const placeholder = (await input.getAttribute('placeholder') || '').toLowerCase();
    const field = name + ' ' + placeholder;
    
    if (field.includes('first')) await input.fill(C.firstName);
    else if (field.includes('last')) await input.fill(C.lastName);
    else if (field.includes('email')) await input.fill(C.email);
    else if (field.includes('phone')) await input.fill(C.phone);
    else if (field.includes('location') || field.includes('city')) await input.fill(C.location);
  }

  // Fill textareas
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    const val = await ta.inputValue();
    if (val) continue;
    const name = await ta.getAttribute('name') || '';
    await ta.fill('I have 4+ years of experience building AI-powered automation systems across marketing, sales, and operations. I am passionate about building intelligent systems that replace manual workflows.');
    console.log(`     ✅ Answered: ${name.slice(0, 60)}`);
  }

  // Upload resume
  const fileInputs = await page.$$('input[type="file"]');
  if (fileInputs.length > 0 && cvPath && existsSync(cvPath)) {
    await fileInputs[0].setInputFiles(cvPath);
    console.log(`     ✅ Resume uploaded`);
  }

  // Submit
  const submitBtn = await page.$('button[data-automation="applyButton"], button:has-text("Submit"), button:has-text("Apply now")');
  if (submitBtn) {
    if (!DRY_RUN) {
      console.log('   📤 Submitting SEEK application...');
      await submitBtn.click();
      await page.waitForTimeout(3000);
      
      const bodyText = await page.textContent('body');
      if (bodyText.includes('applied') || bodyText.includes('submitted') || bodyText.includes('thank')) {
        console.log('   ✅ SEEK Easy Apply submitted!');
        return { success: true, method: 'seek_easy_apply' };
      }
    } else {
      console.log('   [DRY RUN] Would submit SEEK application');
      return { success: true, method: 'seek_easy_apply', dryRun: true };
    }
  }

  return { success: false, method: 'none', error: 'Form completion failed' };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const jobBoard = detectJobBoard(url);
  console.log(`\n🚀 Easy Apply on ${jobBoard.toUpperCase()}: ${url}`);
  if (DRY_RUN) console.log('⚠️  DRY RUN — will fill but not submit\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('   Page loaded');

    // Auto-find CV
    let cvPath = cvFlag;
    if (!cvPath) cvPath = findLatestFile(join(__dirname, 'output'), /^cv-candidate.*\.pdf$/);
    console.log(`   CV: ${cvPath || 'not found'}`);

    // Attempt Easy Apply
    let result;
    switch (jobBoard) {
      case 'indeed':
        result = await indeedEasyApply(page, cvPath);
        break;
      case 'seek':
        result = await seekEasyApply(page, cvPath);
        break;
      default:
        result = { success: false, method: 'none', error: 'Unknown job board' };
    }

    // Save result
    const resultPath = join(__dirname, `output/easy-apply-${jobBoard}-${Date.now()}.json`);
    writeFileSync(resultPath, JSON.stringify({
      url,
      jobBoard,
      ...result,
      timestamp: new Date().toISOString(),
    }, null, 2));

    return result;
  } catch (e) {
    console.error(`   ❌ Error: ${e.message}`);
    const errorPath = join(__dirname, `output/easy-apply-error-${jobBoard}-${Date.now()}.png`);
    await page.screenshot({ path: errorPath, fullPage: true }).catch(() => {});
    return { success: false, error: e.message };
  } finally {
    await browser.close();
  }
}

const result = await main();
console.log(JSON.stringify(result));
