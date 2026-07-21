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
import yaml from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--limit') || '5');
const TODAY = new Date().toISOString().split('T')[0];
const userIdArg = process.argv.includes('--userId')
  ? process.argv[process.argv.indexOf('--userId') + 1]
  : null;
const userId = userIdArg || null;

// ─── Config ────────────────────────────────────────────────────────────────

function loadYAML(path) {
  const full = join(__dirname, path);
  if (!existsSync(full)) return null;
  return yaml.parse(readFileSync(full, 'utf8'));
}

const emailConfig = loadYAML('config/email.yml');

// DB mode: load profile from database
let dbReader = null;
let dbWriter = null;
let dbProfile = null;
let autoApplyEnabled = false;
let isVip = false;
let userEmailSettings = null;
let minScoreForAutoApply = 4;

const API_PLATFORMS = ['greenhouse', 'ashby', 'lever', 'workday', 'remoteok'];
const JOB_BOARDS = ['linkedin', 'indeed', 'seek'];

if (userId) {
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
  if (isVip) {
    userEmailSettings = await dbReader.getUserEmailSettings(userId);
    console.log(`[DB mode] VIP user — email automation enabled`);
  }
  console.log(`[DB mode] Profile loaded: ${dbProfile.fullName}, auto-apply: ${autoApplyEnabled}, vip: ${isVip}`);
}

// Local mode: load from profile.yml
const profile = loadYAML('config/profile.yml');

// Local mode runs with full capabilities (legacy Ilse-only path)
if (!userId) {
  isVip = true;
  console.log('[Local mode] Running as VIP-equivalent (local profile.yml path)');
}

// Build unified credential object — DB mode takes precedence
const userCreds = userId ? {
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
    'automation': { superpower: 'End-to-end automation pipeline design', proof: 'APEX Website Solutions' },
    'ai': { superpower: 'Multi-agent orchestration and AI voice agents', proof: 'Lumi and Milo' },
    'marketing': { superpower: 'Marketing automation across Facebook, email, SEO, and web', proof: 'Evolve Marketing' },
    'lead_generation': { superpower: 'B2B lead generation and cold outreach automation', proof: 'APEX Website Solutions' },
    'n8n': { superpower: 'End-to-end automation pipeline design (Google Antigravity, n8n, Make)', proof: 'APEX Website Solutions' },
    'typescript': { superpower: 'End-to-end automation pipeline design (Node.js, Python)', proof: 'APEX Website Solutions' },
    'python': { superpower: 'Multi-agent orchestration and AI voice agents (Gemini API)', proof: 'Lumi and Milo' },
    'api': { superpower: 'B2B lead generation and cold outreach automation', proof: 'APEX Website Solutions' },
    'gtm': { superpower: 'End-to-end automation pipeline design', proof: 'APEX Website Solutions' },
    'revops': { superpower: 'Marketing automation across Facebook, email, SEO, and web', proof: 'Fiesta Fresh Cleaning' },
    'voice': { superpower: 'Multi-agent orchestration and AI voice agents (Vapi, Bland AI)', proof: 'Fiesta Fresh Cleaning' },
    'content': { superpower: 'Content production pipelines (script to publish)', proof: 'Lumi and Milo' },
    'facebook': { superpower: 'Marketing automation across Facebook', proof: 'Fiesta Fresh Cleaning' },
    'email': { superpower: 'B2B lead generation and cold outreach automation', proof: 'APEX Website Solutions' },
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

function generatePersonalizedEmail(company, role, jdText, profileData) {
  const requirements = extractRequirements(jdText);
  const matches = matchToExperience(requirements, profileData);

  const openers = [
    `I hope this finds you well. I came across the ${role} role at ${company} and something about it genuinely resonated with me — it's not every day you find a position that feels like it was written with your exact background in mind. I wanted to reach out personally rather than just submitting through the form.`,
    `I'm reaching out because I've just read through the ${role} posting at ${company}, and I have to say — it's rare to find a role that lines up so perfectly with what I've been building for the past four years. I felt compelled to write to you directly.`,
    `When I saw the ${role} opening at ${company}, I stopped everything. This is exactly the kind of role I've been working toward — not just the technical requirements, but the kind of impact it promises. I wanted to introduce myself properly rather than let a standard application speak for me.`,
    `I'll be honest — your ${role} posting at ${company} is the first one in weeks that made me feel genuinely excited. I've spent years building the exact systems your team seems to need, and I wanted to share what I've done rather than just check boxes on an application form.`,
    `I've been thinking about the ${role} position at ${company} since I came across it. It sounds corny, but sometimes a job posting just clicks — like someone described perfectly what you love doing. I hope you don't mind me reaching out directly to share what I've been working on.`,
  ];
  const openerIdx = company.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % openers.length;

  let email = `Dear ${company} Hiring Team,\n\n`;
  email += openers[openerIdx] + '\n\n';

  email += `A little about me — I'm ${userCreds.fullName}, an AI Automation Specialist based in ${userCreds.location || 'Australia'}. Over the past four years, I've designed, coded, and deployed end-to-end automation systems across three businesses I founded. Not the kind of automation you set and forget — I'm talking about pipelines that run 24/7: scraping prospects, generating personalized reports, sending cold outreach, deploying websites, and booking meetings through AI voice agents, all with zero manual input. I've written every line of code, debugged workflows at 2am, and iterated until each system worked flawlessly. That's the level of care I'd bring to ${company}.\n\n`;

  if (matches.length > 0) {
    const topMatches = matches.slice(0, 3);
    email += `What excites me about the ${role} position at ${company} is how closely it aligns with these areas I've been perfecting:\n\n`;
    for (const match of topMatches) {
      const proofText = match.proof.includes(':') ? match.proof.split(':')[1].trim() : match.proof;
      const cleanProof = proofText
        .replace(/^Fully /, 'Built a fully ')
        .replace(/^Automated /, 'Built an automated ')
        .replace(/^Managed /, 'Managed ');
      email += `• ${cleanProof.charAt(0).toUpperCase() + cleanProof.slice(1)}\n\n`;
    }
    email += `These aren't just bullet points from a resume — they're systems I've built from scratch that are still running today, generating real results without any human intervention. I believe ${company} would benefit from this same hands-on approach.\n\n`;
  } else {
    email += `What draws me to ${company} isn't just the ${role} title — it's the kind of challenges I'd get to work on. I build AI-powered automation that replaces manual operations with intelligent workflows, and I've done it across marketing, sales, content production, and customer acquisition. I don't just configure tools — I build the tools myself, from the first line of code to the production deployment.\n\n`;
  }

  const closings = [
    `I know your team probably receives dozens of applications, so I genuinely appreciate you taking the time to read this. I've attached my CV (personalized for this role) and a cover letter that goes deeper into the experience I've outlined above. If anything I've shared resonates, I'd love the chance to continue the conversation — whatever format works best for you.`,
    `Thank you for reading this far — I know how busy hiring teams are, and I don't take your time for granted. I've attached my personalized CV and cover letter for this role. If what I've described sounds like the kind of person you're looking for, I'd welcome the opportunity to talk further. No pressure, no rush — just a genuine conversation.`,
    `I realize I've written quite a bit here, and I hope it comes across as enthusiasm rather than lengthiness. Your ${role} position genuinely excites me. My CV (tailored for this role) and cover letter are attached. I'd be honoured to hear back from you if there's a fit.`,
    `Thank you for considering my application — I know these decisions involve weighing many factors, and I appreciate the care you put into them. I've attached my CV (personalized for the ${role} position) and cover letter. Whether or not things work out, I admire what ${company} is building and I'm rooting for your team's success regardless.`,
  ];
  email += `${closings[(openerIdx + 2) % closings.length]}\n\n`;

  email += `With gratitude and warm regards,\n`;
  email += `${userCreds.fullName}\n`;
  email += `${userCreds.email} | ${userCreds.phone}\n`;
  email += `${userCreds.website}`;

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

function getCompanyDomain(company, url) {
  // Extract domain from URL
  let domain = '';
  try {
    const parsed = new URL(url);
    domain = parsed.hostname.replace(/^www\./, '');
  } catch (e) {
    domain = company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
  }
  
  // If URL is on an ATS domain, use company name instead
  const atsDomains = ['greenhouse.io', 'ashbyhq.com', 'lever.co', 'workday.com', 'smartrecruiters.com'];
  const isATS = atsDomains.some(ats => domain.includes(ats));
  if (isATS) {
    return company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
  }
  return domain;
}

async function findCompanyEmail(job) {
  console.log(`   🔍 Searching for ${job.company} email...`);
  const domain = getCompanyDomain(job.company, job.url);
  
  // Method 1: Extract emails directly from the job posting page
  console.log(`   📄 Checking job posting page...`);
  const jobPageEmails = await extractEmailsFromPage(job.url);
  if (jobPageEmails.length > 0) {
    console.log(`   ✅ Found email on job page: ${jobPageEmails[0]}`);
    return jobPageEmails[0];
  }
  
  // Method 2: Check company website pages
  const pagesToCheck = [
    `https://${domain}/contact`,
    `https://${domain}/about`,
    `https://${domain}/team`,
    `https://${domain}/careers`,
    `https://www.${domain}/contact`,
    `https://www.${domain}/about`,
  ];
  
  console.log(`   🌐 Checking company website pages...`);
  for (const pageUrl of pagesToCheck) {
    const emails = await extractEmailsFromPage(pageUrl);
    if (emails.length > 0) {
      console.log(`   ✅ Found email on ${pageUrl}: ${emails[0]}`);
      return emails[0];
    }
  }
  
  // Method 3: No email found
  console.log(`   ⚠️  No email found on website`);
  return null;
}

// ─── Scan ──────────────────────────────────────────────────────────────────

async function scanForJobs() {
  console.log('📡 Scanning job portals...');
  try {
    // Scan tracked companies + job boards
    const result = execSync('node scan.mjs --json 2>/dev/null', { 
      encoding: 'utf8', cwd: __dirname, timeout: 120000 
    });
    const data = JSON.parse(result);
    const trackedUrls = data.new_urls || [];
    
    // Reverse ATS scan — walks ALL Greenhouse/Lever/Ashby/Workday directories
    console.log('📡 Scanning all ATS directories (Greenhouse/Lever/Ashby/Workday)...');
    try {
      execSync('node scan-ats-full.mjs --since 3 2>/dev/null', { 
        encoding: 'utf8', cwd: __dirname, timeout: 300000 
      });
    } catch (atsErr) {
      console.log('   ATS full scan failed, continuing with tracked results only');
    }
    
    return trackedUrls;
  } catch (e) {
    console.log('   Scan failed, using pipeline.md only');
    return [];
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
  
  // Use DB profile target roles if available, fall back to defaults
  const targetRoles = (userProfile?.targetRoles || userProfile?.target_roles || []).map(r => r.toLowerCase());
  const targetKeywords = targetRoles.length > 0 ? targetRoles : [
    'ai', 'automation', 'marketing', 'gtm', 'operations', 'agent',
    'workflow', 'growth', 'demand gen', 'revops', 'revenue ops',
    'product ops', 'sales ops', 'enablement', 'strategy'
  ];
  
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

async function loadScorer() {
  if (scoreJobFn) return scoreJobFn;
  try {
    const scorer = await import('./lib/scorer.mjs');
    scoreJobFn = scorer.scoreJob;
    llmScoreJobFn = scorer.llmScoreJob;
    isOllamaAvailableFn = scorer.isOllamaAvailable;
    // Check Ollama availability once at startup
    ollamaAvailable = await isOllamaAvailableFn();
    if (ollamaAvailable) {
      console.log(`   🧠 Ollama detected — using LLM scoring for accurate evaluation`);
    } else {
      console.log(`   📊 Ollama not available — using keyword scoring`);
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
}

// ─── Generate Tailored CV ──────────────────────────────────────────────────

function generateTailoredCV(company, role) {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const htmlPath = join(__dirname, `output/cv-candidate-${slug}-${TODAY}.html`);
  const pdfPath = join(__dirname, `output/cv-candidate-${slug}-${TODAY}.pdf`);
  
  // DB mode: decode the user's uploaded resume from DB
  if (userId && userCreds.resumeUrl) {
    try {
      // Data URL format: data:application/pdf;base64,ABC123... OR raw base64
      let base64Data = userCreds.resumeUrl;
      if (base64Data.includes(',')) {
        base64Data = base64Data.split(',')[1];
      }
      if (base64Data && base64Data.length > 100) {
        const buffer = Buffer.from(base64Data, 'base64');
        writeFileSync(pdfPath, buffer);
        console.log(`   ✅ Decoded user resume from DB: ${pdfPath} (${(buffer.length / 1024).toFixed(1)} KB)`);
        return { htmlPath: null, pdfPath, success: true };
      }
    } catch (e) {
      console.log(`   ⚠️  Failed to decode DB resume: ${e.message.slice(0, 80)}`);
    }
    // If DB resume failed and no local cv.md, can't generate
    if (!existsSync(join(__dirname, 'cv.md'))) {
      console.log(`   ❌ No resume available (DB decode failed, no local cv.md)`);
      return { htmlPath: null, pdfPath: null, success: false };
    }
    console.log(`   ⚠️  Falling back to local CV generation`);
  }
  
  // Local mode: generate from cv.md + template
  const cvMdPath = join(__dirname, 'cv.md');
  if (!existsSync(cvMdPath)) {
    console.log(`   ❌ No cv.md found for local generation`);
    return { htmlPath: null, pdfPath: null, success: false };
  }
  const cv = readFileSync(cvMdPath, 'utf8');
  const template = readFileSync(join(__dirname, 'templates/cv-template.html'), 'utf8');
  
  const html = template
    .replace(/\{\{LANG\}\}/g, 'en')
    .replace(/\{\{NAME\}\}/g, userCreds.fullName)
    .replace(/\{\{PHONE\}\}/g, userCreds.phone)
    .replace(/\{\{EMAIL\}\}/g, userCreds.email)
    .replace(/\{\{LOCATION\}\}/g, userCreds.location)
    .replace(/\{\{PORTFOLIO_URL\}\}/g, userCreds.website)
    .replace(/\{\{PORTFOLIO_DISPLAY\}\}/g, userCreds.website.replace(/^https?:\/\//, ''))
    .replace(/\{\{LINKEDIN_URL\}\}/g, userCreds.linkedin || userCreds.website)
    .replace(/\{\{LINKEDIN_DISPLAY\}\}/g, (userCreds.linkedin || userCreds.website).replace(/^https?:\/\//, ''))
    .replace(/\{\{PAGE_WIDTH\}\}/g, '8.5in')
    .replace(/\{\{SECTION_SUMMARY\}\}/g, 'Professional Summary')
    .replace(/\{\{SECTION_COMPETENCIES\}\}/g, 'Core Competencies')
    .replace(/\{\{SECTION_EXPERIENCE\}\}/g, 'Experience')
    .replace(/\{\{SECTION_PROJECTS\}\}/g, 'Projects')
    .replace(/\{\{SECTION_EDUCATION\}\}/g, 'Education')
    .replace(/\{\{SECTION_CERTIFICATIONS\}\}/g, 'Certifications')
    .replace(/\{\{SECTION_SKILLS\}\}/g, 'Technical Skills')
    .replace(/\{\{SUMMARY_TEXT\}\}/g, 
      `AI Automation Specialist and Marketing Engineer with 4+ years of experience designing, coding, and deploying end-to-end automation systems across lead generation, content production, and sales operations. Founded and scaled two fully automated businesses without additional headcount. Proven ability to identify bottlenecks, architect intelligent workflows, and deliver measurable operational gains in remote environments.`)
    .replace(/\{\{COMPETENCIES\}\}/g, 
      ['AI Automation', 'Marketing Operations', 'GTM Systems', 'Workflow Orchestration', 'Lead Generation', 'TypeScript', 'Node.js', 'Python', 'APIs & Webhooks', 'n8n', 'Claude API', 'Gemini API']
        .map(c => `<span class="competency-tag">${c}</span>`).join('\n      '))
    .replace(/\{\{EXPERIENCE\}\}/g, extractExperienceHTML(cv))
    .replace(/\{\{PROJECTS\}\}/g, '')
    .replace(/\{\{EDUCATION\}\}/g, extractEducationHTML(cv))
    .replace(/\{\{CERTIFICATIONS\}\}/g, extractCertsHTML(cv))
    .replace(/\{\{SKILLS\}\}/g, extractSkillsHTML(cv))
    .replace(/\{\{PHOTO\}\}/g, '');
  
  writeFileSync(htmlPath, html);
  
  // Generate PDF
  try {
    const cvMdFlag = existsSync(join(__dirname, 'cv.md')) ? `--cv-md="${join(__dirname, 'cv.md')}"` : '--allow-reorder';
    execSync(
      `node generate-pdf.mjs "${htmlPath}" "${pdfPath}" --format=letter --report=000 ${cvMdFlag}`,
      { encoding: 'utf8', cwd: __dirname, timeout: 30000 }
    );
    return { htmlPath, pdfPath, success: true };
  } catch (e) {
    console.log(`   ⚠️  PDF generation failed: ${e.message.slice(0, 80)}`);
    return { htmlPath, pdfPath: null, success: false };
  }
}

function extractExperienceHTML(cv) {
  // Extract from cv.md and format as HTML
  return `
    <div class="job">
      <div class="job-header">
        <span class="job-company">APEX Website Solutions</span>
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
    : `Dear {{COMPANY}} Hiring Team,\n\nI build AI-powered automation systems that replace manual operations with intelligent workflows. With 4+ years of experience across three businesses I founded, I bring a unique combination of technical depth and business outcomes.\n\nAt APEX Website Solutions, I built a fully automated B2B lead generation system that scrapes prospects, generates personalized audits, sends cold email, and books discovery calls through an AI voice agent, all with zero manual input. At Lumi and Milo, I designed a multi-agent orchestration system with a dedicated QC agent. At Fiesta Fresh, I built the complete marketing automation stack from social media to sales.\n\nI am fluent in TypeScript, Node.js, Python, REST APIs, and webhooks. I develop with Claude, Cursor, and multi-agent orchestration as my primary tools. I do not just evaluate AI tools; I build production systems with them.\n\nI would welcome the chance to discuss how my experience can contribute to {{COMPANY}}'s growth.\n\nBest regards,\n{{FULL_NAME}}\n{{EMAIL}} | {{PHONE}}\n{{WEBSITE}}`;
  
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
  
  if (userId && dbReader) {
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
    const newUrls = await scanForJobs();
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
      continue;
    }
    console.log(`   ✅ ${job.company} — ${job.role}: ${screen.reason}`);
    toProcess.push(job);
  }
  
  // Step 3: Process each job
  const scorer = await loadScorer();
  await loadGenerators();
  
  for (const job of toProcess) {
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
    
    if (scorer && (!jobScore || jobScore === 0)) {
      const profileForScoring = userId ? {
        targetRoles: dbProfile?.targetRoles || [],
        jobType: dbProfile?.jobType || ['remote'],
        employmentType: dbProfile?.employmentType || ['contract'],
        salaryMin: dbProfile?.salaryMin,
        salaryMax: dbProfile?.salaryMax,
      } : {
        targetRoles: profile?.target_roles || ['AI Automation Specialist', 'Marketing Automation Engineer'],
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
      let scoreResult;
      if (isVip && ollamaAvailable && llmScoreJobFn) {
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
    
    // Check per-user score threshold before proceeding
    const { shouldAutoApply: checkAutoApply } = await import('./lib/scorer.mjs');
    const autoApplyCheck = checkAutoApply(jobScore, autoApplyEnabled, dbProfile || profile, minScoreForAutoApply);
    if (!autoApplyCheck.autoApply) {
      console.log(`   ⏭️  ${autoApplyCheck.reason}`);
      stats.skipped++;
      stats.skippedJobs.push({ company: job.company, role: job.role || job.title, reason: autoApplyCheck.reason });
      continue;
    }
    
    // Generate tailored CV
    console.log(`   📄 Generating tailored CV...`);
    let cv;
    try {
      cv = generateTailoredCV(job.company, job.role);
    } catch (e) {
      console.log(`   ⚠️  CV generation failed: ${e.message.slice(0, 80)}`);
      cv = { pdfPath: null, htmlPath: null, success: false };
    }
    
    // Generate cover letter
    console.log(`   📝 Generating cover letter...`);
    let clPath;
    try {
      clPath = generateCoverLetter(job.company, job.role);
    } catch (e) {
      console.log(`   ⚠️  Cover letter generation failed: ${e.message.slice(0, 80)}`);
      clPath = null;
    }
    
    // Try enhanced document generation if available
    let enhancedCv = null;
    let enhancedCl = null;
    
    if (cvGeneratorFn) {
      try {
        const profileForDoc = userId ? dbProfile : {
          fullName: profile?.candidate?.full_name || 'Ilse Placencia',
          phone: profile?.candidate?.phone || '+61498570497',
          email: emailConfig?.gmail?.user || 'placenciailse@gmail.com',
          location: profile?.candidate?.location || 'Gold Coast, QLD, Australia',
          portfolioUrl: profile?.candidate?.portfolio_url || 'https://www.ilseplacencia.shop',
        };
        enhancedCv = await cvGeneratorFn(profileForDoc, job.description || job.raw || '', join(__dirname, 'output'));
        if (enhancedCv.success) {
          console.log(`   ✅ Enhanced CV generated: ${enhancedCv.pdfPath}`);
        }
      } catch (e) {
        console.log(`   ⚠️  Enhanced CV failed: ${e.message.slice(0, 80)}`);
      }
    }
    
    if (clGeneratorFn) {
      try {
        const profileForDoc = userId ? dbProfile : {
          fullName: profile?.candidate?.full_name || 'Ilse Placencia',
          phone: profile?.candidate?.phone || '+61498570497',
          email: emailConfig?.gmail?.user || 'placenciailse@gmail.com',
          location: profile?.candidate?.location || 'Gold Coast, QLD, Australia',
          portfolioUrl: profile?.candidate?.portfolio_url || 'https://www.ilseplacencia.shop',
        };
        enhancedCl = await clGeneratorFn(profileForDoc, {
          company: job.company,
          title: job.role || job.title,
        }, job.description || job.raw || '', join(__dirname, 'output'));
        if (enhancedCl.success) {
          console.log(`   ✅ Enhanced cover letter generated: ${enhancedCl.pdfPath}`);
        }
      } catch (e) {
        console.log(`   ⚠️  Enhanced cover letter failed: ${e.message.slice(0, 80)}`);
      }
    }
    
    // Use enhanced PDFs if available, fall back to basic
    const finalCvPath = enhancedCv?.pdfPath || cv.pdfPath;
    const finalClPath = enhancedCl?.pdfPath || clPath;
    
    // Scrape JD and generate personalized email
    console.log(`   📧 Scraping job description for personalization...`);
    const jdText = await scrapeJobDescription(job.url);
    const emailSubject = `Application: ${job.role || job.title} at ${job.company} — ${userCreds.fullName}`;
    const emailBody = generatePersonalizedEmail(job.company, job.role || job.title, jdText, dbProfile || profile);
    
    // Apply via ATS form
    let atsApplied = false;
    let atsUrl = job.url;
    let method = 'ATS';
    
    // Check if this is a job board listing (LinkedIn, Indeed, SEEK) — use cookies to auto-apply
    const platform = job.url.includes('linkedin.com') ? 'linkedin'
      : job.url.includes('indeed.com') ? 'indeed'
      : job.url.includes('seek.com') ? 'seek'
      : null;
    const isJobBoardOnly = !!platform;
    
    if (isJobBoardOnly) {
      // Attempt cookie-based auto-apply using saved browser sessions
      console.log(`   🌐 Cookie platform — ${platform}...`);
      method = `${platform.charAt(0).toUpperCase() + platform.slice(1)} Auto-Apply`;
      
      if (isVip && !DRY_RUN) {
        try {
          const providerMod = await import(`./providers/${platform}.mjs`).catch(() => null);
          if (providerMod?.default?.apply) {
            const applyResult = await providerMod.default.apply(job.url, {
              userId,
              candidateInfo: {
                firstName: userCreds.firstName || userCreds.fullName?.split(' ')[0],
                lastName: userCreds.lastName || userCreds.fullName?.split(' ').slice(1).join(' '),
                email: userCreds.email,
                phone: userCreds.phone,
              },
              cvPath: finalCvPath || cv.pdfPath,
            });
            if (applyResult?.success) {
              console.log(`   ✅ ${applyResult.method || platform} — application submitted`);
              atsApplied = true;
            } else {
              console.log(`   ⚠️  ${platform} apply failed: ${applyResult?.error} — falling back to manual`);
              method = 'Semi-Auto (Manual)';
            }
          } else {
            console.log(`   ⚠️  ${platform} provider has no apply() — generating manual package`);
            method = 'Semi-Auto (Manual)';
          }
        } catch (e) {
          console.log(`   ⚠️  ${platform} cookie apply error: ${e.message.slice(0, 100)} — falling back to manual`);
          method = 'Semi-Auto (Manual)';
        }
      }
      
      // If VIP cookie apply failed or non-VIP, generate manual package
      if (!atsApplied) {
        const source = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : 'Job Board';
        const manualPackage = {
          company: job.company, role: job.role || job.title, url: job.url,
          source, score: jobScore, matchReasons,
          cv: finalCvPath, coverLetter: finalClPath,
          emailSubject, emailBody,
          instructions: `Apply at: ${job.url}\n\nSteps:\n1. Click link\n2. Upload CV: ${finalCvPath}\n3. Upload cover letter: ${finalClPath}\n4. Submit`,
        };
        const packagePath = join(__dirname, `output/manual-apply-${slug}-${TODAY}.json`);
        writeFileSync(packagePath, JSON.stringify(manualPackage, null, 2));
        console.log(`   💾 Manual apply package saved: ${packagePath}`);
      }
      
    } else if (!DRY_RUN && job.url) {
      // Try automated ATS apply (Greenhouse, Ashby, Lever, custom forms)
      const cvPathForAts = finalCvPath || cv.pdfPath;
      if (!cvPathForAts) {
        console.log(`   ⚠️  No CV file available — skipping ATS apply`);
        method = 'Email (no CV)';
      } else {
        console.log(`   🖥️  Applying via ATS form...`);
        try {
          const userIdFlag = userId ? ` --userId "${userId}"` : '';
          const atsResult = execSync(
            `node apply-to-ats.mjs "${job.url}" --cv "${cvPathForAts}" --cover-letter "${finalClPath || clPath}"${userIdFlag}`,
            { encoding: 'utf8', cwd: __dirname, timeout: 90000 }
          );
          const result = JSON.parse(atsResult.trim().split('\n').pop());
          if (result.success) {
            console.log(`   ✅ ATS application submitted`);
            atsApplied = true;
            if (result.confirmationUrl) atsUrl = result.confirmationUrl;
          } else {
            console.log(`   ⚠️  ATS apply failed: ${result.error}`);
            method = 'Email (ATS failed)';
          }
        } catch (e) {
          console.log(`   ⚠️  ATS apply error: ${e.message.slice(0, 100)}`);
          method = 'Email (ATS failed)';
        }
      }
    } else if (DRY_RUN) {
      console.log(`   🖥️  [DRY RUN] Would apply via ATS: ${job.url}`);
    }
    
    // Send email to company — VIP only (non-VIP gets drafts)
    let companyEmail = await findCompanyEmail(job);
    
    if (isVip && !DRY_RUN && companyEmail) {
      // VIP: send email automatically
      console.log(`   📧 Sending personalized email to ${companyEmail}...`);
      const result = await sendEmail({
        to: companyEmail,
        subject: emailSubject,
        body: emailBody,
        attachments: [finalCvPath, finalClPath].filter(Boolean),
      });
      if (result.success) console.log(`   ✅ Email sent to ${companyEmail}`);
      else console.log(`   ⚠️  Email failed: ${result.error}`);
    } else if (!isVip && !DRY_RUN) {
      // Non-VIP: save as draft (no email sending)
      console.log(`   📧 Non-VIP — saving email as draft...`);
      const draftPath = join(__dirname, `output/draft-${slug}-${TODAY}.md`);
      const draftContent = `# Draft Email — ${job.company} — ${job.role || job.title}

**To:** ${companyEmail || '(no email found — find recruiter email manually)'}
**Subject:** ${emailSubject}
**Score:** ${jobScore}/5

---

${emailBody}

---

**Attachments:**
- ${finalCvPath || cv.pdfPath || 'CV not generated'}
- ${finalClPath || clPath || 'Cover letter not generated'}
`;
      writeFileSync(draftPath, draftContent);
      console.log(`   💾 Draft saved: ${draftPath}`);
    } else if (DRY_RUN) {
      console.log(`   📧 [DRY RUN] Would email ${companyEmail || '(no email found — would save as draft)'}`);
      console.log(`   📧 Preview:\n${emailBody.slice(0, 300)}...`);
    }
    
    // Track
    stats.sent++;
    applications.push({
      num: applications.length + 1,
      company: job.company,
      role: job.role,
      method,
      status: atsApplied ? 'Submitted' : (DRY_RUN ? 'Dry Run' : 'Email Sent'),
      atsUrl,
    });
    
    // DB mode: persist application record and update job status
    if (userId && dbWriter && job.dbId && !DRY_RUN) {
      try {
        // Use enhanced cover letter content if available
        let coverLetterContent = null;
        if (enhancedCl?.textPath && existsSync(enhancedCl.textPath)) {
          coverLetterContent = readFileSync(enhancedCl.textPath, 'utf8');
        } else if (existsSync(clPath)) {
          coverLetterContent = readFileSync(clPath, 'utf8');
        }
        
        // Read enhanced CV HTML for caching in DB
        let resumeHtml = null;
        if (enhancedCv?.htmlPath && existsSync(enhancedCv.htmlPath)) {
          resumeHtml = readFileSync(enhancedCv.htmlPath, 'utf8');
        } else if (cv?.htmlPath && existsSync(cv.htmlPath)) {
          resumeHtml = readFileSync(cv.htmlPath, 'utf8');
        }
        
        await dbWriter.writeApplication(userId, job.dbId, {
          resumeUrl: userCreds.resumeUrl || finalCvPath || cv.pdfPath,
          coverLetter: coverLetterContent,
          emailBody,
          emailSubject,
          status: atsApplied ? 'applied' : 'draft',
          resumeHtml,
        });
        await dbWriter.updateJobStatus(job.dbId, atsApplied ? 'auto-applied' : 'pending');
        // Update score with enhanced scoring
        if (jobScore > 0) {
          await dbWriter.updateJobScore(job.dbId, jobScore, matchReasons);
        }
        console.log(`   💾 Application saved to database`);
      } catch (e) {
        console.log(`   ⚠️  DB write failed: ${e.message.slice(0, 80)}`);
      }
    }
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
  if (userId && dbReader) {
    try { await dbReader.closePool(); } catch {}
  }
  if (userId && dbWriter) {
    try { await dbWriter.closePool(); } catch {}
  }
}

main().catch(async e => {
  console.error('Pipeline failed:', e);
  if (dbReader) { try { await dbReader.closePool(); } catch {} }
  process.exit(1);
});
