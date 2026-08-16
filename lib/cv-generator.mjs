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
  // Support & Care keywords
  'support worker', 'support coordinator', 'ndis', 'autism', 'adhd',
  'aged care', 'childcare', 'disability', 'wheelchair', 'case management',
  'care', 'coordinator', 'mental health', 'complex care', 'first aid', 'cpr'
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
        .filter(l => l.trim().match(/^[-•*]/))
        .map(l => l.replace(/^[-•*]\s*/, '').trim());
        
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
    for (const line of skillsSection[1].split('\n').filter(l => l.trim().match(/^[-•*]/))) {
      const ci = line.indexOf(':');
      if (ci > 0) {
        skills.push({
          category: line.slice(1, ci).trim(),
          items: line.slice(ci + 1).trim()
        });
      } else {
        skills.push({
          category: '',
          items: line.replace(/^[-•*]\s*/, '').trim()
        });
      }
    }
  }

  const education = [];
  const eduSection = text.match(/## Education\n([\s\S]*?)(?=\n## |$)/i);
  if (eduSection) {
    for (const line of eduSection[1].split('\n').filter(l => l.trim().match(/^[-•*]/))) {
      const parts = line.replace(/^[-•*]\s*/, '').split('|');
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
    for (const line of certsSection[1].split('\n').filter(l => l.trim().match(/^[-•*]/))) {
      const parts = line.replace(/^[-•*]\s*/, '').split('|');
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

  const projects = [];
  let projectsTitle = 'Projects';
  const projSection = text.match(/## (Projects|Volunteer Work|Volunteer Experience)\n([\s\S]*?)(?=\n## |$)/i);
  if (projSection) {
    projectsTitle = projSection[1];
    const projEntries = projSection[2].split(/\n### /);
    for (let entry of projEntries) {
      entry = entry.replace(/^### /, '').trim();
      if (!entry) continue;
      const lines = entry.split('\n').filter(line => line.trim().length > 0);
      const name = lines[0]?.trim() || '';
      const bullets = lines.slice(1)
        .filter(l => l.trim().match(/^[-•*]/))
        .map(l => l.replace(/^[-•*]\s*/, '').trim());
      if (name) {
        projects.push({ name, bullets });
      }
    }
  }

  return { summary, experience, projects, projectsTitle, skills, education, certifications };
}

function loadCVData(cvMdPath) {
  const paths = cvMdPath ? [cvMdPath] : [
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
  const words = text.match(/[a-z0-9+#.-]{3,}/g) || [];
  const found = new Set();
  
  // Match skill taxonomy
  for (const kw of SKILL_KEYWORDS) {
    if (text.includes(kw)) found.add(kw);
  }
  
  // Extract high-frequency technical/domain terms from JD
  const stopWords = new Set(['and', 'the', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'your', 'our', 'are', 'work', 'team', 'experience']);
  const freq = {};
  for (const w of words) {
    if (!stopWords.has(w) && w.length > 3) {
      freq[w] = (freq[w] || 0) + 1;
    }
  }
  
  const topWords = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, 10);
  topWords.forEach(w => found.add(w));

  return Array.from(found);
}

/**
 * Build a tailored summary mentioning JD-relevant keywords.
 */
function buildTailoredSummary(jdKeywords) {
  const base = 'AI Automation Specialist, Marketing Engineer, and multi-venture founder with over 6 years of experience designing, coding, and deploying end-to-end automation systems across lead generation, content production, SaaS development, and sales operations. Founded and scaled three fully automated businesses without additional headcount.';

  const relevantKeywords = (jdKeywords || []).slice(0, 5);
  if (relevantKeywords.length === 0) return base;

  const kwFormatted = relevantKeywords.map(k => k.charAt(0).toUpperCase() + k.slice(1)).join(', ');
  return `AI Automation Specialist, Marketing Engineer, and multi-venture founder with over 6 years of experience designing, coding, and deploying end-to-end automation systems with strong expertise in ${kwFormatted}. Founded and scaled three fully automated businesses without additional headcount, delivering scalable architectures, workflow orchestration, and measurable ROI.`;
}

/**
 * Adapt Job Title dynamically based on JD archetype keywords.
 */
function adaptJobRole(baseRole, company, jdKeywords) {
  const kws = jdKeywords.join(' ').toLowerCase();
  
  if (company === 'APEX Website Solutions') {
    if (kws.includes('qa') || kws.includes('test') || kws.includes('quality')) return 'Founder & Automation QA Specialist';
    if (kws.includes('growth') || kws.includes('revops') || kws.includes('sales')) return 'Founder & Growth Automation Engineer';
    if (kws.includes('ai') || kws.includes('agent') || kws.includes('voice')) return 'Founder & AI Systems Specialist';
    if (kws.includes('marketing') || kws.includes('seo') || kws.includes('social')) return 'Founder & Marketing Automation Specialist';
    return 'Founder & Operations Automation Lead';
  }
  
  if (company === 'Evolve Marketing') {
    if (kws.includes('ai') || kws.includes('llm') || kws.includes('prompt')) return 'AI Integration & Digital Marketing Specialist';
    if (kws.includes('growth') || kws.includes('cro') || kws.includes('lead')) return 'Growth Marketing & Web Specialist';
    if (kws.includes('seo') || kws.includes('content') || kws.includes('brand')) return 'SEO & Digital Marketing Specialist';
    if (kws.includes('automation') || kws.includes('n8n') || kws.includes('workflow')) return 'Marketing Automation & Web Specialist';
    return 'AI Digital Marketing & Web Specialist';
  }
  
  if (company === 'eGlow') {
    if (kws.includes('growth') || kws.includes('funnel') || kws.includes('revenue')) return 'Growth & Brand Strategist';
    if (kws.includes('content') || kws.includes('video') || kws.includes('social') || kws.includes('tiktok')) return 'Digital Content & Brand Strategist';
    if (kws.includes('market') || kws.includes('campaign') || kws.includes('analytics')) return 'Digital Marketing & Brand Strategist';
    return 'Brand & Marketing Strategist';
  }
  
  return baseRole;
}

/**
 * Aggressively rewrites CV text (summaries, bullets) to use matching JD keywords
 * instead of generic synonyms, matching the job posting exactly.
 */
function aggressivelyInjectKeywords(text, jdKeywords) {
  if (!text) return "";
  let result = text;
  const targetKws = (jdKeywords || []).map(k => String(k).trim().toLowerCase());
  if (targetKws.length === 0) return result;

  const synonymMap = [
    { regex: /\b(?:QA|Quality Assurance|testing|tester)\b/gi, keyword: "QA Automation" },
    { regex: /\b(?:customer support|customer service|help desk|call center)\b/gi, keyword: "Customer Service" },
    { regex: /\b(?:BDR|SDR|sales development|business development|inside sales)\b/gi, keyword: "Business Development" },
    { regex: /\b(?:virtual assistant|VA|administrative assistant|executive assistant)\b/gi, keyword: "Virtual Assistant" },
    { regex: /\b(?:digital marketing|growth marketing|social media coordinator|marketing)\b/gi, keyword: "Digital Marketing" },
    { regex: /\b(?:lead generation|lead gen|lead sourcing)\b/gi, keyword: "Lead Generation" },
    { regex: /\b(?:data entry|claims processor|order processing|clerk)\b/gi, keyword: "Data Entry" },
    { regex: /\b(?:onboarding specialist|customer success|client success)\b/gi, keyword: "Customer Success" }
  ];

  for (const item of synonymMap) {
    const termFirstWord = item.keyword.split(" ")[0].toLowerCase();
    const matchesJd = targetKws.some(kw => kw.includes(termFirstWord));
    if (matchesJd) {
      result = result.replace(item.regex, item.keyword);
    }
  }

  return result;
}

/**
 * Select and order experience entries AND bullet points based on JD keywords overlap.
 */
function selectExperience(jdKeywords, experienceList) {
  const scored = experienceList.map(exp => {
    const expText = `${exp.role} ${exp.company} ${exp.bullets.join(' ')}`.toLowerCase();
    let score = 0;
    for (const kw of jdKeywords) {
      if (expText.includes(kw)) score += 2;
    }

    // Adapt job role title dynamically per JD archetype
    const tailoredRole = adaptJobRole(exp.role, exp.company, jdKeywords);

    // Aggressively inject keywords into bullet points and sort them
    const tailoredBullets = exp.bullets.map(b => aggressivelyInjectKeywords(b, jdKeywords)).sort((b1, b2) => {
      const b1Text = b1.toLowerCase();
      const b2Text = b2.toLowerCase();
      const m1 = jdKeywords.filter(k => b1Text.includes(k)).length;
      const m2 = jdKeywords.filter(k => b2Text.includes(k)).length;
      return m2 - m1;
    });

    return { ...exp, role: tailoredRole, bullets: tailoredBullets, relevance: score };
  });

  scored.sort((a, b) => b.relevance - a.relevance);
  return scored;
}

/**
 * Adapt Project Title dynamically based on JD archetype keywords.
 */
function adaptProjectName(baseName, jdKeywords) {
  const kws = jdKeywords.join(' ').toLowerCase();
  
  if (baseName.includes('Unimark')) {
    if (kws.includes('qa') || kws.includes('test')) return 'Unimark — AI Outreach & QA Automation SaaS Platform';
    if (kws.includes('growth') || kws.includes('revops') || kws.includes('crm')) return 'Unimark — Growth & Marketing Automation SaaS Platform';
    if (kws.includes('ai') || kws.includes('voice') || kws.includes('telnyx')) return 'Unimark — AI Agent & Voice Automation SaaS Platform';
    return 'Unimark — AI Marketing SaaS for Small Business Owners';
  }
  
  if (baseName.includes('APEX')) {
    if (kws.includes('qa') || kws.includes('test') || kws.includes('audit')) return 'APEX Website Solutions — Automated Website Audit & QA Engine';
    if (kws.includes('voice') || kws.includes('vapi')) return 'APEX Website Solutions — AI Voice Calling & Lead Gen Engine';
    if (kws.includes('growth') || kws.includes('b2b') || kws.includes('lead')) return 'APEX Website Solutions — B2B Lead Gen & Website Regeneration Engine';
    return 'APEX Website Solutions — B2B Automation & Website Regeneration Engine';
  }
  
  if (baseName.includes('Lumi and Milo')) {
    if (kws.includes('qa') || kws.includes('qc') || kws.includes('quality')) return 'Lumi and Milo — Autonomous AI Video Production & QC Pipeline';
    if (kws.includes('python') || kws.includes('gemini') || kws.includes('api')) return 'Lumi and Milo — Python & Gemini API Video Production Engine';
    return 'Lumi and Milo — Autonomous YouTube AI Video Production Pipeline';
  }
  
  return baseName;
}

/**
 * Select and order Projects entries AND bullet points based on JD keywords overlap.
 */
function selectProjects(jdKeywords, projectsList) {
  const scored = projectsList.map(proj => {
    const projText = `${proj.name} ${proj.bullets.join(' ')}`.toLowerCase();
    let score = 0;
    for (const kw of jdKeywords) {
      if (projText.includes(kw)) score += 2;
    }

    const tailoredName = adaptProjectName(proj.name, jdKeywords);

    // Reorder bullets per project so JD-matched accomplishments appear first
    const tailoredBullets = [...proj.bullets].sort((b1, b2) => {
      const b1Text = b1.toLowerCase();
      const b2Text = b2.toLowerCase();
      const m1 = jdKeywords.filter(k => b1Text.includes(k)).length;
      const m2 = jdKeywords.filter(k => b2Text.includes(k)).length;
      return m2 - m1;
    });

    return { ...proj, name: tailoredName, bullets: tailoredBullets, relevance: score };
  });

  scored.sort((a, b) => b.relevance - a.relevance);
  return scored;
}

/**
 * Select the most relevant competencies based on JD keywords.
 */
function selectCompetencies(jdKeywords, competencyList) {
  const scored = competencyList.map(comp => {
    const compLower = comp.toLowerCase();
    let score = 0;
    for (const kw of jdKeywords) {
      if (compLower.includes(kw)) score += 3;
    }
    return { comp, relevance: score };
  });

  scored.sort((a, b) => b.relevance - a.relevance);
  return scored.slice(0, 12).map(s => s.comp);
}

/**
 * Build the CV JSON payload for build-cv-html.mjs.
 */
export function buildCVPayload(profile, jdText, cvMdPath = null) {
  const cvData = loadCVData(cvMdPath);
  const jdKeywords = extractJDKeywords(jdText);
  const summary = aggressivelyInjectKeywords(buildTailoredSummary(jdKeywords), jdKeywords);
  const experience = selectExperience(jdKeywords, cvData.experience);
  const projects = selectProjects(jdKeywords, cvData.projects);
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
    projects: (projects || []).map(p => ({
      name: p.name,
      bullets: (p.bullets || []).map(b => aggressivelyInjectKeywords(b, jdKeywords)),
    })),
    education: cvData.education,
    certifications: cvData.certifications,
    skills: cvData.skills,
    sections: {
      summary: 'Professional Summary',
      competencies: 'Core Competencies',
      experience: 'Work Experience',
      projects: cvData.projectsTitle || 'Projects',
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

/**
 * Generate CV HTML asynchronously (only native keyword mode now).
 */
export async function generateCVHtmlAsync(profile, jdText, cvMdPath = null) {
  let payload = buildCVPayload(profile, jdText, cvMdPath);

  const { resolve } = await import('path');
  const templatePath = resolve(__dirname, '..', 'templates', 'cv-template.html');
  const template = readFileSync(templatePath, 'utf-8');

  let html = renderCVHtml(template, payload);
  let accentColor = profile?.style?.accent_color;
  
  if (!accentColor) {
    try {
      const profilePath = resolve(__dirname, '..', 'config', 'profile.yml');
      if (existsSync(profilePath)) {
        const yamlStr = readFileSync(profilePath, 'utf-8');
        const match = yamlStr.match(/accent_color:\s*["']?([^"'\r\n]+)["']?/);
        if (match && match[1]) {
          accentColor = match[1];
        }
      }
    } catch (e) {}
  }

  if (accentColor) {
    html = html.replace("</head>", `<style>:root { --accent-color: ${accentColor}; }</style></head>`);
  }
  return html;
}

export function generateCVHtml(profile, jdText, cvMdPath = null) {
  const payload = buildCVPayload(profile, jdText, cvMdPath);
  const templatePath = resolve(__dirname, '..', 'templates', 'cv-template.html');
  const template = readFileSync(templatePath, 'utf-8');

  let html = renderCVHtml(template, payload);
  let accentColor = null;
  try {
    const profilePath = resolve(__dirname, '..', 'config', 'profile.yml');
    if (existsSync(profilePath)) {
      const yamlStr = readFileSync(profilePath, 'utf-8');
      const match = yamlStr.match(/accent_color:\s*["']?([^"'\r\n]+)["']?/);
      if (match && match[1]) {
        accentColor = match[1];
      }
    }
  } catch (e) {}

  if (accentColor) {
    html = html.replace("</head>", `<style>:root { --accent-color: ${accentColor}; }</style></head>`);
  }
  return html;
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
    const location = e.location ? ` | ${escapeHtml(e.location)}` : '';
    return `<div class="job">
    <div class="job-header">
      <span class="job-role">${escapeHtml(e.role)}</span>
      <span class="job-period">${escapeHtml(e.dates || e.period || '')}</span>
    </div>
    <div class="job-company"><em>${escapeHtml(e.company)}${location}</em></div>
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

  const projectsHtml = (payload.projects || []).map(p => {
    const bullets = (p.bullets || []).map(b => `        <li>${escapeHtml(b)}</li>`).join('\n');
    return `<div class="job">
    <div class="job-header">
      <span class="project-title">${escapeHtml(p.name)}</span>
    </div>
    <ul>
${bullets}
    </ul>
  </div>`;
  }).join('\n  ');

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
    PROJECTS: projectsHtml,
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
let sharedBrowser = null;

export async function generateCV(profile, jdText, outputDir, jobSlug) {
  const nameSlug = (profile?.fullName || profile?.full_name || 'candidate')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20);
  const extraSlug = jobSlug ? `-${jobSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}` : '';
  const date = new Date().toISOString().split('T')[0];

  const htmlPath = join(outputDir || '/tmp', `cv-${nameSlug}${extraSlug}-${date}.html`);
  const pdfPath = join(outputDir || '/tmp', `cv-${nameSlug}${extraSlug}-${date}.pdf`);

  try {
    const html = await generateCVHtmlAsync(profile, jdText);
    writeFileSync(htmlPath, html, 'utf-8');

    const { chromium } = await import('playwright');
    if (!sharedBrowser) {
      sharedBrowser = await chromium.launch({ headless: true });
    }
    const page = await sharedBrowser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.pdf({
      path: pdfPath,
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.3in', bottom: '0.3in', left: '0.5in', right: '0.5in' },
    });
    await page.close();

    return { htmlPath, pdfPath, success: true };
  } catch (e) {
    console.error(`[cv-generator] Failed: ${e.message}`);
    return { htmlPath: null, pdfPath: null, success: false, error: e.message };
  }
}
