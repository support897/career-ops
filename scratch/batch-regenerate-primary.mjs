import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import jsyaml from 'js-yaml';
import { generateCV } from '../lib/cv-generator.mjs';
import { generateCoverLetter } from '../lib/cover-letter-generator.mjs';

const appPath = 'data/applications.md';
const content = readFileSync(appPath, 'utf8');
const lines = content.split('\n').filter(l => l.startsWith('|') && !l.includes('Company') && !l.includes('---'));

console.log(`🚀 Starting batch regeneration for ${lines.length} Primary applications...`);

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
    const urlMatch = reportText.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s\n]+)/);
    const url = urlMatch ? urlMatch[1] : '';
    jdText = `${role} at ${company}. ${reportText.slice(0, 1500)}`;
  } else {
    jdText = `${role} at ${company}. AI automation, QA testing, digital marketing, website builder, video generation.`;
  }

  try {
    // Generate tailored CV with newest cv.md rules (Projects + eGlow)
    const emailConfig = jsyaml.load(readFileSync('config/email.yml', 'utf8'));
    const profileForDoc = {
      fullName: 'Ilse Placencia',
      phone: '+61498570497',
      email: emailConfig?.gmail?.user || 'placenciailse@gmail.com',
      location: 'Gold Coast, QLD, Australia',
      portfolioUrl: 'https://www.ilseplacencia.shop',
    };
    
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
    const cvResult = await generateCV(profileForDoc, jdText, join(process.cwd(), 'output'));
    
    // Generate tailored Cover Letter
    const clResult = await generateCoverLetter(profileForDoc, { company, title: role }, jdText, join(process.cwd(), 'output'));
    
    count++;
    if (count % 20 === 0 || count === lines.length) {
      console.log(`   ✅ Regenerated ${count}/${lines.length}: ${company} — ${role}`);
    }
  } catch (e) {
    console.error(`   ⚠️ Failed for ${company} — ${role}: ${e.message}`);
  }
}

console.log(`🎉 Batch regeneration complete! Successfully regenerated ${count} tailored CVs & cover letters with the latest Projects + eGlow profile rules.`);
