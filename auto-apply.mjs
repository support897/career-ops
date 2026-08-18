#!/usr/bin/env node

/**
 * auto-apply.mjs — Daily automated job search pipeline
 * 
 * Flow: Scan → Pre-screen → Generate CV/Cover Letter → Apply via ATS → Send Email → Report
 * 
 * Usage: 
 *   node auto-apply.mjs [--dry-run] [--limit N]                   # local mode (Ilse only)
 *   node auto-apply.mjs --userId <clerkId> [--dry-run] [--limit N] # multi-user DB mode
 * 
 * Config: config/email.yml, config/profile.yml (local mode)
 * Data: data/pipeline.md, data/applications.md (local mode)
 *       Neon DB via DATABASE_URL (DB mode)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const jsyaml = require('js-yaml');

// Load environment variables. The repo-root `.env` is AUTHORITATIVE: it holds the
// canonical DATABASE_URL for the CLI and the 24/7 daemon. `web/.env.local` is
// loaded afterwards only to fill in keys the root file lacks — dotenv never
// overrides an already-set variable, so root always wins.
// This ordering matters: these two files drifted apart once before (root pointed
// at local Postgres while web/.env.local still pointed at a dead Neon instance),
// which silently split the runner and the dashboard across two databases.
const dotenv = require('dotenv');
const projectRoot = dirname(fileURLToPath(import.meta.url));
for (const envPath of [join(projectRoot, '.env'), join(projectRoot, 'web', '.env.local')]) {
  if (existsSync(envPath)) dotenv.config({ path: envPath });
}



const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--limit') || '1000');
const LOCAL_VIP = process.argv.includes('--local-vip');  // Force VIP for local hourly scans
const MIN_SCORE_ARG = parseFloat(process.argv.find((_, i, a) => a[i - 1] === '--min-score') || '0') || null;
const NO_ATS_SUBMIT = process.argv.includes('--no-ats-submit'); // Skip ATS form submission (draft only)
const TODAY = new Date().toISOString().split('T')[0];
const KEEP_PIPELINE = process.argv.includes('--keep-pipeline');
const READ_LOCAL_PIPELINE = process.argv.includes('--read-local-pipeline');
const userIdArg = process.argv.includes('--userId')
  ? process.argv[process.argv.indexOf('--userId') + 1]
  : null;
const userId = userIdArg || null;
const maxAgeArg = process.argv.includes('--max-age')
  ? parseInt(process.argv[process.argv.indexOf('--max-age') + 1])
  : null;

// ─── Config ────────────────────────────────────────────────────────────────

function loadYAML(path) {
  const full = join(__dirname, path);
  if (!existsSync(full)) return null;
  return jsyaml.load(readFileSync(full, 'utf8'));
}

const emailConfig = loadYAML('config/email.yml');

// DB mode: load profile from database
let dbReader = null;
let dbWriter = null;
let dbProfile = null;
let autoApplyEnabled = false;
let isVip = false;
let userEmailSettings = null;
let minScoreForAutoApply = MIN_SCORE_ARG || 2.5;
let dashboardScoreThreshold = MIN_SCORE_ARG || 2.5;



const API_PLATFORMS = ['greenhouse', 'ashby', 'lever', 'workday', 'remoteok'];
const JOB_BOARDS = ['linkedin', 'indeed', 'seek'];

let _llmDocsPromise;
/** Imported lazily so a keyword-only run never loads the provider chain. */
function llmDocsMod() {
  if (!_llmDocsPromise) _llmDocsPromise = import('./lib/llm-docs.mjs');
  return _llmDocsPromise;
}

/**
 * profile_config as saved by the dashboard, cached for the run.
 *
 * The local pipeline reads config/profile.yml, which carries no llm_docs key,
 * so without this the dashboard's LLM checkboxes had no effect on anything.
 */
let _dashCfgCache;
async function loadDashboardConfig(uid) {
  if (_dashCfgCache !== undefined) return _dashCfgCache;
  _dashCfgCache = null;
  try {
    const reader = await import('./lib/db-reader.mjs');
    _dashCfgCache = await reader.getProfileConfig(uid);
  } catch (e) {
    console.log(`   \u26a0\ufe0f  Could not read dashboard config: ${e.message.slice(0, 80)}`);
  }
  return _dashCfgCache;
}

// Determine if we should sync results to the database
const hasDb = !!process.env.DATABASE_URL;
const targetUserId = userId || process.env.VIP_USER_ID || (hasDb ? 'default' : null);

if (userId && userId !== 'default') {
  console.log(`[DB mode] Multi-user mode for userId: ${userId}`);
  dbReader = await import('./lib/db-reader.mjs');
  dbWriter = await import('./lib/db-writer.mjs');
  dbProfile = await dbReader.getUserProfile(userId);
  if (!dbProfile) {
    console.error(`❌ No profile found for user ${userId}. Complete onboarding first.`);
    process.exit(1);
  }
  autoApplyEnabled = await dbReader.getUserAutoApplySetting(userId);
  isVip = await dbReader.getUserVipStatus(userId);
  minScoreForAutoApply = await dbReader.getUserMinScoreForAutoApply(userId);
  dashboardScoreThreshold = await dbReader.getUserScoreThreshold(userId);
  if (isVip) {
    userEmailSettings = await dbReader.getUserEmailSettings(userId);
    console.log(`[DB mode] VIP user — email automation enabled`);
  }
  console.log(`[DB mode] Profile loaded: ${dbProfile.fullName}, auto-apply: ${autoApplyEnabled}, vip: ${isVip}, dashboard threshold: ${dashboardScoreThreshold}`);
} else if (hasDb) {
  // Local/Default mode with DB connection: load local config files, but enable DB sync
  console.log(`[Local mode] Database detected. Syncing results to DB under user: ${targetUserId}`);
  dbWriter = await import('./lib/db-writer.mjs');
  isVip = true;
  autoApplyEnabled = true; // Fully automated apply submission

}


// Local mode: load from profile.yml
const profile = loadYAML('config/profile.yml');

// Local mode runs with full capabilities (legacy Ilse-only path)
if (!userId) {
  isVip = true;
  console.log('[Local mode] Running as VIP-equivalent (local profile.yml path)');
}

// Build unified credential object — DB mode takes precedence
const userCreds = (userId && dbProfile) ? {

  firstName: dbProfile.fullName?.split(' ')[0] || '',
  lastName: dbProfile.fullName?.split(' ').slice(1).join(' ') || '',
  fullName: dbProfile.fullName || '',
  email: emailConfig?.gmail?.user || '',
  phone: dbProfile.phone || '',
  linkedin: dbProfile.linkedinUrl || '',
  website: dbProfile.portfolioUrl || '',
  location: dbProfile.location ? `${dbProfile.location}${dbProfile.country ? ', ' + dbProfile.country : ''}` : '',
  salary: dbProfile.salaryMin || dbProfile.salaryMax ? `${dbProfile.salaryMin || 0}-${dbProfile.salaryMax || 'any'} AUD/hr` : '',
  resumeUrl: dbProfile.resumeUrl || null,
  resumeName: dbProfile.resumeName || null,
} : {
  firstName: profile?.candidate?.full_name?.split(' ')[0] || 'Ilse',
  lastName: profile?.candidate?.full_name?.split(' ').slice(1).join(' ') || 'Placencia',
  fullName: profile?.candidate?.full_name || 'Ilse Placencia',
  email: emailConfig?.gmail?.user || 'placenciailse@gmail.com',
  phone: profile?.candidate?.phone || '+61498570497',
  linkedin: profile?.candidate?.linkedin || '',
  website: profile?.candidate?.portfolio_url || 'https://www.ilseplacencia.shop',
  location: profile?.candidate?.location || 'Gold Coast, QLD, Australia',
  salary: profile?.compensation?.target_range || 'Market rate',
  resumeUrl: null,
  resumeName: null,
};

if (!emailConfig?.gmail?.app_password && !DRY_RUN && isVip) {
  console.error('❌ Gmail app_password not set in config/email.yml (required for VIP email sending)');
  process.exit(1);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Email Sender ──────────────────────────────────────────────────────────

async function sendEmail({ to, subject, body, attachments = [] }) {
  try {
    const { createTransport } = await import('nodemailer');
    
    // VIP: use DB-stored encrypted password; non-VIP: use config/email.yml
    let smtpUser = emailConfig?.gmail?.user || '';
    let smtpPass = emailConfig?.gmail?.app_password || '';
    
    if (isVip && userEmailSettings?.encryptedAppPassword && userId) {
      const { decryptPassword } = await import('./lib/db-reader.mjs');
      const decrypted = decryptPassword(userId, userEmailSettings.encryptedAppPassword);
      if (decrypted) {
        smtpUser = userEmailSettings.emailAddress || smtpUser;
        smtpPass = decrypted;
        console.log(`   🔐 Using VIP email credentials from DB`);
      }
    }
    
    if (!smtpUser || !smtpPass) {
      return { success: false, error: 'No email credentials available' };
    }
    
    const transporter = createTransport({
      service: 'gmail',
      auth: { user: smtpUser, pass: smtpPass },
      connectionTimeout: 10000,
      greetingTimeout: 5000,
      socketTimeout: 15000,
    });

    const result = await transporter.sendMail({
      from: `"${emailConfig.defaults.from_name}" <${smtpUser}>`,
      to,
      subject,
      text: body,
      replyTo: emailConfig.defaults.reply_to,
      attachments: attachments.map(f => ({ filename: f.split('/').pop(), path: f })),
    });

    return { success: true, messageId: result.messageId };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Find Recruiter Email from ATS Confirmation ─────────────────────────────

async function findRecruiterEmail(company, atsType) {
  console.log(`   🔍 Checking inbox for ${company} confirmation email...`);
  
  try {
    const imaps = await import('imap-simple');
    
    const config = {
      imap: {
        user: emailConfig.gmail.user,
        password: emailConfig.gmail.app_password,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        authTimeout: 10000,
      },
    };
    
    const connection = await imaps.connect(config);
    await connection.openBox('INBOX');
    
    // Search for recent emails from the ATS
    const searchCriteria = ['UNSEEN', ['OR', 
      ['FROM', 'greenhouse'], 
      ['FROM', 'ashby'], 
      ['FROM', 'lever'],
      ['FROM', company.toLowerCase()]
    ]];
    
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT'],
      markSeen: false,
      struct: true,
    };
    
    const messages = await connection.search(searchCriteria, fetchOptions);
    
    // Look for the most recent confirmation email
    for (const msg of messages.reverse()) {
      const header = msg.parts.find(p => p.which === 'HEADER');
      const text = msg.parts.find(p => p.which === 'TEXT');
      
      if (!header) continue;
      
      const headers = header.body;
      const subject = headers.subject?.[0] || '';
      const from = headers.from?.[0] || '';
      
      // Check if this is a confirmation email for this company
      const isConfirmation = subject.toLowerCase().includes('application') ||
                            subject.toLowerCase().includes('received') ||
                            subject.toLowerCase().includes('thank you') ||
                            subject.toLowerCase().includes('submitted');
      
      const isForCompany = from.toLowerCase().includes(company.toLowerCase()) ||
                          subject.toLowerCase().includes(company.toLowerCase());
      
      if (isConfirmation && isForCompany) {
        // Extract email from the From field
        const emailMatch = from.match(/<([^>]+)>/);
        if (emailMatch) {
          console.log(`   ✅ Found recruiter email: ${emailMatch[1]}`);
          connection.end();
          return emailMatch[1];
        }
        
        // Try to find email in the body
        if (text) {
          const bodyText = text.body.toString();
          const emails = bodyText.match(/[\w.+-]+@[\w.-]+\.\w{2,}/g) || [];
          const recruiterEmail = emails.find(e => 
            !e.includes('noreply') && 
            !e.includes('no-reply') &&
            !e.includes('greenhouse.io') &&
            !e.includes('ashbyhq.com')
          );
          if (recruiterEmail) {
            console.log(`   ✅ Found recruiter email in body: ${recruiterEmail}`);
            connection.end();
            return recruiterEmail;
          }
        }
      }
    }
    
    connection.end();
    console.log(`   ⚠️  No confirmation email found yet`);
    return null;
    
  } catch (e) {
    console.log(`   ⚠️  Inbox check failed: ${e.message.slice(0, 80)}`);
    return null;
  }
}

// ─── Find Company Email (fallback) ─────────────────────────────────────────

async function scrapeJobDescription(url) {
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Try to get main content, fall back to full page
    const content = await page.evaluate(() => {
      const main = document.querySelector('main, [role="main"], .job-description, #content, .content');
      return main ? main.innerText : document.body.innerText;
    });
    return content.slice(0, 5000); // Limit to 5k chars
  } catch (e) {
    return '';
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

function extractRequirements(jdText) {
  const text = jdText.toLowerCase();
  const requirements = [];
  
  // Skill keywords to look for
  const skillMap = {
    'automation': ['automation', 'automate', 'automated', 'workflow', 'orchestrat'],
    'ai': [' ai ', 'artificial intelligence', 'machine learning', 'ml ', 'llm', 'gpt', 'claude', 'gemini'],
    'marketing': ['marketing', 'demand gen', 'demand generation', 'growth', 'content', 'seo', 'email marketing'],
    'lead_generation': ['lead gen', 'lead generation', 'outreach', 'cold email', 'prospecting', 'pipeline'],
    'n8n': ['n8n', 'zapier', 'make.com', 'integromat'],
    'typescript': ['typescript', 'node.js', 'nodejs', 'javascript'],
    'python': ['python'],
    'api': ['api', 'webhook', 'integration', 'rest api'],
    'remote': ['remote', 'distributed', 'async', 'anywhere'],
    'gtm': ['gtm', 'go-to-market', 'go to market'],
    'revops': ['revops', 'revenue ops', 'operations'],
    'voice': ['voice', 'vapi', 'bland', 'call center', 'phone'],
    'content': ['content', 'copywriting', 'blog', 'video', 'youtube'],
    'facebook': ['facebook', 'meta', 'social media'],
    'email': ['email', 'newsletter', 'drip', 'nurture'],
  };
  
  for (const [skill, keywords] of Object.entries(skillMap)) {
    if (keywords.some(kw => text.includes(kw))) {
      requirements.push(skill);
    }
  }
  
  return requirements;
}

function matchToExperience(requirements, profile) {
  const superpowers = profile?.narrative?.superpowers || [];
  const proofPoints = profile?.narrative?.proof_points || [];
  const matches = [];
  
  const experienceMap = {
    'automation': { superpower: 'End-to-end automation pipeline design', proof: 'Fiesta Fresh Cleaning' },
    'ai': { superpower: 'Multi-agent orchestration and AI voice agents', proof: 'Lumi and Milo' },
    'marketing': { superpower: 'Marketing automation across Facebook, email, SEO, and web', proof: 'Evolve Marketing' },
    'lead_generation': { superpower: 'B2B lead generation and cold outreach automation', proof: 'Fiesta Fresh Cleaning' },
    'n8n': { superpower: 'End-to-end automation pipeline design (Google Antigravity, n8n, Make)', proof: 'Fiesta Fresh Cleaning' },
    'typescript': { superpower: 'End-to-end automation pipeline design (Node.js, Python)', proof: 'Fiesta Fresh Cleaning' },
    'python': { superpower: 'Multi-agent orchestration and AI voice agents (Gemini API)', proof: 'Lumi and Milo' },
    'api': { superpower: 'B2B lead generation and cold outreach automation', proof: 'Fiesta Fresh Cleaning' },
    'gtm': { superpower: 'End-to-end automation pipeline design', proof: 'Fiesta Fresh Cleaning' },
    'revops': { superpower: 'Marketing automation across Facebook, email, SEO, and web', proof: 'Fiesta Fresh Cleaning' },
    'voice': { superpower: 'Multi-agent orchestration and AI voice agents (Vapi, Bland AI)', proof: 'Fiesta Fresh Cleaning' },
    'content': { superpower: 'Content production pipelines (script to publish)', proof: 'Lumi and Milo' },
    'facebook': { superpower: 'Marketing automation across Facebook', proof: 'Fiesta Fresh Cleaning' },
    'email': { superpower: 'B2B lead generation and cold outreach automation', proof: 'Fiesta Fresh Cleaning' },
    'remote': { superpower: 'Managed full-funnel digital campaigns in a fully remote, async-first team', proof: 'Evolve Marketing' },
  };
  
  for (const req of requirements) {
    if (experienceMap[req]) {
      const match = experienceMap[req];
      const proof = proofPoints.find(p => p.name === match.proof);
      matches.push({
        skill: req,
        superpower: match.superpower,
        proof: proof ? proof.hero_metric : match.proof,
      });
    }
  }
  
  return matches;
}

function generatePersonalizedEmail(company, role, jdText, profileData, jobUrl) {
  const requirements = extractRequirements(jdText);
  const matches = matchToExperience(requirements, profileData);

  let email = "";
  if (jobUrl) {
    email += `${jobUrl}\n\n`;
  }

  email += `I believe I'm the perfect candidate for the ${role} position.\n\n`;

  email += `A little about me, I'm ${userCreds.fullName}, a ${role} based in ${userCreds.location || 'Australia'}. Over the past 6 years, I've designed, coded, and deployed end-to-end automation systems across three businesses I founded. Not the kind of automation you set and forget, I'm talking about pipelines that run 24/7: scraping prospects, generating personalized reports, sending cold outreach, deploying websites, and booking meetings through AI voice agents, all with zero manual input. I've written every line of code, debugged workflows at 2am, and iterated until each system worked flawlessly. That's the level of care I'd bring to ${company}.\n\n`;

  if (matches.length > 0) {
    const topMatches = matches.slice(0, 3);
    email += `What excites me about the ${role} position at ${company} is how closely it aligns with these areas I've been perfecting: `;
    const achievementSentences = topMatches.map(match => {
      const proofText = match.proof.includes(':') ? match.proof.split(':')[1].trim() : match.proof;
      const cleanProof = proofText
        .replace(/^Fully /, 'Built a fully ')
        .replace(/^Automated /, 'Built an automated ')
        .replace(/^Managed /, 'Managed ');
      let sentence = cleanProof.charAt(0).toUpperCase() + cleanProof.slice(1);
      if (!sentence.endsWith('.')) sentence += '.';
      return sentence;
    });
    email += achievementSentences.join(' ') + `\n\n`;
    email += `These aren't just bullet points from a resume, they're systems I've built from scratch that are still running today, generating real results without any human intervention. I believe ${company} would benefit from this same hands-on approach.\n\n`;
  } else {
    email += `What draws me to ${company} isn't just the ${role} title, it's the kind of challenges I'd get to work on. I build AI-powered automation that replaces manual operations with intelligent workflows, and I've done it across marketing, sales, content production, and customer acquisition. I don't just configure tools, I build the tools myself, from the first line of code to the production deployment.\n\n`;
  }

  email += `Furthermore, I speak fluently English, Spanish (Native), Italian, and basic French. This linguistic background uniquely positions me to build trust and effectively communicate with diverse, international clients across multiple regions.\n\n`;

  email += `I understand finding a reliable worker is hard nowadays but I'm confident I'm the right fit for you so I offer you one day of my services for free so you can see what I have to offer.\n\n`;
  email += `My CV, cover letter, and reference letter are attached for your review.\n\n`;

  email += `With gratitude and warm regards,\n`;
  email += `${userCreds.fullName}\n`;
  email += `${userCreds.email} | ${userCreds.phone}\n`;
  email += `${userCreds.website}`;

  // Make absolutely sure there are no remaining dashes/hyphens used as dashes
  email = email
    .replace(/ — /g, ', ')
    .replace(/ – /g, ', ')
    .replace(/ - /g, ', ');

  return email;
}

// ─── Find Company Email ─────────────────────────────────────────────────────

async function extractEmailsFromPage(url) {
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const content = await page.content();
    
    // Extract all emails from page content
    const emailRegex = /[\w.+-]+@[\w.-]+\.\w{2,}/g;
    const found = content.match(emailRegex) || [];
    
    // Filter out junk emails
    const junk = ['example.com', 'email.com', 'test.com', 'sentry.io', 'wixpress.com', 
                  'w3.org', 'schema.org', 'googleapis.com', 'google.com', 'facebook.com',
                  'javascript:', 'noreply', 'no-reply', 'donotreply', 'abuse@',
                  'hero_1@2x', 'hero_2@2x', 'culture_1@2x', 'light-bulb@2x', 'slight-tilt@2x'];
    return found.filter(e => !junk.some(j => e.toLowerCase().includes(j)));
  } catch (e) {
    return [];
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

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

async function findCompanyEmail(job) {
  console.log(`   🔍 Searching for real verified ${job.company} recruiter email...`);
  const domain = await getCompanyDomain(job.company, job.url);
  console.log(`   🌐 Verified Company Domain: ${domain}`);
  
  // Generic placeholders to reject
  const genericPlaceholders = ['example.com', 'test.com', 'wixpress.com', 'sentry.io', 'schema.org'];

  // Method 1: Hunter.io API (if key exists)
  if (emailConfig?.hunter?.api_key) {
    try {
      console.log(`   🏹 Using Hunter.io to find emails for ${domain}...`);
      const EmailHunter = (await import('email-hunter')).default;
      const hunter = new EmailHunter(emailConfig.hunter.api_key);
      const res = await new Promise((resolve, reject) => {
        hunter.domainSearch({ domain }, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
      if (res.data?.emails?.length > 0) {
        const bestEmail = res.data.emails[0].value;
        console.log(`   ✅ Found verified recruiter email via Hunter API: ${bestEmail}`);
        return bestEmail;
      }
    } catch (e) {
      console.log(`   ⚠️  Hunter API failed: ${e.message}`);
    }
  }

  // Method 2: Extract real emails directly from the job posting page
  const jobPageEmails = await extractEmailsFromPage(job.url);
  const realJobEmails = jobPageEmails.filter(e => !genericPlaceholders.some(g => e.toLowerCase().includes(g)));
  if (realJobEmails.length > 0) {
    console.log(`   ✅ Found verified recruiter email on job page: ${realJobEmails[0]}`);
    return realJobEmails[0];
  }
  
  // Method 3: Search web for real recruiter email using strict domain
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const query = encodeURIComponent(`"@${domain}" recruiter OR "hiring manager" OR "talent acquisition"`);
    await page.goto(`https://html.duckduckgo.com/html/?q=${query}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const text = await page.content();
    await browser.close();
    
    const emailRegex = /[\w.+-]+@[\w.-]+\.\w{2,}/g;
    const matches = text.match(emailRegex) || [];
    const filtered = matches.filter(e => 
      e.toLowerCase().endsWith(`@${domain.toLowerCase()}`) && !genericPlaceholders.some(g => e.toLowerCase().includes(g))
    );
    if (filtered.length > 0) {
      console.log(`   ✅ Found verified recruiter email via web search: ${filtered[0]}`);
      return filtered[0];
    }
  } catch (e) {}
  
  console.log(`   ⚠️ No verified named recruiter email found for ${job.company} — relying strictly on Playwright ATS form submission.`);
  return null;
}



// ─── Scan ──────────────────────────────────────────────────────────────────

// Wall-clock minutes the reverse-ATS sweep may consume per cycle. The full
// dataset is ~38,900 boards (about an hour), far longer than one hourly cycle,
// so it is walked a slice at a time via its checkpoint.
const SWEEP_BUDGET_MIN = Number(process.env.SWEEP_BUDGET_MIN) || 8;
// Backlog size at which a cycle skips discovery and spends everything on
// evaluation. Discovery is worthless while scored jobs are waiting for
// documents, which is how 182 jobs accumulated unprocessed.
const EVAL_FIRST_BACKLOG = Number(process.env.EVAL_FIRST_BACKLOG) || 25;

async function scanForJobs() {
  console.log('📡 Scanning job portals...');
  const urls = new Set();
  let scanOk = false;
  let scanError = null;

  // ── 1. Tracked companies + job boards via scan.mjs --json ──────────────
  // stderr is deliberately NOT discarded: it carries the human log and any
  // stack trace. Swallowing it is what hid this failure for weeks.
  try {
    const raw = execSync('node scan.mjs --json', {
      encoding: 'utf8',
      cwd: __dirname,
      timeout: 15 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    // Defensive parse: take the last non-empty line so a stray stdout write
    // from a dependency cannot break the contract.
    const line = raw.split('\n').map(l => l.trim()).filter(Boolean).pop();
    if (!line) throw new Error('scan.mjs --json produced no stdout');
    const data = JSON.parse(line);

    if (data.ok === false) {
      throw new Error(`scan.mjs reported failure: ${data.error || 'unknown'}`);
    }
    if (!Array.isArray(data.new_urls)) {
      throw new Error('scan.mjs --json response is missing the new_urls array');
    }

    for (const u of data.new_urls) if (u) urls.add(u);
    scanOk = true;
    const c = data.counts || {};
    console.log(
      `   ✅ portal scan: ${data.new_urls.length} new url(s) ` +
      `(found ${c.found ?? '?'}, dupes ${c.dupes ?? '?'}, errors ${c.errors ?? '?'})`
    );
  } catch (err) {
    scanError = err.message;
    // LOUD. A scan failure is a real incident, not a footnote: with no new
    // urls the entire cycle does nothing, so it must be visible in the log.
    console.error(`   ❌ PORTAL SCAN FAILED: ${err.message}`);
    console.error('      No new URLs from scan.mjs this cycle — the ATS sweep below still runs.');
  }

  // ── 2. Reverse-ATS sweep — ALWAYS runs ────────────────────────────────
  // Previously this sat inside the try block above, after the JSON.parse that
  // always threw, so the broadest source of jobs never executed at all.
  console.log('📡 Scanning all ATS directories (Greenhouse/Lever/Ashby/Workday)...');
  try {
    // --resume picks up at the checkpointed board, so consecutive cycles walk
    // the dataset instead of restarting at greenhouse and never reaching icims.
    // --max-minutes makes the sweep yield the cycle while there is still time
    // to score jobs and generate documents; the external timeout below is only
    // a backstop for a sweep that ignores its own budget.
    execSync(`node scan-ats-full.mjs --since 3 --resume --max-minutes ${SWEEP_BUDGET_MIN}`, {
      encoding: 'utf8',
      cwd: __dirname,
      timeout: (SWEEP_BUDGET_MIN + 5) * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    console.log('   ✅ ATS directory sweep completed');
  } catch (atsErr) {
    console.error(`   ❌ ATS FULL SCAN FAILED: ${atsErr.message}`);
  }

  // ── 3. Anything the sweep appended to pipeline.md counts too ──────────
  // scan-ats-full.mjs writes straight to pipeline.md rather than returning
  // urls. The caller snapshots pending BEFORE this function runs, so without
  // this fold-in those rows would sit unseen until the next cycle. Returning
  // them as urls is safe: the caller only appends urls pipeline.md lacks.
  // getPendingFromPipeline() yields objects, so take .url.
  try {
    for (const job of getPendingFromPipeline()) if (job?.url) urls.add(job.url);
  } catch (pipeErr) {
    console.error(`   ⚠️  could not read pipeline.md: ${pipeErr.message}`);
  }

  const all = [...urls];
  if (all.length === 0) {
    console.error(
      '   ❌ NO JOBS FOUND FROM ANY SOURCE this cycle' +
      (scanOk ? '' : ` (portal scan failed: ${scanError})`)
    );
  } else {
    console.log(`   📥 ${all.length} candidate url(s) from all sources`);
  }
  return all;
}

function markJobCompletedInPipeline(url) {
  if (KEEP_PIPELINE) {
    console.log(`   ⏭️  [KEEP_PIPELINE] Skipping markdown check-off for: ${url}`);
    return;
  }
  try {
    const pipelinePath = join(__dirname, 'data/pipeline.md');
    if (!existsSync(pipelinePath)) return;
    let content = readFileSync(pipelinePath, 'utf8');
    const escapedUrl = url.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`^\\s*-\\s*\\[\\s*\\]\\s*(${escapedUrl}.*)$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, '- [x] $1');
      writeFileSync(pipelinePath, content, 'utf8');
    }
  } catch (e) {
    console.error(`⚠️ Failed to check off job in pipeline.md: ${e.message}`);
  }
}

function getPendingFromPipeline() {
  const pipelinePath = join(__dirname, 'data/pipeline.md');
  if (!existsSync(pipelinePath)) return [];
  
  const content = readFileSync(pipelinePath, 'utf8');
  const pending = [];
  const lines = content.split('\n');
  let inPending = false;
  
  for (const line of lines) {
    if (line.includes('## Pending')) { inPending = true; continue; }
    if (line.includes('## Processed')) { inPending = false; continue; }
    if (inPending && line.startsWith('- [ ]')) {
      const urlMatch = line.match(/https?:\/\/[^\s|]+/);
      if (urlMatch) {
        const parts = line.split('|').map(s => s.trim());
        pending.push({
          url: urlMatch[0],
          company: parts[1] || 'Unknown',
          role: parts[2] || 'Unknown',
          raw: line,
        });
      }
    }
  }
  return pending;
}

// ─── Pre-screen ────────────────────────────────────────────────────────────

function preScreen(job, userProfile) {
  const title = (job.role || job.title || '').toLowerCase();
  const raw = (job.raw || `${job.title || ''} ${job.company || ''} ${job.description || ''}`).toLowerCase();
  
  if (maxAgeArg) {
    const postedMatch = job.raw?.match(/posted:\s*(20\d{2}-\d{2}-\d{2})/i);
    if (postedMatch) {
      const postedDate = new Date(postedMatch[1]);
      const now = new Date();
      const ageDays = (now - postedDate) / (1000 * 60 * 60 * 24);
      if (ageDays > maxAgeArg) {
        return { pass: false, reason: `Posted ${Math.round(ageDays)} days ago (older than ${maxAgeArg} days limit)`, skipMarkCompleted: true };
      }
    }
  }

  // Use DB profile target roles if available, fall back to defaults
  let targetRoles = [];
  const rawTarget = userProfile?.targetRoles || userProfile?.target_roles;
  if (Array.isArray(rawTarget)) {
    targetRoles = rawTarget.map(r => r.toLowerCase());
  } else if (rawTarget && typeof rawTarget === 'object') {
    const list = rawTarget.primary || [];
    if (Array.isArray(list)) {
      targetRoles = list.map(r => r.toLowerCase());
    }
  }
  let targetKeywords = [];
  if (targetRoles.length > 0) {
    for (const role of targetRoles) {
      const words = role.split(/[\s/&,]+/)
        .map(w => w.trim().toLowerCase())
        .filter(w => w.length > 2 && w !== 'and' && w !== 'with' && w !== 'for' && w !== 'the');
      targetKeywords.push(...words);
      targetKeywords.push(role.toLowerCase());
    }
    targetKeywords = Array.from(new Set(targetKeywords));
  } else {
    targetKeywords = [
      'ai', 'automation', 'marketing', 'gtm', 'operations', 'agent',
      'workflow', 'growth', 'demand gen', 'revops', 'revenue ops',
      'product ops', 'sales ops', 'enablement', 'strategy',
      'qa', 'tester', 'testing', 'engineer', 'quality assurance'
    ];

  }
  
  // Use DB profile employment type to decide exclusions
  const empTypes = (userProfile?.employmentType || userProfile?.employment_type || []).map(t => t.toLowerCase());
  const excludeKeywords = [
    'senior researcher', 'staff engineer', 'principal engineer',
    'director', 'vp of', 'fellow', 'intern', 'junior',
    'devops', 'sre', 'platform engineer', 'systems architect',
  ];
  
  // Geo filtering based on jobType preference
  const jobTypes = userProfile?.jobType || userProfile?.job_type || ['remote'];
  const prefersRemote = jobTypes.includes('remote');
  
  let geoBlockers = [];
  if (prefersRemote) {
    geoBlockers = [
      'on-site', 'onsite', 'in-office',
      'new york', 'san francisco', 'los angeles', 'seattle',
      'london', 'berlin', 'munich', 'paris', 'tokyo',
      'singapore', 'hong kong'
    ];
  }
  
  // Profile-specific cross-domain exclusion rules (prevent account job leaks)
  if (targetUserId === 'support_worker') {
    const techBlockers = ['software', 'engineer', 'developer', 'qa', 'devops', 'marketing', 'gtm', 'ai specialist', 'data engineer'];
    if (techBlockers.some(k => title.includes(k))) {
      return { pass: false, reason: `Support Care profile excluded tech role: ${title}` };
    }
  } else {
    const careAndRoleBlockers = ['support worker', 'disability support', 'aged care', 'ndis coordinator', 'care coordinator'];
    if (careAndRoleBlockers.some(k => title.includes(k))) {
      return { pass: false, reason: `Primary profile excluded care role: ${title}` };
    }
  }

  const hasTarget = targetKeywords.some(k => title.includes(k) || raw.includes(k));
  const hasExclude = excludeKeywords.some(k => title.includes(k));
  const hasGeoBlock = geoBlockers.some(g => raw.includes(g));
  const isRemote = raw.includes('remote');
  
  if (hasExclude) return { pass: false, reason: `Title mismatch: ${title}` };
  if (hasGeoBlock && !isRemote) return { pass: false, reason: 'Geo-restricted, not remote' };
  if (!hasTarget && !isRemote) return { pass: false, reason: 'No target keywords, not remote' };
  
  return { pass: true, reason: 'Matches target profile' };
}

// ─── Enhanced Scoring (uses lib/scorer.mjs — LLM via Ollama + keyword fallback) ──

let scoreJobFn = null;
let llmScoreJobFn = null;
let isOllamaAvailableFn = null;
let ollamaAvailable = false;
// Gating LLM scoring on Ollama alone meant a configured Gemini key was ignored
// and every job silently fell back to keyword scoring.
let llmAvailable = false;
let llmBackend = 'keyword';

async function loadScorer() {
  if (scoreJobFn) return scoreJobFn;
  try {
    const scorer = await import('./lib/scorer.mjs');
    scoreJobFn = scorer.scoreJob;
    llmScoreJobFn = scorer.llmScoreJob;
    isOllamaAvailableFn = scorer.isOllamaAvailable;
    // Check Ollama availability once at startup
    ollamaAvailable = await isOllamaAvailableFn();
    if (typeof scorer.isLlmAvailable === 'function') {
      llmAvailable = await scorer.isLlmAvailable();
      llmBackend = typeof scorer.llmBackendName === 'function' ? scorer.llmBackendName() : 'LLM';
    } else {
      llmAvailable = ollamaAvailable;
      llmBackend = 'Ollama';
    }
    if (llmAvailable) {
      console.log(`   🧠 LLM scoring via ${llmBackend}`);
    } else {
      console.log('   📊 No LLM backend reachable — keyword scoring only.');
      console.log('      Keyword scores cap below the 4.0 threshold, so no documents will be generated.');
      console.log('      Set GEMINI_API_KEY (or run Ollama) to enable real scoring.');
    }
    return scoreJobFn;
  } catch (e) {
    console.log(`   ⚠️  Could not load scorer: ${e.message.slice(0, 80)}`);
    return null;
  }
}

// ─── Document Generators ───────────────────────────────────────────────────

let cvGeneratorFn = null;
let clGeneratorFn = null;
let rlGeneratorFn = null;

async function loadGenerators() {
  if (!cvGeneratorFn) {
    try {
      const cvGen = await import('./lib/cv-generator.mjs');
      cvGeneratorFn = cvGen.generateCV;
    } catch (e) {
      console.log(`   ⚠️  CV generator not available: ${e.message.slice(0, 80)}`);
    }
  }
  if (!clGeneratorFn) {
    try {
      const clGen = await import('./lib/cover-letter-generator.mjs');
      clGeneratorFn = clGen.generateCoverLetter;
    } catch (e) {
      console.log(`   ⚠️  Cover letter generator not available: ${e.message.slice(0, 80)}`);
    }
  }
  if (!rlGeneratorFn) {
    try {
      const rlGen = await import('./lib/reference-letter-generator.mjs');
      rlGeneratorFn = rlGen.generateReferenceLetter;
    } catch (e) {
      console.log(`   ⚠️  Reference letter generator not available: ${e.message.slice(0, 80)}`);
    }
  }
}

// ─── Generate Tailored CV ──────────────────────────────────────────────────

async function generateTailoredCV(company, role, jdText = '') {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const htmlPath = join(__dirname, `output/cv-candidate-${slug}-${TODAY}.html`);
  const pdfPath = join(__dirname, `output/cv-candidate-${slug}-${TODAY}.pdf`);
  
  // 1. Prioritize dynamic generation (tailoring) for EVERY job
  const mdFileName = targetUserId === 'support_worker' ? 'cv-support.md' : 'cv.md';
  const cvMdPath = join(__dirname, mdFileName);
  
  let useStaticDbResume = false;
  if (!existsSync(cvMdPath)) {
    console.log(`   ⚠️ No ${mdFileName} found. Will attempt to use static DB resume as fallback.`);
    useStaticDbResume = true;
  }
  
  if (!useStaticDbResume) {
    const profileForDoc = userId ? dbProfile : {
      fullName: userCreds.fullName,
      phone: userCreds.phone,
      email: userCreds.email,
      location: userCreds.location,
      portfolioUrl: userCreds.website,
    };

    try {
      const cvGen = await import('./lib/cv-generator.mjs');
      const html = await cvGen.generateCVHtmlAsync(profileForDoc, jdText, cvMdPath);
      writeFileSync(htmlPath, html, 'utf8');
      
      // Generate PDF
      const cvMdFlag = `--cv-md="${cvMdPath}"`;
      const { execSync } = await import('child_process');
      execSync(
        `node generate-pdf.mjs "${htmlPath}" "${pdfPath}" --format=letter --report=000 ${cvMdFlag}`,
        { encoding: 'utf8', cwd: __dirname, timeout: 30000 }
      );
      
      // Successfully generated tailored CV!
      return { htmlPath, pdfPath, success: true };
    } catch (e) {
      console.log(`   ❌ Tailored CV generation failed: ${e.message.slice(0, 80)}. Falling back...`);
      useStaticDbResume = true; // Fallback to DB resume
    }
  }

  // 2. Fallback to static DB resume
  if (useStaticDbResume && userId && userCreds.resumeUrl && targetUserId !== 'support_worker') {
    try {
      let base64Data = userCreds.resumeUrl;
      if (base64Data.includes(',')) {
        base64Data = base64Data.split(',')[1];
      }
      if (base64Data && base64Data.length > 100) {
        const buffer = Buffer.from(base64Data, 'base64');
        writeFileSync(pdfPath, buffer);
        console.log(`   ✅ Decoded static resume from DB: ${pdfPath} (${(buffer.length / 1024).toFixed(1)} KB)`);
        return { htmlPath: null, pdfPath, success: true };
      }
    } catch (e) {
      console.log(`   ⚠️  Failed to decode DB resume: ${e.message.slice(0, 80)}`);
    }
  }
  
  console.log(`   ❌ No resume available (Tailoring failed & DB decode failed)`);
  return { htmlPath: null, pdfPath: null, success: false };
}

function extractExperienceHTML(cv) {
  // Extract from cv.md and format as HTML
  return `
    <div class="job">
      <div class="job-header">
        <span class="job-company">Fiesta Fresh Cleaning</span>
        <span class="job-period">Apr 2026 – Present</span>
      </div>
      <div class="job-role">Founder and Automation Engineer</div>
      <ul>
        <li>Architected a fully automated B2B lead generation engine using Google Antigravity and n8n that scrapes qualified prospects daily, analyzes websites for performance gaps, and auto-generates personalized audit reports with zero manual input per cycle.</li>
        <li>Engineered a triggered cold email sequence that auto-fires post-audit, delivering personalized outreach to hundreds of prospects simultaneously and eliminating all manual top-of-funnel effort.</li>
        <li>Integrated a Vapi and Node.js AI voice calling system that contacts warm leads, handles objections, and books discovery calls 24/7, reducing appointment booking from hours of manual outreach to zero.</li>
        <li>Coded a JavaScript conversion pipeline that automatically builds and deploys a fully customized website upon prospect engagement, compressing delivery timelines from weeks to hours.</li>
      </ul>
    </div>
    <div class="job">
      <div class="job-header">
        <span class="job-company">Lumi and Milo</span>
        <span class="job-period">May 2026 – Present</span>
      </div>
      <div class="job-role">Founder and Automation Architect</div>
      <ul>
        <li>Designed and deployed a Python and Gemini API YouTube content pipeline that orchestrates script generation, visual creation, voiceover synthesis, and video assembly from a single triggered workflow.</li>
        <li>Built a secondary AI quality control agent via Google Antigravity multi-agent orchestration that reviews all output for tone, pacing, and brand consistency prior to human approval.</li>
        <li>Reduced human involvement across the entire production process to a single click, after which the system autonomously formats, titles, tags, and publishes content to YouTube.</li>
      </ul>
    </div>
    <div class="job">
      <div class="job-header">
        <span class="job-company">Fiesta Fresh Cleaning</span>
        <span class="job-period">Oct 2025 – Present</span>
      </div>
      <div class="job-role">Co-Owner and Marketing Automation Specialist</div>
      <ul>
        <li>Coded a Node.js Facebook automation application that publishes daily organic-format posts to business pages, maintaining consistent brand engagement with no manual scheduling.</li>
        <li>Built a Facebook Graph API webhook script that detects purchase-intent posts in real time and auto-responds with tailored outreach, capturing leads at the exact moment of intent.</li>
        <li>Engineered a Python lead scraping and cold email system that surfaces qualified prospects and feeds them into an automated multi-touch nurture sequence.</li>
        <li>Deployed a Bland AI voice agent that autonomously qualifies leads and books appointments, eliminating all manual follow-up from the sales process.</li>
      </ul>
    </div>
    <div class="job">
      <div class="job-header">
        <span class="job-company">Evolve Marketing</span>
        <span class="job-period">Jan 2024 – Oct 2025</span>
      </div>
      <div class="job-role">AI Digital Marketing and Web Specialist</div>
      <ul>
        <li>Planned and executed full-funnel digital campaigns across social, email, and web for multiple simultaneous product launches, managing all deliverables asynchronously across distributed, multi-timezone remote teams.</li>
        <li>Integrated AI tools into the content production workflow to systematize brief creation, drafting, and visual production, freeing bandwidth for strategy and client relationship management.</li>
        <li>Built audience segmentation frameworks from first-party research, sharpening paid campaign targeting and improving engagement performance across all managed accounts.</li>
      </ul>
    </div>`;
}

function extractEducationHTML(cv) {
  return `
    <div class="edu-item">
      <div class="edu-header">
        <span class="edu-title">Advanced Diploma of Leadership and Management</span>
        <span class="edu-year">Apr 2026 – May 2027</span>
      </div>
      <div class="edu-org">Academique | Gold Coast, Australia</div>
    </div>
    <div class="edu-item">
      <div class="edu-header">
        <span class="edu-title">Bachelor of Marketing</span>
        <span class="edu-year">Apr 2025 – Apr 2028</span>
      </div>
      <div class="edu-org">University of London | Remote</div>
    </div>`;
}

function extractCertsHTML(cv) {
  return `
    <div class="cert-item"><span class="cert-title">AI Fluency for Small Business</span><span class="cert-org">Anthropic</span><span class="cert-year">2025</span></div>
    <div class="cert-item"><span class="cert-title">AI Fluency: Frameworks and Foundations</span><span class="cert-org">Anthropic</span><span class="cert-year">2025</span></div>
    <div class="cert-item"><span class="cert-title">Claude with Google Vertex AI</span><span class="cert-org">Anthropic</span><span class="cert-year">2025</span></div>
    <div class="cert-item"><span class="cert-title">AI Fundamentals</span><span class="cert-org">Google</span><span class="cert-year">2025</span></div>
    <div class="cert-item"><span class="cert-title">Email Marketing Certification</span><span class="cert-org">HubSpot Academy</span><span class="cert-year">2025</span></div>`;
}

function extractSkillsHTML(cv) {
  return `
    <div class="skills-grid">
      <div><span class="skill-category">AI & Automation:</span> <span class="skill-item">n8n, Claude API, Gemini API, Vapi, Bland AI</span></div>
      <div><span class="skill-category">Languages:</span> <span class="skill-item">TypeScript, Node.js, Python, HTML, CSS, REST APIs, Webhooks</span></div>
      <div><span class="skill-category">Platforms:</span> <span class="skill-item">WordPress, Shopify, Firebase, Supabase</span></div>
      <div><span class="skill-category">Marketing:</span> <span class="skill-item">Facebook Ads, Google Analytics, GA4, SEO, Email Funnels, Cold Email</span></div>
    </div>`;
}

// ─── Generate Cover Letter ─────────────────────────────────────────────────

function generateCoverLetter(company, role) {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const path = join(__dirname, `output/cover-letter-${slug}-${TODAY}.md`);
  
  const template = existsSync(join(__dirname, 'templates/cover-letter-template.md'))
    ? readFileSync(join(__dirname, 'templates/cover-letter-template.md'), 'utf8')
    : `Dear {{COMPANY}} Hiring Team,\n\nI build AI-powered automation systems that replace manual operations with intelligent workflows. With over 6 years of experience across three businesses I founded, I bring a unique combination of technical depth and business outcomes.\n\nAt Fiesta Fresh Cleaning, I built a fully automated B2B lead generation system that scrapes prospects, generates personalized audits, sends cold email, and books discovery calls through an AI voice agent, all with zero manual input. At Lumi and Milo, I designed a multi-agent orchestration system with a dedicated QC agent.\n\nI am fluent in TypeScript, Node.js, Python, REST APIs, and webhooks. I develop with Claude, Cursor, and multi-agent orchestration as my primary tools. I do not just evaluate AI tools; I build production systems with them.\n\nI would welcome the chance to discuss how my experience can contribute to {{COMPANY}}'s growth.\n\nBest regards,\n{{FULL_NAME}}\n{{EMAIL}} | {{PHONE}}\n{{WEBSITE}}`;
  
  const letter = template
    .replace(/\{\{COMPANY\}\}/g, company)
    .replace(/\{\{ROLE\}\}/g, role)
    .replace(/\{\{FULL_NAME\}\}/g, userCreds.fullName)
    .replace(/\{\{EMAIL\}\}/g, userCreds.email)
    .replace(/\{\{PHONE\}\}/g, userCreds.phone)
    .replace(/\{\{WEBSITE\}\}/g, userCreds.website);
  
  writeFileSync(path, letter);
  return path;
}

// ─── Report Generator ──────────────────────────────────────────────────────

function generateReport(applications, stats) {
  let report = `# Daily Application Report — ${TODAY}\n\n`;
  report += `## Summary\n`;
  report += `- **Jobs scanned:** ${stats.scanned}\n`;
  report += `- **Pre-screened:** ${stats.screened}\n`;
  report += `- **Applications submitted:** ${stats.sent}\n`;
  report += `- **Skipped:** ${stats.skipped}\n\n`;
  
  if (applications.length > 0) {
    report += `## Applications Submitted\n\n`;
    report += `| # | Company | Role | Method | Status | Verify |\n`;
    report += `|---|---------|------|--------|--------|--------|\n`;
    for (const app of applications) {
      const verifyLink = app.atsUrl ? `[Check Status](${app.atsUrl})` : 'N/A';
      report += `| ${app.num} | ${app.company} | ${app.role} | ${app.method} | ${app.status} | ${verifyLink} |\n`;
    }
    report += `\n`;
  }
  
  if (stats.skippedJobs.length > 0) {
    report += `## Skipped Jobs\n\n`;
    report += `| Company | Role | Reason |\n`;
    report += `|---------|------|--------|\n`;
    for (const job of stats.skippedJobs) {
      report += `| ${job.company} | ${job.role} | ${job.reason} |\n`;
    }
    report += `\n`;
  }
  
  // Verification section
  report += `## How to Verify Applications\n\n`;
  report += `### Check Application Status\n\n`;
  report += `Each ATS has its own status check page:\n\n`;
  report += `| ATS | How to Check Status |\n`;
  report += `|-----|---------------------|\n`;
  report += `| **Greenhouse** | Visit the job URL directly. If you see "Application Received" or your email in the form, you applied. |\n`;
  report += `| **Ashby** | Check your email for a confirmation from Ashby. Also visit the job URL and click "Apply" — if it shows your existing application, you're in. |\n`;
  report += `| **Lever** | Check email for apply.lever.co confirmation. Visit apply.lever.co/<company> to see your applications. |\n`;
  report += `\n`;
  report += `### Email Confirmation\n\n`;
  report += `- Check your inbox at **${userCreds.email}** for confirmation emails from Greenhouse, Ashby, or Lever\n`;
  report += `- Search for subject lines containing "application", "received", or the company name\n`;
  report += `- Some ATS platforms send a confirmation within minutes, others within 24 hours\n\n`;
  report += `### Manual Verification\n\n`;
  report += `For each application in the table above:\n`;
  report += `1. Click the "Check Status" link to visit the job posting\n`;
  report += `2. If the form shows your information pre-filled, you applied successfully\n`;
  report += `3. If the form is blank, the application may not have gone through — reapply manually\n\n`;
  report += `### What Was Submitted\n\n`;
  report += `Each application included:\n`;
  report += `- Tailored CV (PDF) with portfolio link\n`;
  report += `- Tailored cover letter\n`;
  report += `- ATS form auto-filled (name, email, phone, website, custom questions)\n`;
  report += `- Resume + cover letter uploaded to ATS\n`;
  report += `\n`;
  report += `---\nGenerated by career-ops auto-apply pipeline\n`;
  report += `Report saved: output/daily-report-${TODAY}.md\n`;
  
  return report;
}

// ─── Main Pipeline ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀 Career-Ops Auto-Apply Pipeline — ${TODAY}\n`);
  if (DRY_RUN) console.log('⚠️  DRY RUN MODE — no emails or applications will be sent\n');
  
  // Ensure output directory exists
  mkdirSync(join(__dirname, 'output'), { recursive: true });
  
  const stats = { scanned: 0, screened: 0, sent: 0, skipped: 0, skippedJobs: [] };
  const applications = [];
  
  // Step 1: Get pending jobs
  let pending = [];
  
  if (userId && dbReader && !READ_LOCAL_PIPELINE) {
    // DB mode: read pending jobs from database
    console.log('📡 Reading pending jobs from database...');
    const dbJobs = await dbReader.getUserPendingJobs(userId, LIMIT);
    pending = dbJobs.map(j => ({
      url: j.url,
      company: j.company,
      role: j.title,
      raw: `${j.title} | ${j.company} | ${j.location || ''} | remote`,
      dbId: j.id,
      description: j.description,
      location: j.location,
      employmentType: j.employmentType,
      salary: j.salary,
      salaryMin: j.salaryMin,
      salaryMax: j.salaryMax,
      platform: j.platform,
    }));
    console.log(`   Found ${pending.length} pending jobs in database`);
  } else {
    // Local mode: scan and read from pipeline.md
    pending = getPendingFromPipeline();
    let newUrls = [];
    // Discovery is skipped, not merely shortened, when a backlog is already
    // waiting: the sweep can consume an entire cycle, and every minute it
    // spends finding job 183 is a minute not spent turning the first 182 into
    // documents and drafts. The next cycle resumes discovery once drained.
    const backlogFirst = pending.length >= EVAL_FIRST_BACKLOG;
    if (backlogFirst) {
      console.log(`⏭️  Skipping discovery this cycle — ${pending.length} jobs already pending (threshold ${EVAL_FIRST_BACKLOG}).`);
      console.log('   Evaluation, documents and drafts get the full cycle. Discovery resumes once the backlog drains.');
    }
    if (!READ_LOCAL_PIPELINE && !backlogFirst) {
      newUrls = await scanForJobs();
    }
    if (newUrls.length > 0) {
      console.log(`   Found ${newUrls.length} new URLs from scanner`);
      const pipelinePath = join(__dirname, 'data/pipeline.md');
      const content = readFileSync(pipelinePath, 'utf8');
      const processedSection = content.indexOf('## Processed');
      
      let newLines = '';
      for (const url of newUrls) {
        if (!content.includes(url)) newLines += `- [ ] ${url}\n`;
      }
      
      if (newLines) {
        const updated = content.slice(0, processedSection) + newLines + '\n' + content.slice(processedSection);
        writeFileSync(pipelinePath, updated);
        pending = getPendingFromPipeline();
      }
    }
  }
  
  stats.scanned = pending.length;
  console.log(`📋 Found ${pending.length} pending jobs\n`);
  
  // Step 2: Pre-screen
  const toProcess = [];
  for (const job of pending.slice(0, LIMIT)) {
    const screen = preScreen(job, dbProfile || profile);
    stats.screened++;
    if (!screen.pass) {
      console.log(`   ⏭️  ${job.company} — ${job.role}: ${screen.reason}`);
      stats.skipped++;
      stats.skippedJobs.push({ ...job, reason: screen.reason });
      if (!screen.skipMarkCompleted) {
        markJobCompletedInPipeline(job.url);
      }
      continue;
    }
    console.log(`   ✅ ${job.company} — ${job.role}: ${screen.reason}`);
    toProcess.push(job);
  }

  async function syncToLocalFiles(job, scoreResult, finalCvPath, finalClPath, emailSubject, emailBody) {
    if (userId && userId !== 'default') {
      return; // DB-mode multi-tenant profile: sync to DB only, do not write to shared single-tenant local files
    }
    try {
      const { execSync } = await import('child_process');
      const fs = await import('fs');
      const path = await import('path');
      
      console.log(`   📂 Persisting evaluated job to local applications tracker...`);
      
      // 1. Check if job is already in applications.md to prevent duplicate rows
      const trackerPath = path.join(__dirname, 'data/applications.md');
      if (fs.existsSync(trackerPath)) {
        const trackerContent = fs.readFileSync(trackerPath, 'utf8');
        if (trackerContent.includes(job.company) && trackerContent.includes(job.role || job.title)) {
          console.log(`   ⏭️  Job already exists in local applications tracker, skipping local sync`);
          return;
        }
      }
      
      // 2. Reserve a report number
      const reportNum = execSync('node reserve-report-num.mjs', { cwd: __dirname, encoding: 'utf8' }).trim();
      if (!reportNum || !/^\d+$/.test(reportNum)) {
        throw new Error(`Invalid report number reserved: ${reportNum}`);
      }
      
      // 3. Write local report file
      const slug = job.company.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
      const reportsDir = path.join(__dirname, 'reports');
      fs.mkdirSync(reportsDir, { recursive: true });
      
      const reportFilename = `${reportNum}-${slug}-${TODAY}.md`;
      const reportPath = path.join(reportsDir, reportFilename);
      
      const jobScore = scoreResult.score;
      const matchReasons = scoreResult.matchReasons || [];
      const whyMatch = Array.isArray(matchReasons) ? matchReasons.join(' ') : (matchReasons || '');
      
      const reportContent = `# Evaluation: ${job.company} — ${job.role || job.title}

**Date:** ${TODAY}
**URL:** ${job.url || ''}
**Via:** —
**Archetype:** Agentic Workflows / Automation
**Score:** ${jobScore}/5
**Legitimacy:** High Confidence
**PDF:** ✅

---

## Machine Summary

\`\`\`yaml
company: "${job.company}"
role: "${job.role || job.title}"
score: ${jobScore}
legitimacy_tier: "High Confidence"
archetype: "Agentic Workflows / Automation"
final_decision: "Apply"
\`\`\`

## A) Role Summary

| Field | Value |
|-------|-------|
| Score | ${jobScore}/5 |
| Match reasons | ${whyMatch} |

## B) Match with CV

${whyMatch}
`;
      fs.writeFileSync(reportPath, reportContent, 'utf8');
      console.log(`   📄 Local report file saved: ${reportPath}`);
      
      // 4. Write TSV row to tracker-additions
      const additionsDir = path.join(__dirname, 'batch/tracker-additions');
      fs.mkdirSync(additionsDir, { recursive: true });
      
      const tsvFilename = `${reportNum}-${slug}.tsv`;
      const tsvPath = path.join(additionsDir, tsvFilename);
      
      const tsvRow = `${reportNum}\t${TODAY}\t${job.company}\t${job.role || job.title}\tEvaluated\t${jobScore}/5\t✅\t[${reportNum}](reports/${reportFilename})\t${whyMatch.slice(0, 100).replace(/\s+/g, ' ')}\n`;
      fs.writeFileSync(tsvPath, tsvRow, 'utf8');
      
      // 5. Run merge-tracker.mjs to rebuild data/applications.md
      console.log(`   🔄 Rebuilding local applications tracker...`);
      execSync('node merge-tracker.mjs', { cwd: __dirname });
      console.log(`   ✅ Local applications tracker updated`);
      
    } catch (e) {
      console.log(`   ⚠️  Local tracker sync failed: ${e.message}`);
    }
  }
  
  // Step 3: Process each job
  const scorer = await loadScorer();
  await loadGenerators();
  
  for (const job of toProcess) {
    // Skip if already in local applications tracker
    const trackerPath = join(__dirname, 'data/applications.md');
    if (existsSync(trackerPath)) {
      const trackerContent = readFileSync(trackerPath, 'utf8');
      const isGenericCompany = !job.company || job.company === 'Unknown' || job.company.toLowerCase() === 'unknown';
      const isAlreadyTracked = isGenericCompany
        ? (job.url && trackerContent.includes(job.url))
        : (trackerContent.includes(job.company) && (trackerContent.includes(job.role || job.title) || (job.url && trackerContent.includes(job.url))));

      if (isAlreadyTracked) {
        console.log(`   ⏭️  ${job.company} — ${job.role || job.title}: Already in applications tracker, checking off in pipeline.md`);
        markJobCompletedInPipeline(job.url);
        continue;
      }
    }

    // Free-tier guard: skip cookie-based job boards (LinkedIn/Indeed/SEEK are VIP-only)
    const isCookiePlatform = JOB_BOARDS.some(p =>
      (job.url || '').includes(p) || (job.platform || '').includes(p)
    );
    if (!isVip && isCookiePlatform) {
      console.log(`   ⏭️  ${job.company} — ${job.role || job.title}: Cookie-based platform (VIP only)`);
      stats.skipped++;
      stats.skippedJobs.push({ ...job, reason: 'Cookie-based platform — VIP only' });
      continue;
    }

    console.log(`\n📝 Processing: ${job.company} — ${job.role || job.title}`);
    
    // Platform logic — all users auto-apply via cookies on job boards, API on ATS
    const isJobBoard = JOB_BOARDS.some(p => job.url?.includes(p) || job.platform?.includes(p));
    const isApiPlatform = API_PLATFORMS.some(p => job.platform?.includes(p)) || !isJobBoard;
    
    const slug = job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    
    // Enhanced scoring if available (LLM via Ollama or keyword fallback)
    let jobScore = job.score || 0;
    let matchReasons = job.matchReasons || [];
    let scoreResult = null;
    
    if (scorer && (!jobScore || jobScore === 0)) {
      const profileForScoring = userId ? {
        targetRoles: dbProfile?.targetRoles || [],
        jobType: dbProfile?.jobType || ['remote'],
        employmentType: dbProfile?.employmentType || ['contract'],
        salaryMin: dbProfile?.salaryMin,
        salaryMax: dbProfile?.salaryMax,
      } : {
        targetRoles: Array.isArray(profile?.target_roles)
          ? profile?.target_roles
          : (profile?.target_roles?.primary || ['AI Automation Specialist', 'Marketing Automation Engineer']),
        jobType: profile?.job_type || ['remote'],
        employmentType: profile?.employment_type || ['contract'],
        salaryMin: profile?.compensation?.minimum || 50,
        salaryMax: profile?.compensation?.maximum || 100,
      };
      
      const jobForScoring = {
        title: job.role || job.title,
        company: job.company,
        description: job.description || job.raw || '',
        salary: job.salary,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        location: job.location,
        employmentType: job.employmentType,
      };
      
      // LLM scoring (Ollama) for VIP users only; keyword scoring for everyone
      if (isVip && llmAvailable && llmScoreJobFn) {
        try {
          scoreResult = await llmScoreJobFn(jobForScoring, profileForScoring);
          console.log(`   🧠 LLM score: ${scoreResult.score}/5 [${scoreResult.source}] (${matchReasons.length} reasons)`);
        } catch (e) {
          console.log(`   ⚠️  LLM scoring failed, falling back to keyword: ${e.message.slice(0, 60)}`);
          scoreResult = scoreJobFn(jobForScoring, profileForScoring);
          console.log(`   📊 Keyword score: ${scoreResult.score}/5 (${scoreResult.matchReasons.length} reasons)`);
        }
      } else {
        scoreResult = scoreJobFn(jobForScoring, profileForScoring);
        const src = isVip ? 'keyword (Ollama unavailable)' : 'keyword';
        console.log(`   📊 ${src}: ${scoreResult.score}/5 (${scoreResult.matchReasons.length} reasons)`);
      }
      
      jobScore = scoreResult.score;
      matchReasons = scoreResult.matchReasons;
      
      // Update score in DB if available
      if (userId && dbWriter && job.dbId) {
        try {
          await dbWriter.updateJobScore(job.dbId, jobScore, matchReasons);
        } catch (e) {
          console.log(`   ⚠️  Score write failed: ${e.message.slice(0, 60)}`);
        }
      }
    }
    
    // Always sync score and evaluation match reason to dashboard DB inbox
    if (dbWriter) {
      try {
        await dbWriter.syncToInbox(targetUserId, job, scoreResult || { score: jobScore, dimensionScores: {}, matchReasons }, {});
      } catch (e) {
        console.log(`   ⚠️  Sync to dashboard inbox failed: ${e.message}`);
      }
    }

    // Check if we should generate documents (score >= 4.0)
    const shouldGenerateDocs = jobScore >= minScoreForAutoApply;
    
    if (!shouldGenerateDocs) {
      if (dbWriter) {
        try {
          await dbWriter.syncToInbox(targetUserId, job, scoreResult || { score: jobScore, dimensionScores: {}, matchReasons }, {});
          console.log(`   ✅ Synced to dashboard inbox (No documents generated)`);
        } catch (e) {
          console.log(`   ⚠️  Sync to dashboard inbox failed: ${e.message}`);
        }
      }
      await syncToLocalFiles(job, scoreResult || { score: jobScore, dimensionScores: {}, matchReasons }, null, null, null, null);
      console.log(`   ⏭️  Score ${jobScore} < ${minScoreForAutoApply} threshold — skipping document generation`);
      stats.skipped++;
      stats.skippedJobs.push({ company: job.company, role: job.role || job.title, reason: `Score ${jobScore} < ${minScoreForAutoApply} threshold` });
      continue;
    }

    // Generate tailored CV
    console.log(`   📄 Generating tailored CV...`);
    let cv;
    try {
      cv = await generateTailoredCV(job.company, job.role || job.title, job.description || job.raw || '');
    } catch (e) {
      console.log(`   ⚠️  CV generation failed: ${e.message.slice(0, 80)}`);
      cv = { pdfPath: null, htmlPath: null, success: false };
    }
    
    // --- Document Generation Matrix ---
    const activeProfile = dbProfile || profile;
    // Layer the sources least-authoritative first. The YAML is the local
    // baseline; profile_config from the database is what the dashboard writes,
    // so her saved checkboxes win. Previously only `activeProfile.profile_config`
    // was consulted, which is undefined in local mode, so the hardcoded default
    // below silently disabled the cover letter she had explicitly turned on.
    const dashCfg = await loadDashboardConfig(targetUserId);
    const pConfig = {
      ...(activeProfile || {}),
      ...(activeProfile?.profile_config || {}),
      ...(dashCfg || {}),
    };
    const useLlm = pConfig.llm_enabled !== false; // Default true
    const llmDocs = pConfig.llm_docs || { cv: true, cover_letter: true, reference_letter: true };
    const jdText = job.description || job.raw || '';

    const profileForDoc = userId ? dbProfile : {
      fullName: profile?.candidate?.full_name || 'Ilse Placencia',
      phone: profile?.candidate?.phone || '+61498570497',
      email: emailConfig?.gmail?.user || 'placenciailse@gmail.com',
      location: profile?.candidate?.location || 'Gold Coast, QLD, Australia',
      portfolioUrl: profile?.candidate?.portfolio_url || 'https://www.ilseplacencia.shop',
      llm_providers: profile?.llm_providers || []
    };

    let enhancedCv = null;
    let finalCvPath = cv?.pdfPath || null;
    let cvHtmlPath = cv?.htmlPath || null;

    // Which path actually produced each document, for the generation_method
    // column and for the log. "keyword" until something better succeeds.
    const docMethods = { cv: 'keyword', cl: 'keyword', rl: 'keyword' };

    // 1. CV Generation — model-written summary, deterministic history.
    let cvOverrides = null;
    if (useLlm && llmDocs.cv !== false) {
      try {
        const r = await llmDocsMod().then((m) => m.llmCvSummary(profileForDoc, job, jdText));
        cvOverrides = { summary: r.summary };
        docMethods.cv = r.method;
        console.log(`   🧠 CV summary written by ${r.method}`);
      } catch (e) {
        console.log(`   ⚠️  LLM CV summary failed (${e.message.slice(0, 60)}) — using template`);
      }
    }

    if (cvGeneratorFn) {
      console.log(`   📄 Generating CV via ${docMethods.cv === 'keyword' ? 'Native Keywords' : docMethods.cv}...`);
      try {
        // jobSlug gives the file a per-company name instead of "cv-candidate".
        enhancedCv = await cvGeneratorFn(profileForDoc, jdText, join(__dirname, 'output'), slug, cvOverrides);
        if (enhancedCv.success) {
          finalCvPath = enhancedCv.pdfPath;
          cvHtmlPath = enhancedCv.htmlPath;
          console.log(`   ✅ CV generated (${docMethods.cv}): ${finalCvPath}`);
        }
      } catch (e) {
        console.log(`   ⚠️  Native CV failed: ${e.message.slice(0, 80)}`);
      }
    }

    // 2. Cover Letter Generation
    let enhancedCl = null;
    let finalClPath = null;
    let coverLetterText = '';

    // The cover letter is pure prose, so this is where a model earns the most.
    let clOverrides = null;
    if (useLlm && llmDocs.cover_letter !== false) {
      try {
        const r = await llmDocsMod().then((m) =>
          m.llmCoverLetterCopy(profileForDoc, job, jdText, matchReasons));
        clOverrides = { opening: r.opening, profile_intro: r.profile_intro, closing: r.closing };
        docMethods.cl = r.method;
        console.log(`   🧠 Cover letter written by ${r.method}`);
      } catch (e) {
        console.log(`   ⚠️  LLM cover letter failed (${e.message.slice(0, 60)}) — using template`);
      }
    }

    if (clGeneratorFn) {
        console.log(`   📄 Generating Cover Letter via ${docMethods.cl === 'keyword' ? 'Native Keywords' : docMethods.cl}...`);
        try {
          enhancedCl = await clGeneratorFn(profileForDoc, { company: job.company, title: job.role || job.title }, jdText, join(__dirname, 'output'), clOverrides);
          if (enhancedCl.success) {
            finalClPath = enhancedCl.pdfPath;
            coverLetterText = readFileSync(enhancedCl.textPath, 'utf8');
            console.log(`   ✅ Cover Letter generated (${docMethods.cl}): ${finalClPath}`);
          }
        } catch (e) {
          console.log(`   ⚠️  Native Cover Letter failed: ${e.message.slice(0, 80)}`);
        }
      }

    // 3. Reference Letter Generation
    let generatedRefLetterHtml = null;

    if (rlGeneratorFn) {
        console.log(`   📄 Generating Reference Letter via Native Keywords...`);
        try {
          generatedRefLetterHtml = rlGeneratorFn(profileForDoc, job, jdText);
          console.log(`   ✅ Native Reference Letter generated.`);
        } catch (e) {
          console.log(`   ⚠️  Native Reference Letter failed: ${e.message.slice(0, 80)}`);
        }
      }
    
    // Generate PDF for Reference Letter
    let finalRlPath = null;
    if (generatedRefLetterHtml) {
      const rlHtmlPath = join(__dirname, `output/ref-letter-${slug}-${TODAY}.html`);
      finalRlPath = join(__dirname, `output/ref-letter-${slug}-${TODAY}.pdf`);
      writeFileSync(rlHtmlPath, generatedRefLetterHtml, 'utf8');
      try {
        execSync(`node generate-pdf.mjs "${rlHtmlPath}" "${finalRlPath}" --format=letter --report=000`, { encoding: 'utf8', cwd: __dirname, timeout: 30000 });
        console.log(`   ✅ Reference Letter PDF generated: ${finalRlPath}`);
      } catch (e) {
        console.log(`   ⚠️  Failed to generate Reference Letter PDF: ${e.message.slice(0, 80)}`);
        finalRlPath = null;
      }
    }
    
    // Scrape JD and generate personalized email
    console.log(`   📧 Scraping job description for personalization...`);
    const scrapedJd = await scrapeJobDescription(job.url);
    const emailSubject = `Application: ${job.role || job.title} at ${job.company} — ${userCreds.fullName}`;
    const emailBody = generatePersonalizedEmail(job.company, job.role || job.title, scrapedJd || jdText, dbProfile || profile, job.url);
    
    // Send email to company — VIP only (non-VIP gets file drafts)
    let companyEmail = await findCompanyEmail(job);
    let gmailDraftId = null;

    // Reference letter text/HTML for attachments and DB sync
    const activeRefLetter = generatedRefLetterHtml || `Taylor Chorley
Digital Marketing Supervisor, Evolve Marketing
taylorchorley@gmail.com | +1 (604) 551-8229

To Whom It May Concern,

I've worked with Ilse Placencia since January 2024, when she joined Evolve Marketing as a Digital Marketing Assistant, and I'm genuinely glad to write this on her behalf.

What stands out most, honestly, isn't just her skill set, it's how she works. Ilse brings this steady, positive energy to everything, even on the weeks that get hectic. She's the kind of person who checks in on how you're doing before diving into the task list, and that made a real difference on a fully remote team where it's easy to feel disconnected.

That said, she's also just really good at the job, and not just in one thing either. She's sharp across marketing and AI alike, and she's always finding new tools to make the work faster or better. If a tool she needs doesn't exist yet, she'll just build her own. That kind of resourcefulness isn't something you can teach. She has a genuine feel for what makes people click, and her social content consistently landed on brand, well timed, and built for whatever platform it was going on.

She's also reliable, something really hard to find nowadays. She meets deadlines, communicates clearly, and shows up prepared to strategy conversations with actual value, not just notes. Her analytics work and customer research made our campaigns improve across the board.

I'd hire Ilse again without hesitation. She's hardworking, kind, easy to work with, and any team would be lucky to have her.

Happy to talk more if it's helpful.

Warmest regards,
Taylor Chorley`;

    if (isVip && !DRY_RUN) {
      // Check if draft already exists in DB to prevent duplicates
      let existingDraftId = null;
      if (dbWriter) {
        try {
          const pool = dbWriter.getPool ? dbWriter.getPool() : null;
          if (pool) {
            const res = await pool.query('SELECT gmail_draft_id FROM job_inbox WHERE user_id = $1 AND url = $2 AND gmail_draft_id IS NOT NULL', [targetUserId, job.url]);
            if (res.rows.length > 0 && res.rows[0].gmail_draft_id) {
              existingDraftId = res.rows[0].gmail_draft_id;
            }
          }
        } catch (e) {}
      }

      if (existingDraftId) {
        console.log(`   ⏭️  Gmail draft already exists (ID: ${existingDraftId}) — skipping duplicate creation`);
        gmailDraftId = existingDraftId;
      } else {
        try {
          const { createGmailDraft, hasGmailCredentials } = await import('./lib/gmail-draft.mjs');

          if (hasGmailCredentials()) {
            const emailConfig = jsyaml.load(readFileSync(join(__dirname, 'config/email.yml'), 'utf-8'));
            const fromEmail = emailConfig?.gmail?.user || 'placenciailse@gmail.com';

            let fullEmailBody = emailBody || "";
            if (!fullEmailBody.includes(job.url)) {
              fullEmailBody = `${job.url}\n\n` + fullEmailBody;
            }
            fullEmailBody = fullEmailBody
              .replace(/ — /g, ", ")
              .replace(/ —/g, ", ")
              .replace(/—/g, ", ")
              .replace(/ – /g, ", ")
              .replace(/ –/g, ", ")
              .replace(/–/g, ", ")
              .replace(/ - /g, ", ");


            const draftResult = await createGmailDraft({
              from: fromEmail,
              to: companyEmail || "",
              subject: emailSubject,
              body: fullEmailBody,
              attachments: [
                finalCvPath && { path: finalCvPath },
                finalClPath && { path: finalClPath },
                finalRlPath && { path: finalRlPath },
              ].filter(Boolean),
            });
            
            if (draftResult.success) {
              gmailDraftId = draftResult.uid || 'created';
              console.log(`   ✅ Gmail draft created! (ID: ${gmailDraftId})`);
            } else {
              console.log(`   ⚠️  Gmail draft creation failed: ${draftResult.error}`);
            }
          }
        } catch (err) {
          console.log(`   ⚠️  Gmail draft creation error: ${err.message}`);
        }
      }
    }

    // Sync to dashboard inbox if database mode is enabled
    if (dbWriter) {
      try {
        console.log(`   🔄 Syncing job documents to dashboard inbox...`);
        // Use the cvHtmlPath and coverLetterText generated earlier in the matrix
        let cvHtml = null;
        if (cvHtmlPath && existsSync(cvHtmlPath)) {
          cvHtml = readFileSync(cvHtmlPath, 'utf8');
        }
        await dbWriter.syncToInbox(targetUserId, job, scoreResult || { score: jobScore, dimensionScores: {}, matchReasons }, {
          cvHtml,
          coverLetter: coverLetterText,
          referenceLetter: activeRefLetter,
          emailDraft: emailBody,
          gmailDraftId,
          // Report what actually produced the documents. This column previously
          // always said 'keyword', which was true only by accident.
          generationMethod: [docMethods.cv, docMethods.cl].some((m) => m.startsWith('llm'))
            ? `${docMethods.cv}/${docMethods.cl}`
            : 'keyword'
        });
        console.log(`   ✅ Synced to dashboard inbox`);
      } catch (e) {
        console.log(`   ⚠️  Sync to dashboard inbox failed: ${e.message}`);
      }
    }

    // Sync to local files (data/applications.md, reports/) for the local pipeline page
    await syncToLocalFiles(job, scoreResult || { score: jobScore, dimensionScores: {}, matchReasons }, finalCvPath, finalClPath, emailSubject, emailBody);

    // Apply via ATS form
    let atsApplied = false;
    let atsUrl = job.url;
    let method = 'ATS';

    // Auto-apply execution disabled per user request: jobs must remain in "Evaluated" (Ready to Submit)
    // so the user can manually review the drafted email, CV, and CL before submission.


    // Save backup file draft if Gmail draft was not created successfully
    if (!gmailDraftId && !DRY_RUN) {
      const draftPath = join(__dirname, `output/draft-${slug}-${TODAY}.md`);
      const draftContent = `# Draft Email — ${job.company} — ${job.role || job.title}

**To:** ${companyEmail || '(no email found — find recruiter email manually)'}
**Subject:** ${emailSubject}
**Score:** ${jobScore}/5
**URL:** ${job.url || 'N/A'}

---

${emailBody}

---

**Attachments:**
- ${finalCvPath || cv?.pdfPath || 'CV not generated'}
- ${finalClPath || 'Cover letter not generated'}
- ${finalRlPath || 'Reference letter not generated'}
`;
      try {
        writeFileSync(draftPath, draftContent);
        console.log(`   💾 Backup file draft saved: ${draftPath}`);
      } catch (e) {
        console.log(`   ⚠️  Failed to save backup file draft: ${e.message}`);
      }
    }
    
    // Track - Only set Submitted if atsApplied is strictly true with verified confirmation
    const finalStatus = atsApplied ? 'Applied (Confirmed)' : 'Evaluated';
    stats.sent++;
    applications.push({
      num: applications.length + 1,
      company: job.company,
      role: job.role,
      method,
      status: finalStatus,
      atsUrl,
    });
    
    // DB mode: persist application record and update job status
    if (userId && dbWriter && job.dbId && !DRY_RUN) {
      try {
        // Read enhanced CV HTML for caching in DB
        let resumeHtml = null;
        if (cvHtmlPath && existsSync(cvHtmlPath)) {
          resumeHtml = readFileSync(cvHtmlPath, 'utf8');
        }
        
        const isSupportEvaluated = atsApplied;
        const appStatus = atsApplied ? 'applied' : 'draft';
        const jobStatusStr = atsApplied ? 'applied' : 'evaluated';


        await dbWriter.writeApplication(userId, job.dbId, {
          resumeUrl: userCreds.resumeUrl || finalCvPath || cv?.pdfPath,
          coverLetter: coverLetterText || null,
          emailBody,
          emailSubject,
          status: appStatus,
          resumeHtml,
          gmailDraftId: gmailDraftId || null,
        });
        await dbWriter.updateJobStatus(job.dbId, jobStatusStr);
        // Update score with enhanced scoring
        if (jobScore > 0) {
          await dbWriter.updateJobScore(job.dbId, jobScore, matchReasons);
        }
        console.log(`   💾 Application saved to database (Status: ${jobStatusStr})`);
      } catch (e) {
        console.log(`   ⚠️  DB write failed: ${e.message.slice(0, 80)}`);
      }
    }
    markJobCompletedInPipeline(job.url);
  }
  
  // Step 4: Generate report
  const report = generateReport(applications, stats);
  const reportPath = join(__dirname, `output/daily-report-${TODAY}.md`);
  
  if (!DRY_RUN) {
    writeFileSync(reportPath, report);
    
    // Send report email — VIP only
    if (isVip && emailConfig?.report?.to) {
      await sendEmail({
        to: emailConfig.report.to,
        subject: `${emailConfig.report.subject_prefix || 'Daily Report'} ${TODAY} — ${stats.sent} applications submitted`,
        body: report,
      });
    } else if (isVip) {
      console.log(`   📧 VIP but no report email configured — report saved to ${reportPath}`);
    } else {
      console.log(`   📧 Non-VIP — report saved to ${reportPath} (no email sent)`);
    }
  }
  
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 Daily Report`);
  console.log(`   Scanned: ${stats.scanned}`);
  console.log(`   Screened: ${stats.screened}`);
  console.log(`   Applied: ${stats.sent}`);
  console.log(`   Skipped: ${stats.skipped}`);
  console.log(`   Report: ${reportPath}`);
  console.log(`${'─'.repeat(60)}\n`);
  
  // Cleanup DB connections
  if (dbReader) {
    try { await dbReader.closePool(); } catch {}
  }
  if (dbWriter) {
    try { await dbWriter.closePool(); } catch {}
  }
}

main().catch(async e => {
  console.error('Pipeline failed:', e);
  if (dbReader) { try { await dbReader.closePool(); } catch {} }
  process.exit(1);
});
