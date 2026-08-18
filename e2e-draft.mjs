/**
 * End-to-end proof of the "qualified job -> documents -> Gmail draft -> dashboard"
 * chain, using the same modules auto-apply.mjs calls.
 *
 * Target is chosen by URL from job_inbox. Creates ONE real Gmail draft.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import pg from 'pg';

const TARGET = process.argv[2];
if (!TARGET) { console.error('usage: node e2e-draft.mjs <job url>'); process.exit(1); }

const url = process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1|107\.175\.88\.18/.test(url) ? false : { rejectUnauthorized: false } });
const uid = process.env.VIP_USER_ID;

const { rows } = await pool.query(
  'SELECT company, role, url, score, jd_text, why_match FROM job_inbox WHERE user_id=$1 AND url=$2',
  [uid, TARGET]
);
if (!rows.length) { console.error('job not found for this user'); process.exit(1); }
const job = { ...rows[0], title: rows[0].role, description: rows[0].jd_text || '' };
console.log(`target: ${job.company} — ${job.role} (score ${job.score})`);

const profileYml = load(readFileSync('./config/profile.yml', 'utf8'));
const emailCfg = load(readFileSync('./config/email.yml', 'utf8'));
const profileForDoc = {
  fullName: profileYml?.candidate?.full_name,
  phone: profileYml?.candidate?.phone,
  email: emailCfg?.gmail?.user,
  location: profileYml?.candidate?.location,
  portfolioUrl: profileYml?.candidate?.portfolio_url,
  style: profileYml?.style,
};

// 1 & 2 — LLM prose, exactly as auto-apply does it
const { llmCoverLetterCopy, llmCvSummary } = await import('./lib/llm-docs.mjs');
const reasons = (job.why_match || '').split(/[.;]\s*/).filter(Boolean).slice(0, 5);

let clOverrides = null, cvOverrides = null, cvMethod = 'keyword', clMethod = 'keyword';
try { const r = await llmCvSummary(profileForDoc, job, job.description); cvOverrides = { summary: r.summary }; cvMethod = r.method; }
catch (e) { console.log('cv summary fell back:', e.message.slice(0, 70)); }
try {
  const r = await llmCoverLetterCopy(profileForDoc, job, job.description, reasons);
  clOverrides = { opening: r.opening, profile_intro: r.profile_intro, closing: r.closing };
  clMethod = r.method;
} catch (e) { console.log('cover letter fell back:', e.message.slice(0, 70)); }
console.log('cv via:', cvMethod);
console.log('cl via:', clMethod);

// 3 — render the real documents
const slug = job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
const { generateCV } = await import('./lib/cv-generator.mjs');
const { generateCoverLetter } = await import('./lib/cover-letter-generator.mjs');
const { generateReferenceLetter } = await import('./lib/reference-letter-generator.mjs');

const out = './output';
const cv = await generateCV(profileForDoc, job.description, out, slug, cvOverrides);
const cl = await generateCoverLetter(profileForDoc, { company: job.company, title: job.role }, job.description, out, clOverrides);
console.log('cv pdf:', cv.pdfPath, cv.success);
console.log('cl pdf:', cl.pdfPath, cl.success);

let rlHtml = null, rlPdf = null;
try {
  rlHtml = generateReferenceLetter(profileForDoc, job, job.description);
  const { writeFileSync } = await import('fs');
  const { execSync } = await import('child_process');
  const p = `${out}/ref-letter-${slug}-e2e.html`;
  rlPdf = `${out}/ref-letter-${slug}-e2e.pdf`;
  writeFileSync(p, rlHtml, 'utf8');
  execSync(`node generate-pdf.mjs "${p}" "${rlPdf}" --format=letter --report=000`, { timeout: 40000 });
  console.log('rl pdf:', rlPdf);
} catch (e) { console.log('reference letter failed:', e.message.slice(0, 80)); rlPdf = null; }

const clHtml = cl.htmlPath ? readFileSync(cl.htmlPath, 'utf8') : null;
const clText = cl.textPath ? readFileSync(cl.textPath, 'utf8') : '';
const cvHtml = cv.htmlPath ? readFileSync(cv.htmlPath, 'utf8') : null;
console.log('cl html pink:', !!clHtml && clHtml.includes('#ff8bb1'));
console.log('cv html pink:', !!cvHtml && cvHtml.includes('#ff8bb1'));

// 4 — the Gmail draft, with all three attachments
const { createGmailDraft, hasGmailCredentials } = await import('./lib/gmail-draft.mjs');
console.log('gmail creds present:', hasGmailCredentials());

let body = `${job.url}\n\n${clText}`;
body = `[ACTION NEEDED] No recruiter address could be found for ${job.company}. Add a recipient before sending, or apply directly at the link below.\n\n${body}`;

const draft = await createGmailDraft({
  from: emailCfg?.gmail?.user,
  to: '',
  subject: `Application: ${job.role} — ${job.company}`,
  body,
  attachments: [cv.pdfPath && { path: cv.pdfPath }, cl.pdfPath && { path: cl.pdfPath }, rlPdf && { path: rlPdf }].filter(Boolean),
});
console.log('draft:', JSON.stringify(draft).slice(0, 200));

// 5 — sync to the dashboard, including the styled HTML
const { syncToInbox } = await import('./lib/db-writer.mjs');
await syncToInbox(uid, job, { score: Number(job.score), dimensionScores: {}, matchReasons: reasons }, {
  cvHtml,
  coverLetter: clText,
  coverLetterHtml: clHtml,
  referenceLetter: rlHtml,
  gmailDraftId: draft?.uid || (draft?.success ? 'created' : null),
  generationMethod: [cvMethod, clMethod].some((m) => m.startsWith('llm')) ? `${cvMethod}/${clMethod}` : 'keyword',
});
console.log('synced to job_inbox');

const { rows: after } = await pool.query(
  `SELECT score, gmail_draft_id, doc_status, generation_method,
          length(cv_html) AS cv_len, length(cover_letter) AS cl_len,
          length(cover_letter_html) AS cl_html_len, length(reference_letter) AS rl_len,
          (cover_letter_html LIKE '%#ff8bb1%') AS cl_html_pink
     FROM job_inbox WHERE user_id=$1 AND url=$2`, [uid, TARGET]);
console.log('db row after:', JSON.stringify(after[0]));
await pool.end();
process.exit(0);
