import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: 'web/.env.local' });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

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
        status: parts[5],
        score: parts[6] ? parts[6].replace('/5', '') : null
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
    const apps = parseApplications();
    console.log(`Found ${apps.length} applications locally.`);
    
    let updated = 0;
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
      
      const res = await pool.query(
        `UPDATE job_inbox 
         SET score = $1, cv_html = $2, cover_letter = $3, doc_status = 'ready', job_status = 'Evaluated', email_draft = 'Draft sent'
         WHERE company = $4 AND role = $5`,
        [score, cvHtml, coverLetter, app.company, app.role]
      );
      
      if (res.rowCount > 0) {
        console.log(`Synced ${app.company} to DB.`);
        updated += res.rowCount;
      } else {
        console.log(`Could not find ${app.company} - ${app.role} in job_inbox.`);
      }
    }
    console.log(`Finished. Updated ${updated} rows in Vercel DB.`);
  } catch (e) {
    console.error(e);
  } finally {
    pool.end();
  }
}

run();
