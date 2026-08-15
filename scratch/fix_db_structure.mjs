import { Pool } from 'pg';
import fs from 'fs';

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_oN60DfjuHaVl@ep-patient-sound-ausuu589.c-10.us-east-1.aws.neon.tech/neondb?sslmode=require',
});

async function run() {
  const { rows } = await pool.query(`SELECT id, cv_html FROM job_inbox WHERE cv_html IS NOT NULL`);
  
  let updated = 0;
  for (const app of rows) {
    let html = app.cv_html;
    if (!html) continue;

    // 1. Fix CSS styles
    // Swap header h1 color to accent, center, uppercase
    html = html.replace(/(\.header h1 \{[^}]*?color:\s*)#[0-9a-fA-F]+([^}]*\})/i, '$1var(--accent-color)$2');
    if (!html.includes('text-align: center') && html.includes('.header h1 {')) {
        html = html.replace('.header h1 {', '.header h1 { text-align: center; text-transform: uppercase;');
    }
    
    // Fix header gradient
    html = html.replace(/(\.header-gradient \{[^}]*?height:\s*)[^;]+;[^}]*?background:\s*[^;]+;/i, '$11.5px;\n    background: #000;');
    
    // Fix contact row
    if (!html.includes('justify-content: center') && html.includes('.contact-row {')) {
        html = html.replace('.contact-row {', '.contact-row { justify-content: center;');
    }
    html = html.replace(/(\.contact-row \{[^}]*?color:\s*)#[0-9a-fA-F]+/i, '$1#111');
    html = html.replace(/(\.contact-row a \{[^}]*?color:\s*)#[0-9a-fA-F]+/i, '$1#111');
    
    // Fix section titles
    html = html.replace(/border-bottom:\s*[^;]+;/gi, ''); // remove bottom borders on sections
    
    // Fix Job role & company colors
    html = html.replace(/(\.job-company \{[^}]*?color:\s*)var\(--accent-color\)/gi, '$1#333');
    html = html.replace(/(\.job-company \{[^}]*?font-weight:\s*)600/gi, '$1400');
    html = html.replace(/(\.job-role \{[^}]*?color:\s*)#[0-9a-fA-F]+/gi, '$1var(--accent-color)');
    html = html.replace(/(\.job-role \{[^}]*?font-weight:\s*)[0-9]+/gi, '$1600');

    // 2. Fix HTML Structure
    // Move header gradient after contact row
    html = html.replace(/<div class="header-gradient"><\/div>\s*<div class="contact-row">([\s\S]*?)<\/div>/, '<div class="contact-row">$1</div>\n    <div class="header-gradient"></div>');

    // Swap job role and company
    // Currently: <div class="job-header">\s*<span class="job-company">...</span>\s*<span class="job-period">...</span>\s*</div>\s*<div class="job-role">...</div>
    html = html.replace(/<div class="job-header">\s*<span class="job-company">(.*?)<\/span>\s*<span class="job-period">(.*?)<\/span>\s*<\/div>\s*<div class="job-role">(.*?)<\/div>/g, 
      '<div class="job-header">\n      <span class="job-role">$3</span>\n      <span class="job-period">$2</span>\n    </div>\n    <div class="job-company"><em>$1</em></div>');

    await pool.query(`UPDATE job_inbox SET cv_html = $1 WHERE id = $2`, [html, app.id]);
    updated++;
  }
  console.log(`Updated ${updated} records with brand new layout via Regex patching.`);
  process.exit(0);
}

run();
