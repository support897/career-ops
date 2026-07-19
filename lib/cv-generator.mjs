/**
 * cv-generator.mjs — Template-based CV generation from profile + JD keywords.
 *
 * Generates a tailored CV by:
 * 1. Extracting keywords from the job description
 * 2. Building a tailored summary mentioning those keywords
 * 3. Selecting relevant experience/competencies based on JD match
 * 4. Rendering HTML via cv-template.html
 * 5. Converting to PDF via Playwright
 *
 * Usage:
 *   import { generateCV } from './lib/cv-generator.mjs';
 *   const result = await generateCV(profile, jobDescription, outputPath);
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Keyword Extraction ────────────────────────────────────────────────────

const SKILL_KEYWORDS = [
  'ai', 'artificial intelligence', 'machine learning', 'ml', 'deep learning',
  'automation', 'automated', 'automate', 'workflow', 'pipeline', 'orchestrat',
  'nlp', 'natural language', 'chatbot', 'voice agent', 'agent', 'llm',
  'python', 'javascript', 'node', 'nodejs', 'typescript', 'api', 'rest',
  'n8n', 'make', 'zapier', 'airtable', 'hubspot', 'salesforce',
  'marketing', 'digital marketing', 'seo', 'sem', 'content', 'social media',
  'lead generation', 'cold email', 'outreach', 'crm', 'demand gen',
  'data', 'analytics', 'etl', 'sql', 'postgres', 'mongodb',
  'cloud', 'aws', 'gcp', 'azure', 'docker', 'kubernetes',
  'web', 'frontend', 'backend', 'fullstack', 'react', 'nextjs', 'vue',
  'growth', 'revops', 'revenue operations', 'gtm', 'go-to-market',
  'product', 'project management', 'agile', 'scrum',
  'operations', 'process', 'optimization', 'efficiency',
  'integrations', 'solutions', 'consulting', 'freelance',
  'b2b', 'b2c', 'saas', 'startup', 'enterprise',
  'virtual assistant', 'executive assistant', 'operations manager',
];

// ─── Profile Data (Ilse's experience) ──────────────────────────────────────

const EXPERIENCE = [
  {
    company: 'APEX Website Solutions',
    role: 'Founder and Automation Engineer',
    dates: 'Apr 2026 – Present',
    location: 'Remote',
    bullets: [
      'Architected a fully automated B2B lead generation engine using Google Antigravity and n8n that scrapes qualified prospects daily, analyzes websites for performance gaps, and auto-generates personalized audit reports with zero manual input per cycle.',
      'Engineered a triggered cold email sequence that auto-fires post-audit, delivering personalized outreach to hundreds of prospects simultaneously and eliminating all manual top-of-funnel effort.',
      'Integrated a Vapi and Node.js AI voice calling system that contacts warm leads, handles objections, and books discovery calls 24/7, reducing appointment booking from hours of manual outreach to zero.',
      'Coded a JavaScript conversion pipeline that automatically builds and deploys a fully customized website upon prospect engagement, compressing delivery timelines from weeks to hours.',
    ],
    keywords: ['automation', 'b2b', 'lead generation', 'cold email', 'ai', 'voice agent', 'n8n', 'api', 'pipeline', 'workflow'],
  },
  {
    company: 'Lumi and Milo',
    role: 'Founder and Automation Architect',
    dates: 'May 2026 – Present',
    location: 'Remote',
    bullets: [
      'Designed and deployed a Python and Gemini API YouTube content pipeline that orchestrates script generation, visual creation, voiceover synthesis, and video assembly from a single triggered workflow.',
      'Built a secondary AI quality control agent via Google Antigravity multi-agent orchestration that reviews all output for tone, pacing, and brand consistency prior to human approval.',
      'Reduced human involvement across the entire production process to a single click, after which the system autonomously formats, titles, tags, and publishes content to YouTube.',
    ],
    keywords: ['ai', 'python', 'automation', 'content', 'pipeline', 'multi-agent', 'orchestration'],
  },
  {
    company: 'Fiesta Fresh Cleaning',
    role: 'Co-Owner and Marketing Automation Specialist',
    dates: 'Oct 2025 – Present',
    location: 'Remote',
    bullets: [
      'Coded a Node.js Facebook automation application that publishes daily organic-format posts to business pages, maintaining consistent brand engagement with no manual scheduling.',
      'Built a Facebook Graph API webhook script that detects purchase-intent posts in real time and auto-responds with tailored outreach, capturing leads at the exact moment of intent.',
      'Engineered a Python lead scraping and cold email system that surfaces qualified prospects and feeds them into an automated multi-touch nurture sequence.',
      'Deployed a Bland AI voice agent that autonomously qualifies leads and books appointments, eliminating all manual follow-up from the sales process.',
    ],
    keywords: ['marketing', 'social media', 'facebook', 'lead generation', 'cold email', 'ai', 'voice agent', 'automation'],
  },
  {
    company: 'Evolve Marketing',
    role: 'AI Digital Marketing and Web Specialist',
    dates: 'Jan 2024 – Oct 2025',
    location: 'Remote',
    bullets: [
      'Planned and executed full-funnel digital campaigns across social, email, and web for multiple simultaneous product launches, managing all deliverables asynchronously across distributed, multi-timezone remote teams.',
      'Integrated AI tools into the content production workflow to systematize brief creation, drafting, and visual production, freeing bandwidth for strategy and client relationship management.',
      'Built audience segmentation frameworks from first-party research, sharpening paid campaign targeting and improving engagement performance across all managed accounts.',
    ],
    keywords: ['marketing', 'digital marketing', 'content', 'seo', 'email', 'growth', 'remote'],
  },
];

const COMPETENCIES = [
  'AI Automation', 'Marketing Operations', 'GTM Systems', 'Workflow Orchestration',
  'Lead Generation', 'TypeScript', 'Node.js', 'Python', 'APIs & Webhooks',
  'n8n', 'Claude API', 'Gemini API', 'Multi-Agent Systems', 'B2B Outreach',
  'Content Production', 'Voice AI', 'Facebook Automation', 'Cold Email Systems',
];

const EDUCATION = [
  {
    title: 'Advanced Diploma of Leadership and Management',
    org: 'Academique | Gold Coast, Australia',
    year: 'Apr 2026 – May 2027',
  },
  {
    title: 'Bachelor of Marketing',
    org: 'University of London | Remote',
    year: 'Apr 2025 – Apr 2028',
  },
];

const CERTIFICATIONS = [
  { title: 'AI Fluency for Small Business', org: 'Anthropic', year: '2025' },
  { title: 'AI Fluency: Frameworks and Foundations', org: 'Anthropic', year: '2025' },
  { title: 'Claude with Google Vertex AI', org: 'Anthropic', year: '2025' },
  { title: 'AI Fundamentals', org: 'Google', year: '2025' },
  { title: 'Email Marketing Certification', org: 'HubSpot Academy', year: '2025' },
];

const SKILLS = [
  { category: 'AI & Automation', items: 'n8n, Claude API, Gemini API, Vapi, Bland AI, Google Antigravity' },
  { category: 'Languages', items: 'TypeScript, Node.js, Python, HTML, CSS, REST APIs, Webhooks' },
  { category: 'Platforms', items: 'WordPress, Shopify, Firebase, Supabase' },
  { category: 'Marketing', items: 'Facebook Ads, Google Analytics, GA4, SEO, Email Funnels, Cold Email' },
];

// ─── Core Functions ────────────────────────────────────────────────────────

/**
 * Extract relevant keywords from a job description.
 */
export function extractJDKeywords(jdText) {
  const text = (jdText || '').toLowerCase();
  const found = [];
  for (const kw of SKILL_KEYWORDS) {
    if (text.includes(kw)) found.push(kw);
  }
  return found;
}

/**
 * Build a tailored summary mentioning JD-relevant keywords.
 */
function buildTailoredSummary(jdKeywords) {
  const base = 'AI Automation Specialist and Marketing Engineer with 4+ years of experience designing, coding, and deploying end-to-end automation systems across lead generation, content production, and sales operations. Founded and scaled two fully automated businesses without additional headcount.';

  // Pick the most relevant 3-4 keywords to mention in the summary
  const summaryKeywords = jdKeywords.slice(0, 4);
  if (summaryKeywords.length === 0) return base;

  const tailored = `AI Automation Specialist and Marketing Engineer with 4+ years of experience designing, coding, and deploying end-to-end automation systems across ${summaryKeywords.join(', ')}. Founded and scaled two fully automated businesses without additional headcount. Proven ability to identify bottlenecks, architect intelligent workflows, and deliver measurable operational gains in remote environments.`;
  return tailored;
}

/**
 * Select the most relevant experience entries based on JD keywords.
 * Returns entries sorted by relevance, all included but reordered.
 */
function selectExperience(jdKeywords) {
  // Score each experience entry by keyword overlap
  const scored = EXPERIENCE.map(exp => {
    const overlap = exp.keywords.filter(kw =>
      jdKeywords.some(jk => jk.includes(kw) || kw.includes(jk))
    ).length;
    return { ...exp, relevance: overlap };
  });

  // Sort by relevance descending, keep all entries
  scored.sort((a, b) => b.relevance - a.relevance);
  return scored;
}

/**
 * Select the most relevant competencies based on JD keywords.
 */
function selectCompetencies(jdKeywords) {
  // Score each competency by keyword overlap
  const scored = COMPETENCIES.map(comp => {
    const compLower = comp.toLowerCase();
    const overlap = jdKeywords.filter(kw =>
      compLower.includes(kw) || kw.includes(compLower.split(' ')[0])
    ).length;
    return { comp, relevance: overlap };
  });

  // Sort by relevance, take top 12
  scored.sort((a, b) => b.relevance - a.relevance);
  return scored.slice(0, 12).map(s => s.comp);
}

/**
 * Build the CV JSON payload for build-cv-html.mjs.
 */
export function buildCVPayload(profile, jdText) {
  const jdKeywords = extractJDKeywords(jdText);
  const summary = buildTailoredSummary(jdKeywords);
  const experience = selectExperience(jdKeywords);
  const competencies = selectCompetencies(jdKeywords);

  const fullName = profile?.fullName || profile?.full_name || 'Ilse Placencia';
  const phone = profile?.phone || '+61498570497';
  const email = profile?.email || 'placenciailse@gmail.com';
  const location = profile?.location || 'Gold Coast, QLD, Australia';
  const portfolio = profile?.portfolioUrl || profile?.portfolio_url || 'https://www.ilseplacencia.shop';

  return {
    lang: 'en',
    page_format: 'letter',
    candidate: {
      name: fullName,
      phone,
      email,
      portfolio: { url: portfolio, display: portfolio.replace(/^https?:\/\//, '') },
      linkedin: { url: portfolio, display: portfolio.replace(/^https?:\/\//, '') },
      location,
    },
    summary,
    competencies,
    experience: experience.map(e => ({
      company: e.company,
      role: e.role,
      dates: e.dates,
      location: e.location,
      bullets: e.bullets,
    })),
    projects: [],
    education: EDUCATION,
    certifications: CERTIFICATIONS,
    skills: SKILLS,
    sections: {
      summary: 'Professional Summary',
      competencies: 'Core Competencies',
      experience: 'Work Experience',
      projects: 'Projects',
      education: 'Education',
      certifications: 'Certifications',
      skills: 'Technical Skills',
    },
  };
}

/**
 * Generate CV HTML from profile + JD.
 * Returns the HTML string.
 */
export function generateCVHtml(profile, jdText) {
  const payload = buildCVPayload(profile, jdText);
  const templatePath = resolve(__dirname, '..', 'templates', 'cv-template.html');
  const template = readFileSync(templatePath, 'utf-8');

  // Import build-cv-html's renderHtml function
  // We inline the rendering to avoid ESM import issues in Lambda
  return renderCVHtml(template, payload);
}

/**
 * Render CV HTML by merging payload into template.
 * Simplified version of build-cv-html.mjs's renderHtml.
 */
function renderCVHtml(template, payload) {
  function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const c = payload.candidate || {};

  // Build contact row
  const contactItems = [];
  if (c.phone) contactItems.push(`<a href="tel:${escapeHtml(String(c.phone).replace(/\s+/g, ''))}">${escapeHtml(c.phone)}</a>`);
  if (c.email) contactItems.push(`<a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>`);
  if (c.linkedin && c.linkedin.url) contactItems.push(`<a href="${escapeHtml(c.linkedin.url)}">${escapeHtml(c.linkedin.display || c.linkedin.url)}</a>`);
  if (c.portfolio && c.portfolio.url) contactItems.push(`<a href="${escapeHtml(c.portfolio.url)}">${escapeHtml(c.portfolio.display || c.portfolio.url)}</a>`);
  if (c.location) contactItems.push(`<span>${escapeHtml(c.location)}</span>`);

  const sep = '\n      <span class="separator">|</span>\n      ';
  const contactRow = `<div class="contact-row">\n      ${contactItems.join(sep)}\n    </div>`;

  // Build sections
  const competencies = (payload.competencies || [])
    .map(tag => `<span class="competency-tag">${escapeHtml(String(tag))}</span>`)
    .join('\n      ');

  const experience = (payload.experience || []).map(e => {
    const bullets = (e.bullets || []).map(b => `        <li>${escapeHtml(b)}</li>`).join('\n');
    const location = e.location ? `\n    <div class="job-location">${escapeHtml(e.location)}</div>` : '';
    return `<div class="job">
    <div class="job-header">
      <span class="job-company">${escapeHtml(e.company)}</span>
      <span class="job-period">${escapeHtml(e.dates || e.period || '')}</span>
    </div>
    <div class="job-role">${escapeHtml(e.role)}</div>${location}
    <ul>
${bullets}
    </ul>
  </div>`;
  }).join('\n  ');

  const education = (payload.education || []).map(e => {
    const org = e.org ? ` <span class="edu-org">${escapeHtml(e.org)}</span>` : '';
    return `<div class="edu-item">
    <div class="edu-header">
      <div class="edu-title">${escapeHtml(e.title)}${org}</div>
      <div class="edu-year">${escapeHtml(e.year || '')}</div>
    </div>
  </div>`;
  }).join('\n  ');

  const certifications = (payload.certifications || []).map(e => {
    const org = e.org ? `<span class="cert-org">${escapeHtml(e.org)}</span>` : '<span class="cert-org"></span>';
    const year = e.year ? `<span class="cert-year">${escapeHtml(e.year)}</span>` : '<span class="cert-year"></span>';
    return `<div class="cert-item">
      <span class="cert-title">${escapeHtml(e.title)}</span>
      ${org}
      ${year}
    </div>`;
  }).join('\n    ');

  const skills = (payload.skills || []).map(c => {
    const cat = c.category ? `<span class="skill-category">${escapeHtml(c.category)}:</span> ` : '';
    const items = Array.isArray(c.items) ? c.items.join(', ') : c.items;
    return `    <div class="skill-item">${cat}${escapeHtml(items)}</div>`;
  }).join('\n');

  const skillsHtml = skills ? `<div class="skills-grid">\n${skills}\n  </div>` : '';

  // Build section titles
  const st = payload.sections || {};

  // Substitutions
  const subs = {
    LANG: escapeHtml(payload.lang || 'en'),
    PAGE_WIDTH: '8.5in',
    NAME: escapeHtml(c.name || ''),
    SECTION_SUMMARY: escapeHtml(st.summary || 'Professional Summary'),
    SUMMARY_TEXT: escapeHtml(payload.summary || ''),
    SECTION_COMPETENCIES: escapeHtml(st.competencies || 'Core Competencies'),
    COMPETENCIES: competencies,
    SECTION_EXPERIENCE: escapeHtml(st.experience || 'Work Experience'),
    EXPERIENCE: experience,
    SECTION_PROJECTS: escapeHtml(st.projects || 'Projects'),
    PROJECTS: '',
    SECTION_EDUCATION: escapeHtml(st.education || 'Education'),
    EDUCATION: education,
    SECTION_CERTIFICATIONS: escapeHtml(st.certifications || 'Certifications'),
    CERTIFICATIONS: certifications,
    SECTION_SKILLS: escapeHtml(st.skills || 'Technical Skills'),
    SKILLS: skillsHtml,
  };

  // Replace contact row
  let html = template.replace(/<div class="contact-row">[\s\S]*?<\/div>/, () => contactRow);
  html = html.replace(/\{\{PHOTO\}\}/g, '');

  // Replace all placeholders
  for (const [key, value] of Object.entries(subs)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value);
  }

  return html;
}

/**
 * Generate CV PDF from profile + JD.
 * Returns { htmlPath, pdfPath, success }.
 */
export async function generateCV(profile, jdText, outputDir) {
  const slug = (profile?.fullName || profile?.full_name || 'candidate')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  const date = new Date().toISOString().split('T')[0];

  const htmlPath = join(outputDir || '/tmp', `cv-${slug}-${date}.html`);
  const pdfPath = join(outputDir || '/tmp', `cv-${slug}-${date}.pdf`);

  try {
    const html = generateCVHtml(profile, jdText);
    writeFileSync(htmlPath, html, 'utf-8');

    // Convert to PDF via Playwright
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.pdf({
      path: pdfPath,
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.3in', bottom: '0.3in', left: '0.5in', right: '0.5in' },
    });
    await browser.close();

    return { htmlPath, pdfPath, success: true };
  } catch (e) {
    console.error(`[cv-generator] Failed: ${e.message}`);
    return { htmlPath: null, pdfPath: null, success: false, error: e.message };
  }
}
