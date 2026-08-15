import { generateLLMTailoredCV } from '../lib/llm-cv-builder.mjs';
import fs from 'fs';
import yaml from 'yaml';

async function run() {
  const profileRaw = fs.readFileSync('config/profile.yml', 'utf-8');
  const profile = yaml.parse(profileRaw);
  
  const jdText = `We are looking for a Senior Software Engineer with strong experience in Node.js, React, and building scalable SaaS applications. You should be comfortable with AWS and CI/CD pipelines.`;
  const cvText = fs.readFileSync('cv.md', 'utf-8');

  console.log('Testing LLM Waterfall generation...');
  try {
    const payload = await generateLLMTailoredCV(profile, cvText, jdText);
    console.log('Success! Payload:', JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error('Failed:', e);
  }
}

run();
