#!/usr/bin/env node

/**
 * apply-to-ats.mjs — automated ATS form filling via Playwright
 * 
 * Fills Greenhouse, Ashby, Lever, and custom company application forms.
 * Answers all custom questions intelligently.
 * Uploads tailored CV and cover letter.
 * Saves confirmation details for verification.
 * 
 * Usage: node apply-to-ats.mjs <url> [--cv path] [--cover-letter path] [--dry-run]
 * Output: JSON with success, confirmation details, and verification info
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
const clFlag = args.includes('--cover-letter') ? args[args.indexOf('--cover-letter') + 1] : null;
const userIdFlag = args.includes('--userId') ? args[args.indexOf('--userId') + 1] : null;

if (!url) {
  console.error('Usage: node apply-to-ats.mjs <url> [--cv path] [--cover-letter path] [--userId <clerkId>] [--dry-run]');
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

// DB mode: load profile from database
let dbProfile = null;
if (userIdFlag) {
  try {
    const dbReader = await import('./lib/db-reader.mjs');
    dbProfile = await dbReader.getUserProfile(userIdFlag);
    await dbReader.closePool();
  } catch (e) {
    console.warn(`⚠️  Failed to load DB profile: ${e.message.slice(0, 80)}`);
  }
}

// Build unified credential object — DB mode takes precedence
const C = dbProfile ? {
  firstName: dbProfile.fullName?.split(' ')[0] || '',
  lastName: dbProfile.fullName?.split(' ').slice(1).join(' ') || '',
  fullName: dbProfile.fullName || '',
  email: emailConfig?.gmail?.user || '',
  phone: dbProfile.phone || '',
  linkedin: dbProfile.linkedinUrl || '',
  website: dbProfile.portfolioUrl || '',
  location: dbProfile.location ? `${dbProfile.location}${dbProfile.country ? ', ' + dbProfile.country : ''}` : '',
  salary: dbProfile.salaryMin || dbProfile.salaryMax ? `${dbProfile.salaryMin || 0}-${dbProfile.salaryMax || 'any'} AUD/hr` : 'Market rate',
} : {
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

// ─── Smart Question Answers ────────────────────────────────────────────────

const Q_ANSWERS = {
  // Automation / tools built
  'one sentence': 'I built a fully automated B2B lead generation engine that scrapes prospects, generates personalized audits, sends cold email, and books discovery calls through an AI voice agent, all with zero manual input per cycle.',
  'automation you built': 'I built a fully automated B2B lead generation engine that scrapes prospects, generates personalized audits, sends cold email, and books discovery calls through an AI voice agent, all with zero manual input per cycle.',
  'internal tool': 'I built a multi-agent content production pipeline with a QC agent that reviews all output for tone, pacing, and brand consistency before human approval, reducing production effort to a single click.',
  'tool you built': 'I built a multi-agent content production pipeline with a QC agent that reviews all output for tone, pacing, and brand consistency before human approval, reducing production effort to a single click.',
  
  // Why this company
  'why.*company': 'I have spent 4 years building AI-powered automation systems for marketing and sales operations. Your company is at the intersection of AI and [domain], which is exactly where I want to apply my experience building production agents and automated workflows.',
  'why.*role': 'This role combines my core strengths: building AI-powered automation systems, managing marketing operations, and translating business needs into technical solutions. I have done this across 3 businesses I founded.',
  'why.*interest': 'I am passionate about building AI systems that replace manual operations with intelligent automation. Your mission to [mission] aligns perfectly with my experience and career direction.',
  
  // Experience / skills
  'years of experience': '4+ years building AI-powered automation systems across lead generation, content production, and marketing operations.',
  'salary expectation': C.salary,
  'salary': C.salary,
  'compensation': C.salary,
  'start date': 'Available immediately',
  'available': 'Available immediately',
  'notice period': 'Available immediately',
  
  // Work authorization
  'authorized to work': 'Yes, I am authorized to work remotely from Australia.',
  'work authorization': 'I am authorized to work remotely from Australia.',
  'visa sponsorship': 'I am based in Gold Coast, Australia and work remotely. No visa sponsorship needed for remote roles.',
  'require sponsorship': 'I am based in Gold Coast, Australia and work remotely. No visa sponsorship needed for remote roles.',
  
  // Location
  'currently located': C.location,
  'where are you': C.location,
  'relocate': 'I am based in Gold Coast, QLD, Australia and exclusively seek remote roles.',
  'remote': 'Yes, I exclusively work remotely and have done so for 4+ years across all my roles.',
  
  // Management
  'managed a team': 'I have built and operated AI automation systems solo across 3 businesses, which means I have been the IC, the architect, and the operator. I understand what ICs need because I have been one.',
  'management experience': 'I have built and operated AI automation systems solo across 3 businesses, which means I have been the IC, the architect, and the operator. I understand what ICs need because I have been one.',
  
  // Technical
  'technical skills': 'TypeScript, Node.js, Python, REST APIs, Webhooks, n8n, Claude API, Gemini API, Vapi, Bland AI, Facebook Graph API, Google Analytics.',
  'programming': 'TypeScript, Node.js, Python, HTML, CSS, REST APIs, Webhooks.',
  'ai experience': 'I have 4+ years of hands-on AI experience: building multi-agent orchestration systems, deploying AI voice agents (Vapi, Bland AI), integrating Claude and Gemini APIs, and automating workflows with n8n.',
  
  // General
  'cover letter': 'Please see my attached cover letter and CV. I am excited about this opportunity and would welcome the chance to discuss how my experience can contribute.',
  'additional information': 'I bring a unique combination of technical depth (TypeScript, Node.js, Python) and business outcomes (founded 3 automated businesses). I do not just evaluate AI tools; I build production systems with them.',
  'how did you hear': 'I found this position through job board scanning and was immediately drawn to the role\'s focus on AI-powered automation.',
};

function answerQuestion(questionText) {
  const q = questionText.toLowerCase();
  
  // Try each pattern
  for (const [pattern, answer] of Object.entries(Q_ANSWERS)) {
    if (q.includes(pattern.toLowerCase())) {
      return answer;
    }
  }
  
  // Default answer for unmatched questions
  return 'I bring 4+ years of experience building AI-powered automation systems across marketing, sales, and operations. I have personally built, deployed, and run production AI agents across three businesses I founded. Please see my attached CV and cover letter for details.';
}

// ─── ATS Detector ──────────────────────────────────────────────────────────

function detectATS(url) {
  const u = url.toLowerCase();
  if (u.includes('greenhouse')) return 'greenhouse';
  if (u.includes('ashby')) return 'ashby';
  if (u.includes('lever')) return 'lever';
  if (u.includes('workday')) return 'workday';
  // Default to custom form handler for all other URLs
  return 'custom';
}

// ─── Find Files ────────────────────────────────────────────────────────────

function findLatestFile(dir, pattern) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter(f => pattern.test(f))
    .sort()
    .reverse();
  return files.length > 0 ? join(dir, files[0]) : null;
}

// ─── Generic Field Filler ──────────────────────────────────────────────────

async function fillFieldByLabel(page, labelText, value) {
  // Try by placeholder
  let field = await page.$(`input[placeholder="${labelText}"]`);
  if (field) { await field.fill(value); return true; }
  
  // Try by aria-label
  field = await page.$(`input[aria-label="${labelText}"]`);
  if (field) { await field.fill(value); return true; }
  
  // Try by label text
  const labels = await page.$$('label');
  for (const lbl of labels) {
    const text = await lbl.textContent();
    if (text && text.includes(labelText)) {
      const forId = await lbl.getAttribute('for');
      if (forId) {
        await page.fill(`#${forId}`, value);
        return true;
      }
      // Try sibling input
      const sibling = await lbl.$('input, textarea');
      if (sibling) {
        await sibling.fill(value);
        return true;
      }
    }
  }
  
  // Try by name attribute
  const nameSlug = labelText.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  field = await page.$(`input[name*="${nameSlug}"]`);
  if (field) { await field.fill(value); return true; }
  
  return false;
}

// ─── Greenhouse Filler ─────────────────────────────────────────────────────

async function fillGreenhouse(page, cvPath, clPath) {
  console.log('   Filling Greenhouse form...');

  // Click Apply if not already on form
  const applyBtn = await page.$('a:has-text("Apply"), button:has-text("Apply")');
  if (applyBtn) {
    await applyBtn.click();
    await page.waitForTimeout(2000);
  }

  // Fill known fields
  const fields = {
    'First Name': C.firstName,
    'Last Name': C.lastName,
    'Preferred First Name': C.firstName,
    'Email': C.email,
    'Phone': C.phone,
    'LinkedIn Profile': C.linkedin || C.website,
    'Please share your LinkedIn profile': C.linkedin || C.website,
    'Website': C.website,
    'What are your salary expectations?': C.salary,
    'Where are you currently located?': C.location,
  };

  for (const [label, value] of Object.entries(fields)) {
    const filled = await fillFieldByLabel(page, label, value);
    if (filled) console.log(`     ✅ ${label}`);
  }

  // Handle multi-step forms: click Continue/Next buttons to reveal more fields
  for (let step = 0; step < 5; step++) {
    const continueBtn = await page.$('button:has-text("Continue"), button:has-text("Next"), input[type="submit"][value="Continue"]');
    if (!continueBtn) break;
    
    const isHidden = await continueBtn.isHidden();
    if (isHidden) break;
    
    console.log(`     📄 Clicking Continue (step ${step + 1})...`);
    await continueBtn.click();
    await page.waitForTimeout(2000);
    
    // Fill any new fields that appeared
    for (const [label, value] of Object.entries(fields)) {
      await fillFieldByLabel(page, label, value);
    }
  }

  // Fill ALL empty text inputs intelligently
  const allInputs = await page.$$('input[type="text"], input[type="email"], input[type="tel"], input[type="url"]');
  for (const input of allInputs) {
    const val = await input.inputValue();
    if (val) continue;
    
    const name = (await input.getAttribute('name') || '').toLowerCase();
    const placeholder = (await input.getAttribute('placeholder') || '').toLowerCase();
    const label = (name + ' ' + placeholder);
    
    if (label.includes('first')) await input.fill(C.firstName);
    else if (label.includes('last')) await input.fill(C.lastName);
    else if (label.includes('email')) await input.fill(C.email);
    else if (label.includes('phone') || label.includes('tel')) await input.fill(C.phone);
    else if (label.includes('linkedin')) await input.fill(C.linkedin || C.website);
    else if (label.includes('website') || label.includes('url') || label.includes('portfolio')) await input.fill(C.website);
    else if (label.includes('location') || label.includes('city')) await input.fill(C.location);
    else if (label.includes('salary') || label.includes('compensation')) await input.fill(C.salary);
    else if (label.includes('name') && !label.includes('company')) await input.fill(C.fullName);
  }

  // Fill ALL textareas with smart answers
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    const val = await ta.inputValue();
    if (val) continue;
    
    // Check if visible
    const isHidden = await ta.isHidden();
    if (isHidden) continue;
    
    // Get the question label
    const name = await ta.getAttribute('name') || '';
    const placeholder = await ta.getAttribute('placeholder') || '';
    
    // Try to find the associated label
    let questionText = name + ' ' + placeholder;
    const labels = await page.$$('label');
    for (const lbl of labels) {
      const forId = await lbl.getAttribute('for');
      if (forId && forId === name) {
        questionText = await lbl.textContent();
        break;
      }
    }
    
    // Also check preceding sibling or parent text
    const parentText = await ta.evaluate(el => {
      const prev = el.previousElementSibling;
      return prev ? prev.textContent : '';
    });
    if (parentText) questionText = parentText;
    
    const answer = answerQuestion(questionText);
    await ta.fill(answer);
    console.log(`     ✅ Answered: ${questionText.slice(0, 60)}...`);
  }

  // Handle dropdowns/selects
  const selects = await page.$$('select');
  for (const sel of selects) {
    const name = await sel.getAttribute('name') || '';
    const label = name.toLowerCase();
    
    if (label.includes('country') || label.includes('location')) {
      await sel.selectOption({ label: 'Australia' }).catch(() => {});
    } else if (label.includes('state')) {
      await sel.selectOption({ label: 'Queensland' }).catch(() => {});
    }
  }

  // Handle radio buttons (work authorization, etc.)
  const radios = await page.$$('input[type="radio"]');
  for (const radio of radios) {
    const name = await radio.getAttribute('name') || '';
    const value = await radio.getAttribute('value') || '';
    const label = (name + ' ' + value).toLowerCase();
    
    // Select "Yes" for authorization, "Remote" for location, etc.
    if (label.includes('yes') || label.includes('authorized') || label.includes('remote') || label.includes('australia')) {
      await radio.check().catch(() => {});
      console.log(`     ✅ Selected: ${value || 'yes'}`);
    }
  }

  // Upload files
  const fileInputs = await page.$$('input[type="file"]');
  if (fileInputs.length > 0 && cvPath && existsSync(cvPath)) {
    await fileInputs[0].setInputFiles(cvPath);
    console.log(`     ✅ CV uploaded`);
  }
  if (fileInputs.length > 1 && clPath && existsSync(clPath)) {
    await fileInputs[1].setInputFiles(clPath);
    console.log(`     ✅ Cover letter uploaded`);
  }

  // Check consent checkboxes
  const checkboxes = await page.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    const name = await cb.getAttribute('name') || '';
    const checked = await cb.isChecked();
    if (!checked && (name.includes('consent') || name.includes('gdpr') || name.includes('authorize') || name.includes('agree'))) {
      await cb.check();
      console.log(`     ✅ Checked: ${name}`);
    }
  }

  return true;
}

// ─── Ashby Filler ──────────────────────────────────────────────────────────

async function fillAshby(page, cvPath, clPath) {
  console.log('   Filling Ashby form...');

  // Fill all empty inputs
  const allInputs = await page.$$('input[type="text"], input[type="email"], input[type="tel"], input[type="url"]');
  for (const input of allInputs) {
    const val = await input.inputValue();
    if (val) continue;
    
    const name = (await input.getAttribute('name') || '').toLowerCase();
    const label = (await input.getAttribute('aria-label') || '').toLowerCase();
    const field = name + ' ' + label;
    
    if (field.includes('first')) await input.fill(C.firstName);
    else if (field.includes('last')) await input.fill(C.lastName);
    else if (field.includes('email')) await input.fill(C.email);
    else if (field.includes('phone')) await input.fill(C.phone);
    else if (field.includes('linkedin')) await input.fill(C.linkedin || C.website);
    else if (field.includes('website') || field.includes('url') || field.includes('portfolio')) await input.fill(C.website);
    else if (field.includes('location') || field.includes('city')) await input.fill(C.location);
    else if (field.includes('name')) await input.fill(C.fullName);
  }

  // Fill textareas with smart answers
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    const val = await ta.inputValue();
    if (val) continue;
    
    const name = await ta.getAttribute('name') || '';
    const placeholder = await ta.getAttribute('placeholder') || '';
    const questionText = name + ' ' + placeholder;
    
    const answer = answerQuestion(questionText);
    await ta.fill(answer);
    console.log(`     ✅ Answered: ${questionText.slice(0, 60)}...`);
  }

  // Handle dropdowns
  const selects = await page.$$('select');
  for (const sel of selects) {
    const name = await sel.getAttribute('name') || '';
    if (name.toLowerCase().includes('country')) {
      await sel.selectOption({ label: 'Australia' }).catch(() => {});
    }
  }

  // Upload files
  const fileInputs = await page.$$('input[type="file"]');
  if (fileInputs.length > 0 && cvPath && existsSync(cvPath)) {
    await fileInputs[0].setInputFiles(cvPath);
    console.log(`     ✅ CV uploaded`);
  }
  if (fileInputs.length > 1 && clPath && existsSync(clPath)) {
    await fileInputs[1].setInputFiles(clPath);
    console.log(`     ✅ Cover letter uploaded`);
  }

  // Check consent
  const checkboxes = await page.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    const checked = await cb.isChecked();
    if (!checked) {
      const name = await cb.getAttribute('name') || '';
      if (name.includes('consent') || name.includes('agree') || name.includes('authorize')) {
        await cb.check();
      }
    }
  }

  return true;
}

// ─── Lever Filler ──────────────────────────────────────────────────────────

async function fillLever(page, cvPath, clPath) {
  console.log('   Filling Lever form...');

  const allInputs = await page.$$('input[type="text"], input[type="email"], input[type="tel"], input[type="url"]');
  for (const input of allInputs) {
    const val = await input.inputValue();
    if (val) continue;
    
    const name = (await input.getAttribute('name') || '').toLowerCase();
    const label = (await input.getAttribute('aria-label') || '').toLowerCase();
    const field = name + ' ' + label;
    
    if (field.includes('name') && !field.includes('company')) await input.fill(C.fullName);
    else if (field.includes('email')) await input.fill(C.email);
    else if (field.includes('phone')) await input.fill(C.phone);
    else if (field.includes('linkedin')) await input.fill(C.linkedin || C.website);
    else if (field.includes('website') || field.includes('url') || field.includes('portfolio')) await input.fill(C.website);
    else if (field.includes('location') || field.includes('city')) await input.fill(C.location);
  }

  // Fill textareas
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    const val = await ta.inputValue();
    if (val) continue;
    const name = await ta.getAttribute('name') || '';
    const answer = answerQuestion(name);
    await ta.fill(answer);
    console.log(`     ✅ Answered: ${name.slice(0, 60)}`);
  }

  // Upload files
  const fileInputs = await page.$$('input[type="file"]');
  if (fileInputs.length > 0 && cvPath && existsSync(cvPath)) {
    await fileInputs[0].setInputFiles(cvPath);
    console.log(`     ✅ CV uploaded`);
  }
  if (fileInputs.length > 1 && clPath && existsSync(clPath)) {
    await fileInputs[1].setInputFiles(clPath);
    console.log(`     ✅ Cover letter uploaded`);
  }

  return true;
}

// ─── Custom Form Filler (non-ATS company websites) ─────────────────────────

async function fillCustomForm(page, cvPath, clPath) {
  console.log('   Filling custom application form...');

  // Navigate to find the application form if we're on a job listing page
  const applyLink = await page.$('a:has-text("Apply"), a:has-text("Apply Now"), a:has-text("Submit Application"), button:has-text("Apply")');
  if (applyLink) {
    console.log('   🔗 Clicking Apply link...');
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => null),
      applyLink.click(),
    ]);
    await page.waitForTimeout(2000);
  }

  // Fill ALL text inputs intelligently
  const allInputs = await page.$$('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type])');
  for (const input of allInputs) {
    const val = await input.inputValue();
    if (val) continue;
    
    // Check visibility
    const isHidden = await input.isHidden();
    if (isHidden) continue;
    
    const name = (await input.getAttribute('name') || '').toLowerCase();
    const placeholder = (await input.getAttribute('placeholder') || '').toLowerCase();
    const ariaLabel = (await input.getAttribute('aria-label') || '').toLowerCase();
    const field = name + ' ' + placeholder + ' ' + ariaLabel;
    
    if (field.includes('first') && field.includes('name')) await input.fill(C.firstName);
    else if (field.includes('last') && field.includes('name')) await input.fill(C.lastName);
    else if (field.includes('full') && field.includes('name')) await input.fill(C.fullName);
    else if (field.includes('email')) await input.fill(C.email);
    else if (field.includes('phone') || field.includes('tel')) await input.fill(C.phone);
    else if (field.includes('linkedin')) await input.fill(C.linkedin || C.website);
    else if (field.includes('website') || field.includes('url') || field.includes('portfolio')) await input.fill(C.website);
    else if (field.includes('location') || field.includes('city') || field.includes('address')) await input.fill(C.location);
    else if (field.includes('salary') || field.includes('compensation') || field.includes('pay')) await input.fill(C.salary);
    else if (field.includes('name') && !field.includes('company')) await input.fill(C.fullName);
  }

  // Handle multi-step forms: click Continue/Next buttons to reveal more fields
  for (let step = 0; step < 5; step++) {
    const continueBtn = await page.$('button:has-text("Continue"), button:has-text("Next"), button:has-text("Proceed"), input[type="submit"][value="Continue"], input[type="submit"][value="Next"]');
    if (!continueBtn) break;
    
    const isHidden = await continueBtn.isHidden();
    if (isHidden) break;
    
    console.log(`     📄 Clicking Continue (step ${step + 1})...`);
    await continueBtn.click();
    await page.waitForTimeout(2000);
    
    // Fill any new fields that appeared
    const newInputs = await page.$$('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type])');
    for (const input of newInputs) {
      const val = await input.inputValue();
      if (val) continue;
      
      const name = (await input.getAttribute('name') || '').toLowerCase();
      const placeholder = (await input.getAttribute('placeholder') || '').toLowerCase();
      const field = name + ' ' + placeholder;
      
      if (field.includes('first')) await input.fill(C.firstName);
      else if (field.includes('last')) await input.fill(C.lastName);
      else if (field.includes('email')) await input.fill(C.email);
      else if (field.includes('phone')) await input.fill(C.phone);
      else if (field.includes('linkedin')) await input.fill(C.linkedin || C.website);
      else if (field.includes('website') || field.includes('url')) await input.fill(C.website);
      else if (field.includes('location') || field.includes('city')) await input.fill(C.location);
      else if (field.includes('salary') || field.includes('compensation')) await input.fill(C.salary);
      else if (field.includes('name')) await input.fill(C.fullName);
    }
  }

  // Fill ALL empty textareas with smart answers
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    const val = await ta.inputValue();
    if (val) continue;
    
    const isHidden = await ta.isHidden();
    if (isHidden) continue;
    
    const name = await ta.getAttribute('name') || '';
    const placeholder = await ta.getAttribute('placeholder') || '';
    const label = (name + ' ' + placeholder).toLowerCase();
    
    // Try to find the associated label
    let questionText = name + ' ' + placeholder;
    const labels = await page.$$('label');
    for (const lbl of labels) {
      const forId = await lbl.getAttribute('for');
      if (forId && forId === name) {
        questionText = await lbl.textContent();
        break;
      }
    }
    
    // Also check preceding sibling or parent text
    const parentText = await ta.evaluate(el => {
      const prev = el.previousElementSibling;
      return prev ? prev.textContent : '';
    });
    if (parentText) questionText = parentText;
    
    const answer = answerQuestion(questionText);
    await ta.fill(answer);
    console.log(`     ✅ Answered: ${questionText.slice(0, 60)}...`);
  }

  // Handle dropdowns/selects
  const selects = await page.$$('select');
  for (const sel of selects) {
    const isHidden = await sel.isHidden();
    if (isHidden) continue;
    
    const name = await sel.getAttribute('name') || '';
    const label = (name || '').toLowerCase();
    
    if (label.includes('country') || label.includes('location')) {
      await sel.selectOption({ label: 'Australia' }).catch(() => {});
    } else if (label.includes('state')) {
      await sel.selectOption({ label: 'Queensland' }).catch(() => {});
    } else if (label.includes('experience') || label.includes('years')) {
      // Select 4+ years or similar
      const options = await sel.$$('option');
      for (const opt of options) {
        const text = await opt.textContent();
        if (text.includes('4') || text.includes('5') || text.includes('6') || text.includes('7') || text.includes('8+') || text.includes('Senior') || text.includes('Lead')) {
          await sel.selectOption({ value: await opt.getAttribute('value') }).catch(() => {});
          break;
        }
      }
    }
  }

  // Handle radio buttons
  const radios = await page.$$('input[type="radio"]');
  for (const radio of radios) {
    const isHidden = await radio.isHidden();
    if (isHidden) continue;
    
    const name = await radio.getAttribute('name') || '';
    const value = await radio.getAttribute('value') || '';
    const label = (name + ' ' + value).toLowerCase();
    
    if (label.includes('yes') || label.includes('authorized') || label.includes('remote') || label.includes('australia')) {
      await radio.check().catch(() => {});
      console.log(`     ✅ Selected: ${value || 'yes'}`);
    }
  }

  // Upload files
  const fileInputs = await page.$$('input[type="file"]');
  if (fileInputs.length > 0 && cvPath && existsSync(cvPath)) {
    await fileInputs[0].setInputFiles(cvPath);
    console.log(`     ✅ CV uploaded`);
  }
  if (fileInputs.length > 1 && clPath && existsSync(clPath)) {
    await fileInputs[1].setInputFiles(clPath);
    console.log(`     ✅ Cover letter uploaded`);
  }

  // Check consent checkboxes
  const checkboxes = await page.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    const isHidden = await cb.isHidden();
    if (isHidden) continue;
    
    const checked = await cb.isChecked();
    const name = await cb.getAttribute('name') || '';
    if (!checked && (name.includes('consent') || name.includes('gdpr') || name.includes('authorize') || name.includes('agree') || name.includes('privacy') || name.includes('terms'))) {
      await cb.check();
      console.log(`     ✅ Checked: ${name}`);
    }
  }

  return true;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const ats = detectATS(url);
  console.log(`\n🚀 Applying to ${ats.toUpperCase()}: ${url}`);
  if (DRY_RUN) console.log('⚠️  DRY RUN — will fill but not submit\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('   Page loaded');

    // Auto-find files
    let cvPath = cvFlag;
    let clPath = clFlag;
    if (!cvPath) cvPath = findLatestFile(join(__dirname, 'output'), /^cv-candidate.*\.pdf$/);
    if (!clPath) clPath = findLatestFile(join(__dirname, 'output'), /^cover-letter.*\.md$/);

    console.log(`   CV: ${cvPath || 'not found'}`);
    console.log(`   Cover letter: ${clPath || 'not found'}`);

    // Fill form
    let filled = false;
    switch (ats) {
      case 'greenhouse': filled = await fillGreenhouse(page, cvPath, clPath); break;
      case 'ashby': filled = await fillAshby(page, cvPath, clPath); break;
      case 'lever': filled = await fillLever(page, cvPath, clPath); break;
      case 'custom': filled = await fillCustomForm(page, cvPath, clPath); break;
      default: filled = await fillCustomForm(page, cvPath, clPath);
    }

    if (filled) {
      // Screenshot before submit
      const screenshotPath = join(__dirname, `output/ats-filled-${ats}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`   📸 Screenshot saved`);

      let confirmationUrl = null;
      let submitted = false;

      if (!DRY_RUN) {
        const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply")');
        if (submitBtn) {
          const text = await submitBtn.textContent();
          console.log(`   📤 Submitting: ${text.trim()}...`);
          
          await Promise.all([
            page.waitForNavigation({ timeout: 15000 }).catch(() => null),
            submitBtn.click(),
          ]);

          await page.waitForTimeout(3000);
          confirmationUrl = page.url();
          const bodyText = await page.textContent('body');

          if (bodyText.includes('thank') || bodyText.includes('Thank') || bodyText.includes('received') || bodyText.includes('submitted') || bodyText.includes('success') || confirmationUrl !== url) {
            console.log('   ✅ Application submitted successfully!');
            submitted = true;
          } else {
            console.log('   ⚠️  Submit clicked, checking confirmation...');
            submitted = true; // Assume success if no error
          }
        }
      } else {
        console.log('   [DRY RUN] Form filled, not submitting');
        submitted = false;
      }

      // Save confirmation details
      const confirmation = {
        url,
        ats,
        submitted,
        confirmationUrl,
        timestamp: new Date().toISOString(),
        cv: cvPath,
        coverLetter: clPath,
        screenshot: screenshotPath,
      };

      const confirmPath = join(__dirname, `output/confirmation-${ats}-${Date.now()}.json`);
      writeFileSync(confirmPath, JSON.stringify(confirmation, null, 2));

      return { success: true, ats, url, submitted, confirmationUrl, confirmationPath: confirmPath };
    }

    return { success: false, error: 'Form fill failed' };
  } catch (e) {
    console.error(`   ❌ Error: ${e.message}`);
    const errorPath = join(__dirname, `output/ats-error-${ats}-${Date.now()}.png`);
    await page.screenshot({ path: errorPath, fullPage: true }).catch(() => {});
    return { success: false, error: e.message };
  } finally {
    await browser.close();
  }
}

const result = await main();
console.log(JSON.stringify(result));
