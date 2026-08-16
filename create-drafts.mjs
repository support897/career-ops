#!/usr/bin/env node
// create-drafts.mjs — Create Gmail drafts for all existing draft applications
// NEVER sends emails — only creates drafts in Gmail Drafts folder

import pg from 'pg';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { chromium } from 'playwright';
import { createGmailDraft } from './lib/gmail-draft.mjs';

const { Pool } = pg;
const dbUrl = process.env.DATABASE_URL || readFileSync('.env', 'utf8').match(/DATABASE_URL=(.+)/)?.[1];
const pool = new Pool({ connectionString: dbUrl });
const sql = async (strings, ...values) => {
  const query = strings.reduce((prev, curr, i) => prev + '$' + i + curr);
  const res = await pool.query(query, values);
  return res.rows;
};
const OUTPUT_DIR = join(import.meta.dirname, 'output', 'gmail-drafts');
const VIP_USER_ID = 'user_3GfaXsz2WyxzFl0LcD4ktVnNsCS';

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

  // Get all draft applications with job data
  const drafts = await sql`
    SELECT 
      a.id as app_id, a.email_subject, a.email_body, a.cover_letter, a.resume_html,
      a.status, a.gmail_draft_id,
      j.id as job_id, j.title, j.company, j.url, j.platform
    FROM applications a
    JOIN jobs j ON a.job_id = j.id
    WHERE a.status = 'draft' AND a.gmail_draft_id IS NULL
    ORDER BY a.created_at DESC
  `;

  console.log(`📧 Found ${drafts.length} draft applications to create Gmail drafts for\n`);

  let created = 0;
  let failed = 0;
  let skipped = 0;

  for (const draft of drafts) {
    const slug = `${draft.company}-${draft.title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    console.log(`\n── ${draft.company} — ${draft.title} ──`);

    if (!draft.email_body) {
      console.log('   ⏭️  No email body — skipping');
      skipped++;
      continue;
    }

    // Build email body with apply link
    const emailBodyWithLink = `${draft.email_body}

Apply here: ${draft.url || 'N/A'}`;

    // Generate CV PDF from resume_html
    let cvPdfPath = null;
    if (draft.resume_html) {
      try {
        cvPdfPath = join(OUTPUT_DIR, `cv-${slug}.pdf`);
        await htmlToPdf(draft.resume_html, cvPdfPath);
        console.log(`   📄 CV PDF generated`);
      } catch (err) {
        console.log(`   ⚠️  CV PDF failed: ${err.message}`);
        cvPdfPath = null;
      }
    }

    // Generate cover letter PDF if available
    let clPdfPath = null;
    if (draft.cover_letter) {
      try {
        const clHtml = `<!DOCTYPE html><html><head><style>
          body { font-family: Arial, sans-serif; font-size: 12px; line-height: 1.7; color: #1a1a2e; max-width: 650px; margin: 40px auto; padding: 0 20px; }
          h2 { color: hsl(187, 74%, 32%); font-size: 14px; margin-bottom: 20px; }
        </style></head><body><h2>Cover Letter</h2>${draft.cover_letter.replace(/\n/g, '<br>')}</body></html>`;
        clPdfPath = join(OUTPUT_DIR, `cl-${slug}.pdf`);
        await htmlToPdf(clHtml, clPdfPath);
        console.log(`   📝 Cover letter PDF generated`);
      } catch (err) {
        console.log(`   ⚠️  Cover letter PDF failed: ${err.message}`);
        clPdfPath = null;
      }
    }

    // Create Gmail draft
    try {
      const result = await createGmailDraft({
        from: 'placenciailse@gmail.com',
        to: '',
        subject: draft.email_subject || `Application: ${draft.title} at ${draft.company}`,
        body: emailBodyWithLink,
        attachments: [
          cvPdfPath && { path: cvPdfPath },
          clPdfPath && { path: clPdfPath },
        ].filter(Boolean),
      });

      if (result.success) {
        console.log(`   ✅ Gmail draft created (UID: ${result.uid})`);
        // Update DB with Gmail draft UID
        await sql`UPDATE applications SET gmail_draft_id = ${result.uid} WHERE id = ${draft.app_id}`;
        created++;
      } else {
        console.log(`   ❌ Gmail draft failed: ${result.error}`);
        failed++;
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`📊 Summary`);
  console.log(`   Created: ${created}`);
  console.log(`   Failed:  ${failed}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`${'━'.repeat(50)}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
