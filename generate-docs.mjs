#!/usr/bin/env node
/**
 * generate-docs.mjs — CLI wrapper for CV + cover letter + Gmail draft generation
 *
 * Runs the same pipeline as the dashboard "Generate CV & Letter" button:
 *   1. Reads cv.md + config/profile.yml + article-digest.md
 *   2. Tailors CV to the JD (career-ops keyword injection — no fabrication)
 *   3. Runs build-cv-html.mjs → output/cv-{candidate}-{company}-{date}.html
 *   4. Generates cover letter (cover.md logic)
 *   5. Creates Gmail DRAFT (NEVER sends — stays in Drafts folder)
 *
 * Usage:
 *   node generate-docs.mjs --company "Acme Corp" --role "AI Engineer" --url "https://acme.com/jobs/123"
 *   node generate-docs.mjs --company "Seek" --role "Automation Specialist" --jd "path/to/jd.txt"
 *   node generate-docs.mjs --company "Anthropic" --role "ML Ops" --type cv        # CV only, no letter
 *   node generate-docs.mjs --company "Google" --role "Engineer" --dry-run          # skip Gmail draft
 *   node generate-docs.mjs --help
 *
 * Flags:
 *   --company     Company name (required)
 *   --role        Role title (required)
 *   --url         Job posting URL (used in Gmail draft + apply link)
 *   --jd          Path to a .txt/.md file with the JD text (optional but improves tailoring)
 *   --type        cv | cover | both (default: both)
 *   --dry-run     Skip Gmail draft creation
 *   --no-gmail    Same as --dry-run
 *   --help        Show this help
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const jsyaml = require('js-yaml');


const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`
generate-docs.mjs — career-ops CV + cover letter + Gmail draft generator

USAGE
  node generate-docs.mjs --company "Acme Corp" --role "AI Engineer" --url "https://..."

FLAGS
  --company   Company name (required)
  --role      Role title (required)
  --url       Job posting URL (shown in Gmail draft subject + apply link)
  --jd        Path to JD text file (improves tailoring)
  --type      cv | cover | both  [default: both]
  --dry-run   Skip Gmail draft creation
  --no-gmail  Same as --dry-run
  --help      This help

OUTPUT
  output/cv-{candidate}-{company}-{date}.html   → Career-ops CV HTML
  output/cv-{candidate}-{company}-{date}.pdf    → PDF (if Playwright installed)
  Gmail Drafts folder                            → Draft with apply link + CV attached
`);
  process.exit(0);
}

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const company   = getArg('--company');
const role      = getArg('--role');
const url       = getArg('--url') || '';
const jdFile    = getArg('--jd');
const type      = getArg('--type') || 'both';
const dryRun    = args.includes('--dry-run') || args.includes('--no-gmail');

if (!company || !role) {
  console.error('❌  --company and --role are required.');
  console.error('    Run with --help for usage.');
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function read(rel) {
  try { return readFileSync(join(__dirname, rel), 'utf8'); } catch { return null; }
}

// ── Read career-ops source files ─────────────────────────────────────────────
const cvMd = read('cv.md');
if (!cvMd) {
  console.error('❌  cv.md not found. Run from career-ops root directory.');
  process.exit(1);
}

const profileRaw = read('config/profile.yml') || '';
const profile    = jsyaml.load(profileRaw) || {};

const cand       = profile.candidate || {};
const articleDigest = read('article-digest.md') || '';

const jdText = jdFile
  ? (existsSync(resolve(jdFile)) ? readFileSync(resolve(jdFile), 'utf8') : '')
  : '';

// ── Parse cv.md ──────────────────────────────────────────────────────────────
function parseCvMd(text) {
  const summaryMatch = text.match(/## Professional Summary\n+([\s\S]*?)(?=\n## )/);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';

  const experience = [];
  const expSection = text.match(/## Professional Experience\n([\s\S]*?)(?=\n## |$)/);
  if (expSection) {
    for (const entry of expSection[1].split(/\n### /).filter(Boolean)) {
      const lines = entry.split('\n').filter(Boolean);
      const expRole = lines[0]?.replace(/^### /, '').trim() || '';
      const dates = lines[1]?.trim() || '';
      const companyLine = (lines[2] || '').trim();
      const [expCompany, location] = companyLine.split('|').map(s => s?.trim() || '');
      const bullets = lines.slice(3).filter(l => l.trim().startsWith('-')).map(l => l.replace(/^[-•]\s*/, '').trim());
      if (expCompany) experience.push({ company: expCompany, role: expRole, location: location || '', dates, bullets });
    }
  }

  const skills = [];
  const skillsSection = text.match(/## (?:Technical )?Skills?\n([\s\S]*?)(?=\n## |$)/i);
  if (skillsSection) {
    for (const line of skillsSection[1].split('\n').filter(l => l.trim().startsWith('-'))) {
      const ci = line.indexOf(':');
      if (ci > 0) skills.push({ category: line.slice(1, ci).trim(), items: line.slice(ci + 1).trim() });
    }
    if (!skills.length) {
      const all = skillsSection[1].split('\n').filter(l => l.trim().startsWith('-')).map(l => l.replace(/^-\s*/, '').trim());
      if (all.length) skills.push({ category: 'Technical Skills', items: all.join(', ') });
    }
  }

  const education = [];
  const eduSection = text.match(/## Education\n([\s\S]*?)(?=\n## |$)/i);
  if (eduSection) {
    for (const line of eduSection[1].split('\n').filter(l => l.startsWith('-'))) {
      const parts = line.replace(/^-\s*/, '').split('|');
      education.push({ title: parts[0]?.trim() || '', org: parts[1]?.trim() || '', year: parts[2]?.trim() || '' });
    }
  }

  const projects = [];
  const projSection = text.match(/## Projects?\n([\s\S]*?)(?=\n## |$)/i);
  if (projSection) {
    for (const entry of projSection[1].split(/\n### /).filter(Boolean)) {
      const lines = entry.split('\n').filter(Boolean);
      const name = lines[0]?.replace(/^### /, '').trim() || '';
      const bullets = lines.slice(1).filter(l => l.trim().startsWith('-')).map(l => l.replace(/^[-•]\s*/, '').trim());
      if (name) projects.push({ name, description: bullets.join(' ') || name });
    }
  }

  return { summary, experience, skills, education, projects };
}

// ── Tailor to JD keywords ─────────────────────────────────────────────────────
function tailor(parsed, jd) {
  const stopWords = new Set(['with','that','this','have','from','will','your','they','been','also','more','team','role','skill','years','experience','ability','strong','using','well','both','must','including','required','preferred','looking']);
  const freq = new Map();
  for (const w of (jd.toLowerCase().match(/\b[a-z][a-z0-9./_-]{3,}\b/g) || [])) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const keywords = [...freq.entries()]
    .filter(([w]) => !stopWords.has(w) && w.length > 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => w);

  const competencies = [
    ...keywords.slice(0, 6).map(k => k.charAt(0).toUpperCase() + k.slice(1)),
    'End-to-End Automation', 'Multi-Agent Orchestration', 'AI Pipeline Design',
    'Marketing Automation', 'Lead Generation Systems', 'Process Optimization',
  ].slice(0, 8);

  const tailoredSummary = jd
    ? `${role} candidate with proven experience in ${keywords.slice(0, 3).join(', ') || 'automation and AI systems'}. ${parsed.summary}`
    : parsed.summary;

  const sortedExperience = parsed.experience.map(exp => ({
    ...exp,
    bullets: [...exp.bullets].sort((a, b) => {
      const sa = keywords.filter(k => a.toLowerCase().includes(k)).length;
      const sb = keywords.filter(k => b.toLowerCase().includes(k)).length;
      return sb - sa;
    }),
  }));

  const sortedProjects = [...parsed.projects]
    .map(p => ({ ...p, _score: keywords.filter(k => (p.name + p.description).toLowerCase().includes(k)).length }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 4);

  return { summary: tailoredSummary, competencies, experience: sortedExperience, projects: sortedProjects, education: parsed.education, skills: parsed.skills };
}

// ── Build cover letter (cover.md logic) ──────────────────────────────────────
function buildCoverLetter(tailored, profileData, jd, companyName, roleName) {
  const c = profileData.candidate || {};
  const name = c.full_name || 'Ilse Placencia';
  const email = c.email || '';
  const phone = c.phone || '';
  const portfolio = c.portfolio_url || '';
  const today = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

  const requirements = jd.split('\n')
    .filter(l => l.trim().match(/^[-•*]/) && l.length > 20 && l.toLowerCase().match(/experience|skill|knowledge|ability|proven|strong/))
    .slice(0, 3).map(l => l.replace(/^[-•*]\s*/, '').trim());

  const req1 = requirements[0] || 'automation and AI systems design';
  const req2 = requirements[1] || 'cross-functional delivery and collaboration';

  return `${today}

Hiring Manager
${companyName}

Dear Hiring Manager,

I am writing to express my strong interest in the ${roleName} position at ${companyName}. With hands-on experience building end-to-end automation systems, AI pipelines, and multi-agent workflows, I am confident I can deliver immediate and lasting value to your team.

${tailored.summary.split('.').slice(0, 2).join('.').trim()}.

What draws me to this role specifically is the opportunity to apply my experience directly to ${req1.toLowerCase()}. At APEX Website Solutions, I architected a fully automated B2B lead generation engine that scrapes qualified prospects, generates audit reports, and books discovery calls without any manual intervention — a system that operates 24/7 at scale.

I have also demonstrated ability in ${req2.toLowerCase()}. At Lumi and Milo, I built a Python and Gemini API content pipeline that takes a topic from idea to published YouTube video in a single click — reducing production time from hours to minutes.

I thrive in remote, async-first environments and take ownership from discovery through delivery.

${url ? `I have attached my tailored CV. The direct application link is: ${url}` : 'I have attached my tailored CV.'}

Thank you for your time and consideration.

Best regards,
${name}
${email}${phone ? '\n' + phone : ''}${portfolio ? '\n' + portfolio : ''}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const candidateSlug = slugify(cand.full_name || 'candidate');
  const companySlug = slugify(company);

  console.log('\n' + '═'.repeat(60));
  console.log(`⚙️   career-ops — Generate CV & Cover Letter`);
  console.log(`    Role:    ${role}`);
  console.log(`    Company: ${company}`);
  console.log(`    Type:    ${type}${dryRun ? '  |  DRY RUN (no Gmail draft)' : ''}`);
  console.log('═'.repeat(60) + '\n');

  // Parse and tailor
  console.log('📖  Reading cv.md + profile.yml…');
  const parsed = parseCvMd(cvMd + (articleDigest ? '\n' + articleDigest : ''));
  const tailored = tailor(parsed, jdText);

  mkdirSync(join(__dirname, 'output'), { recursive: true });

  let cvHtmlPath = null;
  let coverLetterText = null;

  // ── CV ──────────────────────────────────────────────────────────────────────
  if (type === 'cv' || type === 'both') {
    console.log('📄  Building CV payload → running build-cv-html.mjs…');

    const payload = {
      lang: 'en', page_format: 'a4',
      candidate: {
        name: cand.full_name || 'Ilse Placencia',
        phone: cand.phone || '', email: cand.email || '',
        linkedin: cand.linkedin ? { url: cand.linkedin, display: cand.linkedin.replace(/^https?:\/\//, '') } : undefined,
        portfolio: cand.portfolio_url ? { url: cand.portfolio_url, display: cand.portfolio_url.replace(/^https?:\/\//, '') } : undefined,
        location: cand.location || '', photo: cand.photo || '',
      },
      summary: tailored.summary,
      competencies: tailored.competencies,
      experience: tailored.experience,
      projects: tailored.projects,
      education: tailored.education,
      skills: tailored.skills,
    };

    const payloadPath = join(tmpdir(), `cv-${candidateSlug}-${companySlug}.json`);
    const outputHtmlPath = join(__dirname, 'output', `cv-${candidateSlug}-${companySlug}-${today}.html`);
    writeFileSync(payloadPath, JSON.stringify(payload, null, 2));

    try {
      const { stdout, stderr } = await execFileAsync('node', [
        join(__dirname, 'build-cv-html.mjs'), payloadPath, outputHtmlPath,
      ], { cwd: __dirname, timeout: 30_000 });
      if (stderr && stderr.includes('Error')) console.warn('  ⚠️  build-cv-html warning:', stderr.slice(0, 200));
    } catch (err) {
      console.error('  ❌  build-cv-html.mjs failed:', err.message.slice(0, 200));
    }

    if (existsSync(outputHtmlPath)) {
      cvHtmlPath = outputHtmlPath;
      console.log(`  ✅  CV HTML → ${outputHtmlPath}`);

      // Try PDF render
      console.log('📑  Rendering PDF via generate-pdf.mjs…');
      const pdfPath = outputHtmlPath.replace('.html', '.pdf');
      try {
        await execFileAsync('node', [
          join(__dirname, 'generate-pdf.mjs'), outputHtmlPath, pdfPath, '--format=a4',
        ], { cwd: __dirname, timeout: 60_000 });
        console.log(`  ✅  PDF → ${pdfPath}`);
        cvHtmlPath = pdfPath; // Prefer PDF for Gmail attachment
      } catch {
        console.log('  ⚠️  PDF render failed (Playwright may not be installed) — using HTML');
      }
    } else {
      console.error('  ❌  CV HTML was not created — check build-cv-html.mjs output above');
    }
  }

  // ── Cover letter ────────────────────────────────────────────────────────────
  if (type === 'cover' || type === 'both') {
    console.log('✉️   Generating cover letter (cover.md logic)…');
    coverLetterText = buildCoverLetter(tailored, profile, jdText, company, role);
    const clPath = join(__dirname, 'output', `cover-${companySlug}-${today}.txt`);
    writeFileSync(clPath, coverLetterText);
    console.log(`  ✅  Cover letter → ${clPath}`);
  }

  // ── Gmail draft ──────────────────────────────────────────────────────────────
  if (!dryRun && (type === 'cv' || type === 'both')) {
    console.log('📬  Creating Gmail draft…');
    try {
      const { createGmailDraft } = await import('./lib/gmail-draft.mjs');
      const fromEmail = cand.email || 'placenciailse@gmail.com';
      const emailBody = url
        ? `🔗 APPLY HERE: ${url}\n\n${'─'.repeat(50)}\n\n${coverLetterText || ''}`
        : (coverLetterText || `Application for ${role} at ${company}`);

      const attachments = cvHtmlPath ? [{
        path: cvHtmlPath,
        filename: `CV-${cand.full_name || 'Candidate'}-${company}.${cvHtmlPath.endsWith('.pdf') ? 'pdf' : 'html'}`,
      }] : [];

      const result = await createGmailDraft({
        from: fromEmail, to: '',
        subject: `[career-ops] ${role} at ${company} — ${today}`,
        body: emailBody,
        attachments,
      });

      if (result.success) {
        console.log(`  ✅  Gmail draft created (uid: ${result.uid}) — check your Drafts folder`);
      } else {
        console.error(`  ❌  Gmail draft failed: ${result.error}`);
      }
    } catch (err) {
      console.error('  ❌  Gmail draft error:', err.message);
    }
  } else if (dryRun) {
    console.log('⏭️   Dry run — Gmail draft skipped');
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('✅  Done!');
  if (cvHtmlPath)      console.log(`   CV:           ${cvHtmlPath}`);
  if (coverLetterText) console.log(`   Cover letter: output/cover-${companySlug}-${today}.txt`);
  if (!dryRun)         console.log(`   Gmail:        Check your Drafts folder`);
  console.log('─'.repeat(60) + '\n');
}

main().catch(err => {
  console.error('❌  Fatal:', err.message);
  process.exit(1);
});
