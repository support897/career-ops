import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: 'web/.env.local' });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function parsePipeline() {
  const content = fs.readFileSync('data/pipeline.md', 'utf8');
  const lines = content.split('\n');
  const pipelineJobs = {};
  for (const line of lines) {
    if (line.includes('|---|')) continue;
    if (!line.trim() || !line.includes('|')) continue;
    
    // - [x] https://... | Company | Role | Location
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (!m) continue;
    const parts = m[2].split('|').map(p => p.trim());
    if (parts.length >= 3) {
      const url = parts[0];
      const company = parts[1];
      const role = parts[2];
      pipelineJobs[`${company}---${role}`] = url;
    }
  }
  return pipelineJobs;
}

function parseApplications() {
  const content = fs.readFileSync('data/applications.md', 'utf8');
  const lines = content.split('\n');
  const apps = [];
  let pastHeader = false;
  for (const line of lines) {
    if (line.includes('|---|')) { pastHeader = true; continue; }
    if (!pastHeader || !line.trim() || !line.includes('|')) continue;
    
    const parts = line.split('|').map(p => p.trim());
    if (parts.length > 5) {
      apps.push({
        company: parts[3],
        role: parts[4],
        score: parts[5] ? parts[5].replace('/5', '') : null,
        status: parts[6]
      });
    }
  }
  return apps;
}

function slugify(text) {
  if (!text) return '';
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function run() {
  try {
    const pipelineJobs = parsePipeline();
    const apps = parseApplications();
    console.log(`Found ${apps.length} applications locally.`);
    
    let inserted = 0;
    const userId = process.env.VIP_USER_ID || 'user_3GfaXsz2WyxzFl0LcD4ktVnNsCS';
    
    for (const app of apps) {
      if (app.status !== 'Evaluated') continue;
      
      const slug = slugify(app.company);
      const cvHtmlPath = path.join('output', `cv-candidate-${slug}-2026-08-16.html`);
      const coverLetterPath = path.join('output', `cover-letter-${slug}-2026-08-16.txt`);
      
      let cvHtml = null;
      let coverLetter = null;
      
      if (fs.existsSync(cvHtmlPath)) cvHtml = fs.readFileSync(cvHtmlPath, 'utf8');
      if (fs.existsSync(coverLetterPath)) coverLetter = fs.readFileSync(coverLetterPath, 'utf8');
      
      const score = app.score ? parseFloat(app.score) : null;
      const url = pipelineJobs[`${app.company}---${app.role}`] || `https://example.com/job/${slug}`;
      
      const res = await pool.query(
        `INSERT INTO job_inbox (
           user_id, url, company, role, score, cv_html, cover_letter, doc_status, job_status, email_draft, gmail_draft_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready', 'new', 'Draft sent', 'created')
         ON CONFLICT (user_id, url) DO UPDATE SET
           score = EXCLUDED.score,
           cv_html = EXCLUDED.cv_html,
           cover_letter = EXCLUDED.cover_letter,
           doc_status = EXCLUDED.doc_status,
           job_status = EXCLUDED.job_status,
           email_draft = EXCLUDED.email_draft,
           gmail_draft_id = EXCLUDED.gmail_draft_id
         `,
        [userId, url, app.company, app.role, score, cvHtml, coverLetter]
      );
      
      console.log(`Synced ${app.company} to DB.`);
      inserted++;
    }
    console.log(`Finished. Synced ${inserted} rows in Vercel DB.`);
  } catch (e) {
    console.error(e);
  } finally {
    pool.end();
  }
}

run();
