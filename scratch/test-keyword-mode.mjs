import { generateCVHtmlAsync } from '../lib/cv-generator.mjs';
import fs from 'fs';
import yaml from 'yaml';

async function run() {
  const profileRaw = fs.readFileSync('config/profile.yml', 'utf-8');
  const profile = yaml.parse(profileRaw);
  
  // Force keyword mode
  profile.cv_generation_mode = 'keyword';
  
  const jdText = `We are looking for a Senior Software Engineer with strong experience in Node.js, React, and building scalable SaaS applications.`;

  console.log('Testing Keyword generation...');
  try {
    const html = await generateCVHtmlAsync(profile, jdText);
    if (html.includes('Senior Software Engineer') || html.includes('Node.js') || html.length > 1000) {
      console.log('Success! Keyword mode generated HTML.');
    }
  } catch (e) {
    console.error('Failed:', e);
  }
}

run();
