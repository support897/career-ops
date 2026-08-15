import { Pool } from 'pg';
import { generateCVHtml } from '../lib/cv-generator.mjs';
import fs from 'fs';
import yaml from 'yaml';

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_oN60DfjuHaVl@ep-patient-sound-ausuu589.c-10.us-east-1.aws.neon.tech/neondb?sslmode=require',
});

async function run() {
  const { rows } = await pool.query(`SELECT id, jd_text FROM job_inbox WHERE cv_html IS NOT NULL`);
  console.log(`Found ${rows.length} records with cv_html`);
  
  const profileRaw = fs.readFileSync('config/profile.yml', 'utf-8');
  const profile = yaml.parse(profileRaw);
  
  let updated = 0;
  for (const app of rows) {
    if (!app.jd_text) continue;
    
    // Generate new HTML
    let html = generateCVHtml(profile, app.jd_text);
    
    // Ensure the accent color is injected
    if (profile.style && profile.style.accent_color) {
      if (!html.includes(profile.style.accent_color)) {
         html = html.replace('</head>', `<style>:root { --accent-color: ${profile.style.accent_color}; }</style></head>`);
      }
    }
    
    await pool.query(`UPDATE job_inbox SET cv_html = $1 WHERE id = $2`, [html, app.id]);
    updated++;
  }
  console.log(`Updated ${updated} records with brand new layout.`);
  process.exit(0);
}

run();
