import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import jsyaml from 'js-yaml';

// Load env before importing DB modules
const envFile = readFileSync('./web/.env.local', 'utf8');
const match = envFile.match(/DATABASE_URL=(.+)/);
if (match) {
  process.env.DATABASE_URL = match[1].trim().replace(/^["']/g, '');
}

import { generateCV } from '../lib/cv-generator.mjs';
import { generateCoverLetter } from '../lib/cover-letter-generator.mjs';
import { createGmailDraft, hasGmailCredentials } from '../lib/gmail-draft.mjs';
import { syncToInbox } from '../lib/db-writer.mjs';

function extractRequirements(jdText) {
  const text = jdText.toLowerCase();
  const requirements = [];
  const skillKeywords = {
    'automation': ['automation', 'automated', 'workflow', 'n8n', 'make', 'zapier'],
    'ai': ['ai', 'artificial intelligence', 'llm', 'gpt', 'gemini', 'claude', 'agent'],
    'marketing': ['marketing', 'digital marketing', 'campaign', 'growth', 'seo', 'sem'],
    'lead_generation': ['lead gen', 'lead generation', 'cold email', 'outreach', 'prospecting'],
    'n8n': ['n8n'],
    'typescript': ['typescript', 'ts'],
    'python': ['python'],
    'api': ['api', 'apis', 'rest', 'webhook'],
    'gtm': ['gtm', 'go-to-market', 'go to market'],
    'revops': ['revops', 'revenue ops', 'revenue operations'],
    'voice': ['voice', 'vapi', 'bland', 'caller'],
    'content': ['content', 'youtube', 'video'],
    'facebook': ['facebook', 'meta', 'social media'],
    'email': ['email', 'cold email', 'mail'],
    'remote': ['remote', 'async', 'distributed'],
  };
  for (const [skill, keywords] of Object.entries(skillKeywords)) {
    if (keywords.some(kw => text.includes(kw))) {
      requirements.push(skill);
    }
  }
  return requirements;
}

const PROOF_MAP = {
  automation: 'Built a fully automated B2B lead generation engine at APEX Website Solutions that scrapes prospects, generates audit reports, sends cold emails, and books calls 24/7 with zero manual input.',
  ai: 'Designed a multi-agent YouTube content pipeline at Lumi and Milo with a dedicated QC agent using Python, Gemini API, and Google Antigravity orchestration.',
  marketing: 'Planned and executed full-funnel digital campaigns at Evolve Marketing across multiple product launches in a fully remote, async-first team.',
  lead_generation: 'Built a complete lead generation system at APEX that scrapes qualified prospects, generates personalized audits, sends cold emails, and books discovery calls through an AI voice agent.',
  n8n: 'Architected automated workflows at APEX using n8n and Google Antigravity that handle prospect scraping, audit generation, email sequences, and call booking.',
  python: 'Built a Python and Gemini API YouTube content pipeline at Lumi and Milo that orchestrates script generation, visual creation, voiceover synthesis, and video assembly.',
  api: 'Integrated multiple APIs across businesses including Vapi, Bland AI, Facebook Graph API, and custom Node.js services for lead capture and outreach.',
  voice: 'Integrated AI voice agents (Vapi, Bland AI, Telnyx) that autonomously qualify leads and book appointments 24/7 across multiple businesses.',
  content: 'Built an autonomous YouTube video production pipeline at Lumi and Milo that generates scripts, visuals, voiceovers, and metadata with single-click publishing.',
  facebook: 'Coded a Node.js Facebook automation application at Fiesta Fresh that publishes daily organic posts and auto-responds to purchase-intent posts in real time.',
  email: 'Engineered a cold email system at Unimark with lead scraping, prospect qualification, and multi-touch sequence delivery through a self-hosted mail server.',
};

function generatePersonalizedEmail(company, role, jdText, profileData, jobUrl) {
  const requirements = extractRequirements(jdText);
  let email = "";
  if (jobUrl) {
    email += `🔗 APPLY HERE: ${jobUrl}\n\n`;
  }
  email += `Dear ${company} Hiring Team,\n\n`;
  email += `I believe I'm the perfect candidate for the ${role} position.\n\n`;
  email += `A little about me, I'm Ilse Placencia, an AI Automation Specialist based in Gold Coast, QLD, Australia. Over the past four years, I've designed, coded, and deployed end-to-end automation systems across three businesses I founded. Not the kind of automation you set and forget, I'm talking about pipelines that run 24/7: scraping prospects, generating personalized reports, sending cold outreach, deploying websites, and booking meetings through AI voice agents, all with zero manual input. I've written every line of code, debugged workflows at 2am, and iterated until each system worked flawlessly. That's the level of care I'd bring to ${company}.\n\n`;

  const matchedProofs = requirements.map(r => PROOF_MAP[r]).filter(Boolean);
  if (matchedProofs.length > 0) {
    email += `What excites me about the ${role} position at ${company} is how closely it aligns with these areas I've been perfecting:\n\n`;
    for (const proof of matchedProofs.slice(0, 3)) {
      email += `• ${proof}\n\n`;
    }
    email += `These aren't just bullet points from a resume, they're systems I've built from scratch that are still running today, generating real results without any human intervention. I believe ${company} would benefit from this same hands-on approach.\n\n`;
  } else {
    email += `What draws me to ${company} isn't just the ${role} title, it's the kind of challenges I'd get to work on. I build AI-powered automation that replaces manual operations with intelligent workflows, and I've done it across marketing, sales, content production, and customer acquisition. I don't just configure tools, I build the tools myself, from the first line of code to the production deployment.\n\n`;
  }

  email += `I understand finding a reliable worker is hard nowadays but I'm confident I'm the right fit for you so I offer you one day of my services for free so you can see what I have to offer.\n\n`;
  email += `My CV, cover letter, and reference letter are attached for your review.\n\n`;
  email += `With gratitude and warm regards,\n`;
  email += `Ilse Placencia\n`;
  email += `placenciailse@gmail.com | 0498570497\n`;
  email += `https://www.ilseplacencia.shop`;

  email = email
    .replace(/ — /g, ', ')
    .replace(/ – /g, ', ')
    .replace(/ - /g, ', ');

  return email;
}

const appPath = 'data/applications.md';
const content = readFileSync(appPath, 'utf8');
const lines = content.split('\n').filter(l => l.startsWith('|') && !l.includes('Company') && !l.includes('---'));

console.log(`🚀 Starting full batch regeneration (CVs + Cover Letters + DB Job Cards + Gmail Drafts) for ${lines.length} Primary applications...`);

const emailConfig = jsyaml.load(readFileSync('config/email.yml', 'utf8'));
const profileForDoc = {
  fullName: 'Ilse Placencia',
  phone: '+61498570497',
  email: emailConfig?.gmail?.user || 'placenciailse@gmail.com',
  location: 'Gold Coast, QLD, Australia',
  portfolioUrl: 'https://www.ilseplacencia.shop',
};

let count = 0;
for (const line of lines) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) continue;
  const company = parts[3];
  const role = parts[4];
  const reportMatch = parts[8].match(/\[(\d+)\]\(\.\.\/reports\/([^)]+)\)/);
  const reportFile = reportMatch ? reportMatch[2] : null;

  let jdText = '';
  if (reportFile && existsSync(join('reports', reportFile))) {
    const reportText = readFileSync(join('reports', reportFile), 'utf8');
    jdText = `${role} at ${company}. ${reportText.slice(0, 1500)}`;
  } else {
    jdText = `${role} at ${company}. AI automation, QA testing, digital marketing, website builder, video generation.`;
  }

  try {
    // 1. Generate tailored CV HTML & PDF with unique per-job filename
    const jobSlug = `${company}-${role}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const cvResult = await generateCV(profileForDoc, jdText, join(process.cwd(), 'output'), jobSlug);
    
    // 2. Generate tailored Cover Letter
    const clResult = await generateCoverLetter(profileForDoc, { company, title: role }, jdText, join(process.cwd(), 'output'));
    
    // Read generated contents
    let cvHtml = null;
    if (cvResult.htmlPath && existsSync(cvResult.htmlPath)) {
      cvHtml = readFileSync(cvResult.htmlPath, 'utf8');
    }
    let coverLetterText = null;
    if (clResult.textPath && existsSync(clResult.textPath)) {
      coverLetterText = readFileSync(clResult.textPath, 'utf8');
    }

    // 3. Create/update Gmail Draft with newest attachments using exact auto-apply email generator
    let gmailDraftId = null;
    if (hasGmailCredentials()) {
      const emailSubject = `Application: ${role} at ${company} — Ilse Placencia`;
      const emailBody = generatePersonalizedEmail(company, role, jdText, profileForDoc, '');
      
      const attachments = [
        cvResult.pdfPath && { path: cvResult.pdfPath },
        clResult.pdfPath && { path: clResult.pdfPath },
        existsSync(join(process.cwd(), 'output/Reference_Letter_Taylor_Chorley.pdf')) && {
          path: join(process.cwd(), 'output/Reference_Letter_Taylor_Chorley.pdf'),
          filename: 'Ilse_Placencia_Reference_Letter.pdf'
        }
      ].filter(Boolean);

      const draftRes = await createGmailDraft({
        from: emailConfig.defaults?.from_email || 'placenciailse@gmail.com',
        to: '',
        subject: emailSubject,
        body: emailBody,
        attachments,
      });

      if (draftRes.success) {
        gmailDraftId = draftRes.uid || 'created';
      }
    }

    // 4. Update Database Job Card & Pipeline Inbox
    const jobObj = {
      title: role,
      company,
      url: '',
      description: jdText,
    };
    
    await syncToInbox('default', jobObj, { score: 4.5, dimensionScores: {}, matchReasons: ['Tailored CV and Projects updated'] }, {
      cvHtml,
      coverLetter: coverLetterText,
      emailDraft: `Subject: Application: ${role} at ${company}\n\nDear ${company} Hiring Team...`,
      gmailDraftId,
      referenceLetter: 'Taylor_Chorley.pdf'
    });

    count++;
    if (count % 15 === 0 || count === lines.length) {
      console.log(`   ✅ Synced & Regenerated ${count}/${lines.length}: ${company} — ${role} (Gmail Draft: ${gmailDraftId ? 'Created' : 'Skipped'})`);
    }
  } catch (e) {
    console.error(`   ⚠️ Failed for ${company} — ${role}: ${e.message}`);
  }
}

console.log(`🎉 Complete batch update finished! All ${count} Primary job cards in DB and Gmail drafts updated with newest tailored CVs (Projects + eGlow).`);
