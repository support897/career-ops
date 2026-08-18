/**
 * Generate a CV and cover letter for a real scored job using the LLM path,
 * then prove the prose is genuinely job-specific and the pink accent survived.
 * Creates no Gmail draft.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { load } from 'js-yaml';

const profileYml = load(readFileSync('./config/profile.yml', 'utf8'));
const { getProfileConfig } = await import('./lib/db-reader.mjs');
const cfg = await getProfileConfig(process.env.VIP_USER_ID);
console.log('dashboard llm_docs:', JSON.stringify(cfg?.llm_docs));

const profileForDoc = {
  fullName: profileYml?.candidate?.full_name || 'Ilse Placencia',
  phone: profileYml?.candidate?.phone,
  email: profileYml?.candidate?.email,
  location: profileYml?.candidate?.location,
  portfolioUrl: profileYml?.candidate?.portfolio_url,
  style: profileYml?.style,
};

const job = {
  company: 'Zyte',
  role: 'Platform and Automation Engineer (Remote)',
  title: 'Platform and Automation Engineer (Remote)',
};
const jdText = `Zyte is hiring a Platform and Automation Engineer to work fully remote.
You will build and maintain internal automation for a large scale web data extraction
platform, own CI/CD pipelines, write Python tooling, containerise services with Docker,
and improve observability across a distributed crawling fleet. Experience with API
integration, Kubernetes and infrastructure as code is highly valued. We care about
reliability engineering and reducing manual toil.`;
const reasons = [
  'Strong AI automation and platform engineering experience aligns with target roles',
  'Remote work matches candidate preference',
];

const { llmCoverLetterCopy, llmCvSummary } = await import('./lib/llm-docs.mjs');

console.log('\n=== 1. LLM cover letter copy ===');
let clOverrides = null;
try {
  const r = await llmCoverLetterCopy(profileForDoc, job, jdText, reasons);
  clOverrides = { opening: r.opening, profile_intro: r.profile_intro, closing: r.closing };
  console.log('backend :', r.method);
  console.log('OPENING :', r.opening);
  console.log('BODY    :', r.profile_intro.slice(0, 300));
  console.log('CLOSING :', r.closing);
  const text = [r.opening, r.profile_intro, r.closing].join(' ');
  console.log('mentions Zyte?     ', /zyte/i.test(text));
  console.log('mentions the role? ', /automation|platform/i.test(text));
  console.log('JD-specific terms? ', ['docker', 'ci/cd', 'python', 'kubernetes', 'observability', 'crawl', 'data extraction', 'reliability']
    .filter((t) => text.toLowerCase().includes(t)));
  console.log('banned cliches?    ', ['writing to express', 'hope this finds', 'passionate', 'dynamic', '\u2014']
    .filter((t) => text.toLowerCase().includes(t)));
} catch (e) {
  console.log('FAILED:', e.message);
}

console.log('\n=== 2. LLM CV summary ===');
let cvOverrides = null;
try {
  const r = await llmCvSummary(profileForDoc, job, jdText);
  cvOverrides = { summary: r.summary };
  console.log('backend:', r.method);
  console.log('summary:', r.summary);
} catch (e) {
  console.log('FAILED:', e.message);
}

console.log('\n=== 3. Render real PDFs with that copy ===');
const { generateCoverLetter } = await import('./lib/cover-letter-generator.mjs');
const { generateCV } = await import('./lib/cv-generator.mjs');

const cl = await generateCoverLetter(profileForDoc, job, jdText, '/tmp/llmdocs', clOverrides);
console.log('cover letter pdf :', cl.pdfPath, cl.success ? 'OK' : cl.error);
if (cl.htmlPath) {
  const h = readFileSync(cl.htmlPath, 'utf8');
  console.log('  CL html has #ff8bb1 :', h.includes('#ff8bb1'));
  console.log('  CL html has LLM text:', clOverrides ? h.includes(clOverrides.opening.slice(0, 40)) : 'n/a');
}
if (cl.textPath) {
  console.log('  CL text has LLM text:', clOverrides
    ? readFileSync(cl.textPath, 'utf8').includes(clOverrides.opening.slice(0, 40)) : 'n/a');
}

const cvr = await generateCV(profileForDoc, jdText, '/tmp/llmdocs', 'zyte', cvOverrides);
console.log('cv pdf           :', cvr.pdfPath, cvr.success ? 'OK' : cvr.error);
if (cvr.htmlPath) {
  const h = readFileSync(cvr.htmlPath, 'utf8');
  console.log('  CV html has #ff8bb1  :', h.includes('#ff8bb1'));
  console.log('  CV html has LLM sum. :', cvOverrides ? h.includes(cvOverrides.summary.slice(0, 40)) : 'n/a');
  console.log('  CV filename per-company:', /zyte/.test(cvr.pdfPath));
}
process.exit(0);
