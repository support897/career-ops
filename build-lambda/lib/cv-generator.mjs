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

// ─── Dynamic cv.md parser ──────────────────────────────────────────────────

function parseCvMd(text) {
  const summaryMatch = text.match(/## Professional Summary\n+([\s\S]*?)(?=\n## )/);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';

  const experience = [];
  const expSection = text.match(/## Professional Experience\n([\s\S]*?)(?=\n## |$)/);
  if (expSection) {
    const jobs = expSection[1].split(/\n### /);
    for (let entry of jobs) {
      entry = entry.replace(/^### /, '').trim();
      if (!entry) continue;
      const lines = entry.split('\n').filter(line => line.trim().length > 0);
      const expRole = lines[0]?.trim() || '';
      const dates = lines[1]?.trim() || '';
      const companyLine = (lines[2] || '').trim();
      const [expCompanyRaw, location] = companyLine.split('|').map(s => s?.trim() || '');
      const expCompany = (expCompanyRaw || '').replace(/\*\*/g, '').trim();
      
      const bullets = lines.slice(3)
        .filter(l => l.trim().startsWith('-'))
        .map(l => l.replace(/^[-•]\s*/, '').trim());
        
      if (expCompany) {
        const textForKw = `${expRole} ${expCompany} ${bullets.join(' ')}`.toLowerCase();
        const keywords = SKILL_KEYWORDS.filter(kw => textForKw.includes(kw));
        experience.push({
          company: expCompany,
          role: expRole,
          dates,
          location: location || '',
          bullets,
          keywords
        });
      }
    }
  }

  const skills = [];
  const skillsSection = text.match(/## (?:Technical )?Skills?\n([\s\S]*?)(?=\n## |$)/i);
  if (skillsSection) {
    for (const line of skillsSection[1].split('\n').filter(l => l.trim().startsWith('-'))) {
      const ci = line.indexOf(':');
      if (ci > 0) {
        skills.push({
          category: line.slice(1, ci).trim(),
          items: line.slice(ci + 1).trim()
        });
      }
    }
  }

  const education = [];
  const eduSection = text.match(/## Education\n([\s\S]*?)(?=\n## |$)/i);
  if (eduSection) {
    for (const line of eduSection[1].split('\n').filter(l => l.trim().startsWith('-'))) {
      const parts = line.replace(/^-\s*/, '').split('|');
      education.push({
        title: parts[0]?.trim() || '',
        org: parts[1]?.trim() || '',
        year: parts[2]?.trim() || ''
      });
    }
  }

  const certifications = [];
  const certsSection = text.match(/## Certifications\n([\s\S]*?)(?=\n## |$)/i);
  if (certsSection) {
    for (const line of certsSection[1].split('\n').filter(l => l.trim().startsWith('-'))) {
      const parts = line.replace(/^-\s*/, '').split('|');
      if (parts.length >= 3) {
        certifications.push({
          title: parts[0]?.trim() || '',
          org: parts[1]?.trim() || '',
          year: parts[2]?.trim() || ''
        });
      } else {
        const textVal = parts[0]?.trim() || '';
        const match = textVal.match(/^([^-]+),\s*([^(]+)\s*\((\d+)\)$/);
        if (match) {
          certifications.push({
            title: match[1].trim(),
            org: match[2].trim(),
            year: match[3].trim()
          });
        } else {
          certifications.push({
            title: textVal,
            org: '',
            year: ''
          });
        }
      }
    }
  }

  return { summary, experience, skills, education, certifications };
}

function loadCVData() {
  const paths = [
    join(__dirname, '..', 'cv.md'),
    join(__dirname, 'cv.md'),
    join(process.cwd(), 'cv.md')
  ];
  let content = '';
  for (const p of paths) {
    if (existsSync(p)) {
      content = readFileSync(p, 'utf-8');
      break;
    }
  }
  if (!content) {
    return {
      summary: '',
      experience: [],
      skills: [],
      education: [],
      certifications: []
    };
  }
  return parseCvMd(content);
}

function extractCompetenciesFromSkills(skills) {
  const list = [];
  for (const s of skills) {
    const items = typeof s.items === 'string' ? s.items.split(/[|]/) : [];
    for (const item of items) {
      const clean = item.trim();
      if (clean && clean.length > 1) list.push(clean);
    }
  }
  if (list.length === 0) {
    return [
      'AI Automation', 'Marketing Operations', 'GTM Systems', 'Workflow Orchestration',
      'Lead Generation', 'TypeScript', 'Node.js', 'Python', 'APIs & Webhooks',
      'n8n', 'Claude API', 'Gemini API', 'Multi-Agent Systems', 'B2B Outreach',
      'Content Production', 'Voice AI', 'Facebook Automation', 'Cold Email Systems'
    ];
  }
  return [...new Set(list)];
}

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
function selectExperience(jdKeywords, experienceList) {
  // Score each experience entry by keyword overlap
  const scored = experienceList.map(exp => {
    const overlap = (exp.keywords || []).filter(kw =>
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
function selectCompetencies(jdKeywords, competencyList) {
  // Score each competency by keyword overlap
  const scored = competencyList.map(comp => {
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
  const cvData = loadCVData();
  const jdKeywords = extractJDKeywords(jdText);
  const summary = buildTailoredSummary(jdKeywords);
  const experience = selectExperience(jdKeywords, cvData.experience);
  const rawCompetencies = extractCompetenciesFromSkills(cvData.skills);
  const competencies = selectCompetencies(jdKeywords, rawCompetencies);

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
    education: cvData.education,
    certifications: cvData.certifications,
    skills: cvData.skills,
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
