/**
 * cover-letter-generator.mjs — Template-based cover letter generation.
 *
 * Generates a tailored cover letter by:
 * 1. Extracting requirements from the job description
 * 2. Matching requirements to experience
 * 3. Building personalized paragraphs
 * 4. Rendering HTML via cover-letter-template.html
 * 5. Converting to PDF via Playwright
 *
 * Usage:
 *   import { generateCoverLetter } from './lib/cover-letter-generator.mjs';
 *   const result = await generateCoverLetter(profile, jobData, outputPath);
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Experience Map ────────────────────────────────────────────────────────

const EXPERIENCE_MAP = {
  automation: {
    superpower: 'End-to-end automation pipeline design',
    proof: 'Built a fully automated B2B lead generation engine at APEX Website Solutions that scrapes prospects, generates audit reports, sends cold emails, and books calls 24/7 with zero manual input.',
    company: 'APEX Website Solutions',
  },
  ai: {
    superpower: 'Multi-agent orchestration and AI voice agents',
    proof: 'Designed a multi-agent YouTube content pipeline at Lumi and Milo with a dedicated QC agent using Python, Gemini API, and Google Antigravity orchestration.',
    company: 'Lumi and Milo',
  },
  marketing: {
    superpower: 'Marketing automation across Facebook, email, SEO, and web',
    proof: 'Planned and executed full-funnel digital campaigns at Evolve Marketing across multiple product launches in a fully remote, async-first team.',
    company: 'Evolve Marketing',
  },
  lead_generation: {
    superpower: 'B2B lead generation and cold outreach automation',
    proof: 'Built a complete lead generation system at APEX that scrapes qualified prospects, generates personalized audits, sends cold emails, and books discovery calls through an AI voice agent.',
    company: 'APEX Website Solutions',
  },
  n8n: {
    superpower: 'Workflow orchestration with n8n, Make, and Node.js',
    proof: 'Architected automated workflows at APEX using n8n and Google Antigravity that handle prospect scraping, audit generation, email sequences, and call booking.',
    company: 'APEX Website Solutions',
  },
  python: {
    superpower: 'Python automation and AI integration',
    proof: 'Built a Python and Gemini API YouTube content pipeline at Lumi and Milo that orchestrates script generation, visual creation, voiceover synthesis, and video assembly.',
    company: 'Lumi and Milo',
  },
  api: {
    superpower: 'API integration and webhook automation',
    proof: 'Integrated multiple APIs across businesses including Vapi, Bland AI, Facebook Graph API, and custom Node.js services for lead capture and outreach.',
    company: 'APEX Website Solutions',
  },
  voice: {
    superpower: 'AI voice agents for lead qualification',
    proof: 'Deployed Bland AI and Vapi voice agents at Fiesta Fresh Cleaning and APEX that autonomously qualify leads and book appointments 24/7.',
    company: 'Fiesta Fresh Cleaning',
  },
  content: {
    superpower: 'Automated content production pipelines',
    proof: 'Built a YouTube content pipeline at Lumi and Milo that goes from script to published video in a single click using Python, Gemini API, and multi-agent orchestration.',
    company: 'Lumi and Milo',
  },
  growth: {
    superpower: 'Growth engineering and demand generation',
    proof: 'Built automated lead generation and outreach systems at APEX that generate B2B demand on autopilot.',
    company: 'APEX Website Solutions',
  },
  email: {
    superpower: 'Cold email and nurture sequence automation',
    proof: 'Engineered automated cold email sequences at APEX and Fiesta Fresh that deliver personalized outreach at scale.',
    company: 'APEX Website Solutions',
  },
  remote: {
    superpower: 'Remote-first async team management',
    proof: 'Managed full-funnel digital campaigns at Evolve Marketing across distributed, multi-timezone remote teams.',
    company: 'Evolve Marketing',
  },
  b2b: {
    superpower: 'B2B lead generation and sales automation',
    proof: 'Built complete B2B sales automation at APEX: prospect scraping, audit reports, cold email, AI voice calls, and website deployment.',
    company: 'APEX Website Solutions',
  },
  saas: {
    superpower: 'SaaS workflow automation',
    proof: 'Built end-to-end automation systems using n8n, Make, and custom Node.js services that integrate multiple SaaS platforms.',
    company: 'APEX Website Solutions',
  },
  facebook: {
    superpower: 'Facebook and social media automation',
    proof: 'Built a Node.js Facebook automation app at Fiesta Fresh that publishes daily posts and auto-responds to purchase-intent signals.',
    company: 'Fiesta Fresh Cleaning',
  },
  social_media: {
    superpower: 'Social media automation and engagement',
    proof: 'Built a Facebook Graph API webhook system at Fiesta Fresh that detects purchase-intent posts and auto-responds with tailored outreach.',
    company: 'Fiesta Fresh Cleaning',
  },
  operations: {
    superpower: 'Operations optimization and process automation',
    proof: 'Eliminated manual operations across three businesses by building automated workflows for lead generation, content production, and sales.',
    company: 'APEX Website Solutions',
  },
  gtm: {
    superpower: 'GTM systems and go-to-market automation',
    proof: 'Built complete GTM automation: lead scraping, cold outreach, AI voice qualification, and website deployment at APEX.',
    company: 'APEX Website Solutions',
  },
  revops: {
    superpower: 'Revenue operations automation',
    proof: 'Automated the full revenue pipeline at Fiesta Fresh: lead detection, qualification, outreach, and appointment booking.',
    company: 'Fiesta Fresh Cleaning',
  },
  virtual_assistant: {
    superpower: 'AI-powered virtual assistance and automation',
    proof: 'Built AI voice agents and automated workflows that handle lead qualification, appointment booking, and customer outreach 24/7.',
    company: 'Fiesta Fresh Cleaning',
  },
};

// ─── Keyword Extraction ────────────────────────────────────────────────────

const SKILL_KEYWORDS = [
  'automation', 'automated', 'automate', 'workflow', 'orchestrat',
  'ai', 'artificial intelligence', 'machine learning', 'ml', 'llm', 'chatbot',
  'marketing', 'digital marketing', 'seo', 'content', 'social media',
  'lead generation', 'cold email', 'outreach', 'crm', 'demand gen',
  'python', 'javascript', 'node', 'nodejs', 'typescript', 'api',
  'n8n', 'make', 'zapier', 'airtable', 'hubspot', 'salesforce',
  'data', 'analytics', 'sql', 'cloud', 'aws', 'gcp',
  'growth', 'revops', 'gtm', 'go-to-market', 'operations',
  'voice', 'vapi', 'bland', 'content', 'facebook',
  'b2b', 'b2c', 'saas', 'startup', 'remote',
  'virtual assistant', 'executive assistant', 'project manager',
];

/**
 * Extract relevant keywords from a job description.
 */
function extractJDKeywords(jdText) {
  const text = (jdText || '').toLowerCase();
  const found = [];
  for (const kw of SKILL_KEYWORDS) {
    if (text.includes(kw)) found.push(kw);
  }
  return found;
}

/**
 * Match JD keywords to experience entries.
 */
function matchToExperience(jdKeywords) {
  const matches = [];
  const seen = new Set();

  for (const kw of jdKeywords) {
    const entry = EXPERIENCE_MAP[kw];
    if (entry && !seen.has(entry.company + entry.superpower)) {
      matches.push({ keyword: kw, ...entry });
      seen.add(entry.company + entry.superpower);
    }
  }

  return matches;
}

/**
 * Build the cover letter payload for generate-cover-letter.mjs.
 */
export function buildCoverLetterPayload(profile, job, jdText) {
  const jdKeywords = extractJDKeywords(jdText);
  const matches = matchToExperience(jdKeywords);

  const fullName = profile?.fullName || profile?.full_name || 'Ilse Placencia';
  const phone = profile?.phone || '+61498570497';
  const email = profile?.email || 'placenciailse@gmail.com';
  const location = profile?.location || 'Gold Coast, QLD, Australia';
  const portfolio = profile?.portfolioUrl || profile?.portfolio_url || 'https://www.ilseplacencia.shop';

  const company = job?.company || 'your company';
  const role = job?.title || job?.role || 'the open position';

  // Build opening paragraph
  const opening = `I'm writing to express my strong interest in the ${role} position at ${company}. With 4+ years of experience building AI-powered automation systems across three businesses I founded, I bring a unique combination of technical depth and real-world business outcomes.`;

  // Build profile intro
  const topMatches = matches.slice(0, 3);
  let profileIntro = '';
  if (topMatches.length > 0) {
    const skillList = topMatches.map(m => m.keyword.replace(/_/g, ' '));
    profileIntro = `Your role emphasizes ${skillList.slice(0, 3).join(', ')} — here's what I've built in these areas:\n\n`;
    for (const match of topMatches) {
      profileIntro += `${match.proof}\n\n`;
    }
    profileIntro = profileIntro.trim();
  } else {
    profileIntro = 'I build AI-powered automation systems that replace manual operations with intelligent workflows. At APEX Website Solutions, I built a fully automated B2B lead generation engine. At Lumi and Milo, I designed a multi-agent orchestration system with a dedicated QC agent. At Fiesta Fresh, I built the complete marketing automation stack.';
  }

  // Build achievements list
  const achievements = topMatches.map(m => ({
    lead: m.superpower,
    impact: m.proof,
  }));

  // Build closing
  const closing = `I'd welcome the chance to discuss how my experience can contribute to ${company}'s growth. I'm available for a conversation at your convenience and happy to share more about my work.`;

  return {
    candidate: {
      name: fullName,
      phone,
      email,
      linkedin: portfolio,
      location,
    },
    letter: {
      company,
      role_title: role,
      greeting: `Dear ${company} Hiring Team,`,
      dateline: { company, city: location, date: new Date().toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' }) },
      opening,
      profile_intro: profileIntro,
      achievements,
      problems_section: '',
      closing,
      language_closing: '',
      footnotes: [
        { text: `Portfolio: ${portfolio}`, url: portfolio },
      ],
    },
    output_path: null, // Caller sets this
  };
}

/**
 * Render cover letter HTML from payload using the template.
 */
function renderCoverLetterHtml(template, payload) {
  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function asUrl(value) {
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  }

  const candidate = payload.candidate;
  const letter = payload.letter;

  // Contact line
  const contactParts = [];
  if (candidate.location) contactParts.push(escapeHtml(candidate.location));
  if (candidate.email) contactParts.push(`<a href="mailto:${escapeHtml(candidate.email)}">${escapeHtml(candidate.email)}</a>`);
  if (candidate.phone) contactParts.push(escapeHtml(candidate.phone));
  if (candidate.linkedin) contactParts.push(`<a href="${escapeHtml(asUrl(candidate.linkedin))}">Portfolio</a>`);
  const contactLine = contactParts.join(' &nbsp;|&nbsp; ');

  // Dateline
  const dl = letter.dateline || {};
  const dateline = [dl.company, dl.city, dl.date].filter(Boolean).map(escapeHtml).join(' &nbsp;&nbsp; ');

  // Greeting
  const greetingBlock = letter.greeting ? `<p class="greeting">${escapeHtml(letter.greeting)}</p>` : '';

  // Achievements
  let achievementsBlock = '';
  if (letter.achievements && letter.achievements.length > 0) {
    const items = letter.achievements.map(a => {
      const lead = escapeHtml(a.lead || '');
      const impact = escapeHtml(a.impact || '');
      return `    <li><b>${lead},</b> ${impact}</li>`;
    }).join('\n');
    achievementsBlock = `<ul class="achievements">\n${items}\n  </ul>`;
  }

  // Footnotes
  let footnotesBlock = '';
  if (letter.footnotes && letter.footnotes.length > 0) {
    const lines = letter.footnotes.map(fn => {
      const text = escapeHtml(fn.text || '');
      const url = fn.url ? ` <a href="${escapeHtml(fn.url)}">${escapeHtml(fn.url)}</a>` : '';
      return `    <p>${text}${url}</p>`;
    }).join('\n');
    footnotesBlock = `<div class="footnotes">\n${lines}\n  </div>`;
  }

  const replacements = {
    '{{NAME}}': escapeHtml(candidate.name),
    '{{CONTACT_LINE}}': contactLine,
    '{{CREDENTIALS_BLOCK}}': '',
    '{{ROLE_TITLE}}': escapeHtml(letter.role_title),
    '{{DATELINE}}': dateline,
    '{{GREETING_BLOCK}}': greetingBlock,
    '{{OPENING}}': escapeHtml(letter.opening),
    '{{PROFILE_INTRO}}': escapeHtml(letter.profile_intro),
    '{{ACHIEVEMENTS_BLOCK}}': achievementsBlock,
    '{{PROBLEMS_BLOCK}}': letter.problems_section ? `<p>${escapeHtml(letter.problems_section)}</p>` : '',
    '{{CLOSING_BLOCK}}': letter.closing ? `<p>${escapeHtml(letter.closing)}</p>` : '',
    '{{LANGUAGE_CLOSING_BLOCK}}': letter.language_closing ? `<p class="language-closing">${escapeHtml(letter.language_closing)}</p>` : '',
    '{{FOOTNOTES_BLOCK}}': footnotesBlock,
  };

  return template.replace(/\{\{[A-Z_]+\}\}/g, (token) => replacements[token] ?? token);
}

/**
 * Generate cover letter HTML from profile + job data.
 * Returns the HTML string.
 */
export function generateCoverLetterHtml(profile, job, jdText) {
  const payload = buildCoverLetterPayload(profile, job, jdText);
  const templatePath = resolve(__dirname, '..', 'templates', 'cover-letter-template.html');
  const template = readFileSync(templatePath, 'utf-8');
  return renderCoverLetterHtml(template, payload);
}

/**
 * Generate cover letter PDF from profile + job data.
 * Returns { htmlPath, pdfPath, success }.
 */
export async function generateCoverLetter(profile, job, jdText, outputDir) {
  const slug = (job?.company || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  const date = new Date().toISOString().split('T')[0];

  const htmlPath = join(outputDir || '/tmp', `cover-letter-${slug}-${date}.html`);
  const pdfPath = join(outputDir || '/tmp', `cover-letter-${slug}-${date}.pdf`);

  try {
    const html = generateCoverLetterHtml(profile, job, jdText);
    writeFileSync(htmlPath, html, 'utf-8');

    // Convert to PDF via Playwright
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0.5in', bottom: '0.5in', left: '0.75in', right: '0.75in' },
    });
    await browser.close();

    // Also generate plain text version for email body
    const textPayload = buildCoverLetterPayload(profile, job, jdText);
    const textPath = join(outputDir || '/tmp', `cover-letter-${slug}-${date}.txt`);
    const textContent = `${textPayload.candidate.name}\n${textPayload.candidate.location} | ${textPayload.candidate.email} | ${textPayload.candidate.phone}\n\nCover Letter: ${textPayload.letter.role_title}\n\n${textPayload.letter.greeting || ''}\n\n${textPayload.letter.opening}\n\n${textPayload.letter.profile_intro}\n\n${textPayload.letter.closing || ''}\n\nBest regards,\n${textPayload.candidate.name}\n${textPayload.candidate.email} | ${textPayload.candidate.phone}\n${textPayload.candidate.linkedin}`;
    writeFileSync(textPath, textContent, 'utf-8');

    return { htmlPath, pdfPath, textPath, success: true };
  } catch (e) {
    console.error(`[cover-letter-generator] Failed: ${e.message}`);
    return { htmlPath: null, pdfPath: null, textPath: null, success: false, error: e.message };
  }
}
