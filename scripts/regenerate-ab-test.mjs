import 'dotenv/config';
import pg from 'pg';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateLLMTailoredCV, generateLLMCoverLetter, generateLLMReferenceLetter } from '../lib/llm-cv-builder.mjs';
import * as cvGen from '../lib/cv-generator.mjs';
import { generateCoverLetter } from '../lib/cover-letter-generator.mjs';
import { generateReferenceLetter } from '../lib/reference-letter-generator.mjs';
import * as dbWriter from '../lib/db-writer.mjs';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log("Fetching jobs from job_inbox where job_status = 'evaluated' AND score >= 4...");
  const res = await pool.query("SELECT * FROM job_inbox WHERE job_status = 'evaluated' AND CAST(SPLIT_PART(score::text, '/', 1) AS NUMERIC) >= 4.0 ORDER BY created_at DESC");
  const jobs = res.rows;
  console.log(`Found ${jobs.length} jobs to regenerate.`);

  // Load profile
  const pConfigStr = readFileSync(join(process.cwd(), 'config', 'profile.yml'), 'utf8');
  const pConfig = yaml.load(pConfigStr);
  const profileForDoc = {
    contact: {
      name: pConfig.candidate.full_name,
      title: "Candidate",
      email: pConfig.candidate.email,
      phone: pConfig.candidate.phone,
      location: pConfig.candidate.location,
      linkedin: pConfig.candidate.linkedin,
      github: pConfig.candidate.github,
      portfolio: pConfig.candidate.portfolio_url,
    },
    ...pConfig
  };

  const cvMdText = readFileSync(join(process.cwd(), 'cv.md'), 'utf-8');

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const jdText = job.jd_text || `${job.role} at ${job.company}`;
    const scoreResult = { score: job.score, matchReasons: job.why_match };
    
    // Strict 50/50 split
    const useLlm = i % 2 === 0;
    let generationMethod = useLlm ? 'llm' : 'keyword';
    
    console.log(`[${i+1}/${jobs.length}] Generating docs for ${job.company} (${generationMethod})...`);
    
    let cvHtml = null;
    let coverLetterText = null;
    let activeRefLetter = null;
    let emailBody = null;

    try {
      let llmFailed = false;
      if (useLlm) {
        try {
          // LLM generation
          cvHtml = await generateLLMTailoredCV(profileForDoc, cvMdText, jdText);
          coverLetterText = await generateLLMCoverLetter(profileForDoc, cvMdText, jdText, job.company);
          activeRefLetter = await generateLLMReferenceLetter(profileForDoc, cvMdText, jdText);
        } catch (e) {
          console.log(`   ⚠️ LLM failed for ${job.company}, falling back to keywords: ${e.message}`);
          llmFailed = true;
          generationMethod = 'keyword';
        }
      }
      
      if (!useLlm || llmFailed) {
        // Keyword generation
        cvHtml = await cvGen.generateCVHtmlAsync(profileForDoc, jdText, join(process.cwd(), 'cv.md'));
        const enhancedCl = await generateCoverLetter(profileForDoc, { company: job.company, title: job.role || job.title }, jdText, join(process.cwd(), 'output'));
        if (enhancedCl.success) {
          coverLetterText = readFileSync(enhancedCl.textPath, 'utf8');
        }
        try {
          activeRefLetter = generateReferenceLetter(profileForDoc, job, jdText);
        } catch (e) {
          activeRefLetter = job.reference_letter; // Fallback to DB reference letter if keyword generator fails
        }
      }

      emailBody = `Dear ${job.company} Hiring Team,\n\nI believe I'm the perfect candidate for the ${job.role || 'position'}.\n\nA little about me...`;
      
      const fullEmailBody = (
        `🔗 APPLY HERE: ${job.url}\n\n` +
        `${emailBody || ""}\n`
      )

      await dbWriter.syncToInbox(job.user_id, job, scoreResult, {
        cvHtml,
        coverLetter: coverLetterText,
        referenceLetter: activeRefLetter || job.reference_letter,
        emailDraft: fullEmailBody,
        gmailDraftId: job.gmail_draft_id, // Keep existing draft
        generationMethod: generationMethod
      });
      
      console.log(`   ✅ Synced ${job.company} (${generationMethod})`);
    } catch (err) {
      console.error(`   ⚠️ Failed for ${job.company}:`, err.message);
    }
  }

  console.log("Done!");
  process.exit(0);
}

run();
