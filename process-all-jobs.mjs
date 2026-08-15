#!/usr/bin/env node
// process-all-jobs.mjs — Process ALL remaining jobs:
// 1. Fetch JD from URL if missing
// 2. Generate personalized email body
// 3. Generate CV PDF from existing resume HTML
// 4. Generate cover letter PDF
// 5. Create Gmail draft via IMAP
// NEVER sends emails — draft only

import { neon } from '@neondatabase/serverless';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { chromium } from 'playwright';
import { createGmailDraft } from './lib/gmail-draft.mjs';
import yaml from 'yaml';

const sql = neon(process.env.DATABASE_URL || readFileSync('.env', 'utf8').match(/DATABASE_URL=(.+)/)?.[1]);
const VIP_USER_ID = 'user_3GfaXsz2WyxzFl0LcD4ktVnNsCS';
const OUTPUT_DIR = join(import.meta.dirname, 'output', 'gmail-drafts');
const BATCH_SIZE = 10;

// Load profile for email generation
const profile = yaml.parse(readFileSync(join(import.meta.dirname, 'config/profile.yml'), 'utf-8'));
const emailConfig = yaml.parse(readFileSync(join(import.meta.dirname, 'config/email.yml'), 'utf-8'));

const EXPERIENCE_MAP = {
  'AI Automation Specialist': 'AI automation systems across lead generation, content production, and marketing operations',
  'Marketing Engineer': 'end-to-end marketing automation and digital campaign systems',
  'Founder': 'three fully automated businesses without additional headcount',
  'TypeScript': 'TypeScript, Node.js, Python, REST APIs, and webhooks',
  'n8n': 'n8n, Claude API, Gemini API, Vapi, Bland AI, Google Antigravity',
};

function generateEmailBody(company, role, url) {
  const firstName = profile?.name?.split(' ')[0] || 'Ilse';
  const matchingExperience = Object.entries(EXPERIENCE_MAP)
    .filter(([k]) => role?.toLowerCase().includes(k.toLowerCase()) || company?.toLowerCase().includes(k.toLowerCase()))
    .map(([, v]) => v)
    .slice(0, 2)
    .join(' and ') || 'AI-powered automation systems';

  return `Dear ${company} Hiring Team,

I'm writing to express my interest in the ${role} position at ${company}.

I build ${matchingExperience}. With over 6 years of experience across three businesses I founded, I bring a unique combination of technical depth and business outcomes.

I'd be thrilled to bring this experience to ${company}. Wishing you a great week regardless.

Best regards,
${firstName} Placencia
${emailConfig.defaults?.from_email || 'placenciailse@gmail.com'} | +61498570497
${emailConfig.defaults?.signature?.match(/https?:\/\/\S+/)?.[0] || 'https://www.ilseplacencia.shop'}`;
}

function generateCoverLetter(company, role) {
  const firstName = profile?.name?.split(' ')[0] || 'Ilse';
  return `Dear ${company} Hiring Team,

I am writing to express my strong interest in the ${role} position at ${company}.

With over 6 years of experience building AI-powered automation systems across lead generation, content production, and marketing operations, I bring a unique combination of technical depth and business outcomes. I have personally built, deployed, and run production AI agents across three businesses I founded, covering the full stack from prospecting to campaign management to sales operations.

At APEX Website Solutions, I built a fully automated B2B lead generation system that scrapes prospects, generates personalized audits, sends cold email, and books discovery calls through an AI voice agent, all with zero manual input. At Lumi and Milo, I designed a multi-agent orchestration system with a dedicated QC agent that reviews every piece of content before human approval. At Fiesta Fresh, I built the complete marketing automation stack from social media to sales.

I am fluent in TypeScript, Node.js, Python, REST APIs, and webhooks. I develop with Claude, Cursor, and multi-agent orchestration as my primary tools. I do not just evaluate AI tools; I build production systems with them.

What draws me to ${company} is your commitment to innovative technology. I want to build the systems that make your teams more effective, not just recommend tools. My experience with multi-agent orchestration, API integrations, and end-to-end automation maps directly to the systems you need.

I would welcome the chance to discuss how my experience building end-to-end automation systems can contribute to ${company}'s growth.

Best regards,
${firstName} Placencia
${emailConfig.defaults?.from_email || 'placenciailse@gmail.com'} | 04 98570497
ilseplacencia.shop`;
}

async function fetchJd(url) {
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
      const text = await page.evaluate(() => {
        const main = document.querySelector('main, [class*="job"], [class*="description"], article, .content');
        return (main || document.body).innerText.slice(0, 8000);
      });
      return text;
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}

async function htmlToPdf(html, outputPath) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      margin: { top: '0.4in', bottom: '0.4in', left: '0.5in', right: '0.5in' },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Get all jobs without applications
  const unprocessed = await sql`
    SELECT j.id, j.title, j.company, j.url, j.platform, j.description
    FROM jobs j
    LEFT JOIN applications a ON a.job_id = j.id
    WHERE j.user_id = ${VIP_USER_ID}
    AND a.id IS NULL
    ORDER BY j.created_at DESC
  `;

  console.log(`📧 Found ${unprocessed.length} jobs without applications\n`);

  // Get base CV HTML (use any existing application's resume_html)
  const [baseCv] = await sql`SELECT resume_html FROM applications WHERE user_id = ${VIP_USER_ID} AND resume_html IS NOT NULL LIMIT 1`;
  const cvHtml = baseCv?.resume_html;

  if (!cvHtml) {
    console.error('❌ No base CV HTML found in applications table');
    process.exit(1);
  }

  let created = 0;
  let failed = 0;
  let fetched = 0;

  for (let i = 0; i < unprocessed.length; i++) {
    const job = unprocessed[i];
    const slug = `${job.company}-${job.title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);

    process.stdout.write(`[${i + 1}/${unprocessed.length}] ${job.company} — ${job.title.slice(0, 50)}...`);

    // Fetch JD if missing
    let description = job.description;
    if (!description && job.url) {
      try {
        description = await fetchJd(job.url);
        if (description) {
          await sql`UPDATE jobs SET description = ${description} WHERE id = ${job.id}`;
          fetched++;
        }
      } catch {}
    }

    // Generate email body
    const emailBody = generateEmailBody(job.company, job.title, job.url);
    const emailSubject = `Application: ${job.title} at ${job.company} — ${profile?.name || 'Ilse Placencia'}`;
    const coverLetter = generateCoverLetter(job.company, job.title);

    // Generate CV PDF
    let cvPdfPath = null;
    try {
      cvPdfPath = join(OUTPUT_DIR, `cv-${slug}.pdf`);
      await htmlToPdf(cvHtml, cvPdfPath);
    } catch { cvPdfPath = null; }

    // Generate cover letter PDF
    let clPdfPath = null;
    try {
      const clHtml = `<!DOCTYPE html><html><head><style>
        body { font-family: Arial, sans-serif; font-size: 12px; line-height: 1.7; color: #1a1a2e; max-width: 650px; margin: 40px auto; padding: 0 20px; }
      </style></head><body>${coverLetter.replace(/\n/g, '<br>')}</body></html>`;
      clPdfPath = join(OUTPUT_DIR, `cl-${slug}.pdf`);
      await htmlToPdf(clHtml, clPdfPath);
    } catch { clPdfPath = null; }

    // Create application in DB
    try {
      await sql`
        INSERT INTO applications (id, user_id, job_id, email_body, email_subject, cover_letter, resume_html, status, created_at)
        VALUES (${crypto.randomUUID()}, ${VIP_USER_ID}, ${job.id}, ${emailBody}, ${emailSubject}, ${coverLetter}, ${cvHtml}, 'draft', NOW())
        ON CONFLICT (user_id, job_id) DO UPDATE SET
          email_body = EXCLUDED.email_body,
          email_subject = EXCLUDED.email_subject,
          cover_letter = EXCLUDED.cover_letter,
          resume_html = EXCLUDED.resume_html,
          status = 'draft'
      `;
    } catch (e) {
      console.log(` DB fail: ${e.message?.slice(0, 50)}`);
      failed++;
      continue;
    }

    // Create Gmail draft
    try {
      const emailBodyWithLink = `${emailBody}\n\nApply here: ${job.url || 'N/A'}`;
      const result = await createGmailDraft({
        from: emailConfig.defaults?.from_email || 'placenciailse@gmail.com',
        to: '',
        subject: emailSubject,
        body: emailBodyWithLink,
        attachments: [
          cvPdfPath && { path: cvPdfPath },
          clPdfPath && { path: clPdfPath },
        ].filter(Boolean),
      });

      if (result.success) {
        await sql`UPDATE applications SET gmail_draft_id = ${result.uid} WHERE user_id = ${VIP_USER_ID} AND job_id = ${job.id}`;
        console.log(` ✅ draft #${result.uid}`);
        created++;
      } else {
        console.log(` ⚠️ ${result.error?.slice(0, 40)}`);
        failed++;
      }
    } catch (e) {
      console.log(` ❌ ${e.message?.slice(0, 40)}`);
      failed++;
    }

    // Small delay to avoid Gmail rate limiting
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`📊 Summary`);
  console.log(`   Total jobs: ${unprocessed.length}`);
  console.log(`   Gmail drafts created: ${created}`);
  console.log(`   JDs fetched: ${fetched}`);
  console.log(`   Failed: ${failed}`);
  console.log(`${'━'.repeat(50)}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
