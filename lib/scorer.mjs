/**
 * scorer.mjs — Job scoring with LLM + keyword fallback.
 *
 * When Ollama is running locally (localhost:11434), uses LLM-based
 * 6-dimension evaluation matching the original repo's A-G scoring.
 * Falls back to keyword matching when Ollama isn't available.
 *
 * Dimensions (LLM):
 *   A. CV Match — skills/experience alignment with JD
 *   B. North Star — fit with target roles and archetypes
 *   C. Compensation — salary vs profile expectations
 *   D. Culture/Location — remote policy, work model
 *   E. Red Flags — blockers, disqualifiers
 *   F. Global — weighted average
 *
 * Returns: { score: number, matchReasons: string[], dimensionScores: object, source: 'llm'|'keyword' }
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

let _ollamaAvailable = null;

/**
 * Check if Ollama is running and has a suitable model.
 */
export async function isOllamaAvailable() {
  if (_ollamaAvailable !== null) return _ollamaAvailable;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) { _ollamaAvailable = false; return false; }
    const data = await res.json();
    const models = (data.models || []).map(m => m.name);
    // Prefer llama3.1:8b, qwen2.5:7b, or any model >= 4GB
    _ollamaAvailable = models.some(m =>
      m.includes('llama3.1') || m.includes('qwen2.5') || m.includes('gemma2') || m.includes('mistral')
    );
    if (!_ollamaAvailable) {
      // Check for any model >= 4GB (likely capable enough)
      _ollamaAvailable = data.models?.some(m => (m.size || 0) >= 4e9) || false;
    }
    return _ollamaAvailable;
  } catch {
    _ollamaAvailable = false;
    return false;
  }
}

/**
 * Load CV content for LLM evaluation.
 */
function loadCV() {
  const root = join(__dirname, '..');
  const paths = [join(root, 'cv.md'), join(root, 'config', 'cv.md')];
  for (const p of paths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf8');
      return content.length > 3000 ? content.slice(0, 3000) + '\n\n[...truncated for evaluation...]' : content;
    }
  }
  return 'CV not available — evaluate based on profile target roles only.';
}

/**
 * LLM-based 6-dimension job scoring via Ollama.
 */
export async function llmScoreJob(job, profile) {
  const cv = loadCV();
  const jd = (job.description || '').slice(0, 2000);
  const targetRoles = (profile.targetRoles || []).join(', ') || 'AI automation, marketing automation, operations';
  const salaryRange = profile.salaryMin && profile.salaryMax
    ? `$${profile.salaryMin}-${profile.salaryMax} AUD/hr`
    : '$50-100 AUD/hr';

  const prompt = `You are an expert job-matching evaluator. Score this job (1-5) against the candidate's profile.

CANDIDATE RESUME:
${cv}

TARGET ROLES: ${targetRoles}
SALARY TARGET: ${salaryRange}
LOCATION: Remote only (Gold Coast, QLD Australia)

JOB TITLE: ${job.title || 'Unknown'}
COMPANY: ${job.company || 'Unknown'}
JOB DESCRIPTION:
${jd}

SALARY: ${job.salaryMin && job.salaryMax ? `$${job.salaryMin}-${job.salaryMax}` : 'Not specified'}
LOCATION: ${job.location || 'Not specified'}
REMOTE: ${job.remote || 'Unknown'}

EVALUATION DIMENSIONS:
1. CV Match (30%): Skills and experience alignment. How well does the candidate's background match the JD requirements?
2. North Star (25%): Role fit. How well does this role match the target archetypes (AI automation, marketing, operations, growth)?
3. Compensation (15%): Salary vs target range ($${salaryRange}).
4. Culture/Location (20%): Remote policy, company culture signals, stability.
5. Red Flags (10%): On-site requirements, seniority mismatches, visa sponsorship, too junior/senior.

SCORING RULES:
- 4.5+ = Strong match, recommend applying immediately
- 4.0-4.4 = Good match, worth applying
- 3.5-3.9 = Decent but not ideal
- Below 3.5 = Recommend against applying
- Remote only = max 2/5 for culture if on-site required
- Part-time/casual/contract preferred over full-time

OUTPUT FORMAT (respond ONLY with this exact format):
SCORE: <number 1-5, one decimal>
DIMENSIONS: CV=<1-5> NORTH=<1-5> COMP=<1-5> CULTURE=<1-5> RED=<0-3 penalty>
REASONS: <comma-separated list of top 3-5 reasons>
VERDICT: <apply|skip>`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 500 }
      }),
      signal: AbortSignal.timeout(120000)
    });

    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = await res.json();
    const text = data.response || '';

    // Parse SCORE
    const scoreMatch = text.match(/SCORE:\s*([\d.]+)/i);
    const score = scoreMatch ? Math.max(1, Math.min(5, parseFloat(scoreMatch[1]))) : null;

    // Parse DIMENSIONS
    const dimMatch = text.match(/DIMENSIONS:\s*CV=(\d+(?:\.\d+)?)\s+NORTH=(\d+(?:\.\d+)?)\s+COMP=(\d+(?:\.\d+)?)\s+CULTURE=(\d+(?:\.\d+)?)\s+RED=(\d+(?:\.\d+)?)/i);
    const dims = dimMatch ? {
      cvMatch: parseFloat(dimMatch[1]),
      northStar: parseFloat(dimMatch[2]),
      compensation: parseFloat(dimMatch[3]),
      culture: parseFloat(dimMatch[4]),
      redFlags: -parseFloat(dimMatch[5]),
      global: score
    } : { global: score };

    // Parse REASONS
    const reasonsMatch = text.match(/REASONS:\s*(.+)/i);
    const reasons = reasonsMatch
      ? reasonsMatch[1].split(/,\s*/).filter(r => r.trim()).slice(0, 6)
      : [];

    if (score !== null) {
      return { score, matchReasons: reasons, dimensionScores: dims, source: 'llm' };
    }
  } catch (err) {
    // Fall through to keyword scoring
  }

  // Fallback to keyword scoring
  return { ...scoreJob(job, profile), source: 'keyword' };
}

/**
 * Score a job against a user's profile.
 *
 * @param {object} job - { title, company, description, salary, salaryMin, salaryMax, location, employmentType }
 * @param {object} profile - { targetRoles[], employmentType[], salaryMin, salaryMax, jobType[] }
 * @returns {{ score: number, matchReasons: string[], dimensionScores: object }}
 */
export function scoreJob(job, profile) {
  const text = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  const title = (job.title || '').toLowerCase();
  const reasons = [];
  const dims = {};

  // ── Dimension A: CV Match (skills alignment) ──────────────────────
  const skillKeywords = [
    'ai', 'artificial intelligence', 'machine learning', 'ml', 'deep learning',
    'automation', 'automated', 'automate', 'workflow', 'pipeline',
    'nlp', 'natural language', 'chatbot', 'voice agent', 'agent',
    'python', 'javascript', 'node', 'nodejs', 'api', 'rest', 'graphql',
    'n8n', 'make', 'zapier', 'airtable', 'hubspot', 'salesforce',
    'marketing', 'digital marketing', 'seo', 'sem', 'content', 'social media',
    'lead generation', 'cold email', 'outreach', 'crm',
    'data', 'analytics', 'etl', 'sql', 'postgres', 'mongodb',
    'cloud', 'aws', 'gcp', 'azure', 'docker', 'kubernetes',
    'web', 'frontend', 'backend', 'fullstack', 'react', 'nextjs', 'vue',
    'growth', 'revops', 'revenue operations', 'gtm', 'go-to-market',
    'product', 'project management', 'agile', 'scrum',
    'operations', 'process', 'optimization', 'efficiency',
    'integrations', 'solutions', 'consulting', 'freelance',
  ];

  let skillMatches = 0;
  for (const kw of skillKeywords) {
    if (text.includes(kw)) {
      skillMatches++;
      if (reasons.length < 8) reasons.push(`Skills: ${kw}`);
    }
  }
  // Score: 0 matches = 1, 3+ = 2, 6+ = 3, 10+ = 4, 15+ = 5
  dims.cvMatch = skillMatches >= 15 ? 5 : skillMatches >= 10 ? 4 : skillMatches >= 6 ? 3 : skillMatches >= 3 ? 2 : 1;

  // ── Dimension B: North Star (target role fit) ─────────────────────
  const targetRoles = (profile.targetRoles || []).map(r => r.toLowerCase());
  let roleMatches = 0;
  for (const role of targetRoles) {
    if (title.includes(role.toLowerCase().split(' ')[0])) {
      roleMatches++;
      if (reasons.length < 8) reasons.push(`Target role match: ${role}`);
    }
  }
  // Also check for adjacent keywords
  const adjacentKeywords = ['automation', 'operations', 'growth', 'marketing', 'ai', 'engineer', 'manager', 'assistant', 'revops', 'gtm'];
  let adjacentMatches = 0;
  for (const kw of adjacentKeywords) {
    if (title.includes(kw)) adjacentMatches++;
  }

  dims.northStar = roleMatches >= 2 ? 5 : roleMatches >= 1 ? 4 : adjacentMatches >= 3 ? 3 : adjacentMatches >= 2 ? 2.5 : adjacentMatches >= 1 ? 2 : 1;

  // ── Dimension C: Compensation ─────────────────────────────────────
  const salaryMin = job.salaryMin || job.salary_min;
  const salaryMax = job.salaryMax || job.salary_max;
  const profileMin = profile.salaryMin || 50;
  const profileMax = profile.salaryMax || 100;

  if (salaryMin && salaryMax) {
    const overlap = Math.min(salaryMax, profileMax) - Math.max(salaryMin, profileMin);
    const range = Math.max(salaryMax, profileMax) - Math.min(salaryMin, profileMin);
    const overlapRatio = range > 0 ? overlap / range : 0;

    if (overlapRatio >= 0.8) { dims.compensation = 5; reasons.push(`Salary: $${salaryMin}-${salaryMax} matches target`); }
    else if (overlapRatio >= 0.5) { dims.compensation = 4; reasons.push(`Salary: $${salaryMin}-${salaryMax} overlaps target`); }
    else if (overlapRatio >= 0.2) { dims.compensation = 3; }
    else if (overlapRatio >= 0) { dims.compensation = 2; }
    else { dims.compensation = 1; reasons.push(`Salary: $${salaryMin}-${salaryMax} below target`); }
  } else if (salaryMin || salaryMax) {
    // Only one bound available
    const sal = salaryMin || salaryMax;
    if (sal >= profileMin) { dims.compensation = 4; reasons.push(`Salary: $${sal}+ meets target`); }
    else { dims.compensation = 2; }
  } else {
    dims.compensation = 3; // Unknown — neutral
  }

  // ── Dimension D: Culture/Location (remote policy) ─────────────────
  const profileRemote = (profile.jobType || []).includes('remote');
  const hasRemote = text.includes('remote') || text.includes('work from home') || text.includes('anywhere');
  const hasOnsite = text.includes('on-site') || text.includes('onsite') || text.includes('in-office');
  const hasHybrid = text.includes('hybrid');

  if (profileRemote) {
    if (hasRemote && !hasOnsite) {
      dims.culture = 5;
      reasons.push('Location: Remote');
    } else if (hasRemote && hasHybrid) {
      dims.culture = 3;
    } else if (hasOnsite) {
      dims.culture = 1;
      reasons.push('Location: On-site (blocked)');
    } else {
      dims.culture = 3; // Unknown, assume flexible
    }
  } else {
    dims.culture = 4;
  }

  // ── Dimension E: Red Flags ────────────────────────────────────────
  const redFlags = [
    { keyword: 'on-site', penalty: -1, reason: 'On-site requirement' },
    { keyword: 'hybrid', penalty: -0.5, reason: 'Hybrid (not fully remote)' },
    { keyword: 'director', penalty: -0.5, reason: 'Senior leadership level' },
    { keyword: 'vp ', penalty: -1, reason: 'VP level (too senior)' },
    { keyword: 'c-level', penalty: -1, reason: 'C-level (too senior)' },
    { keyword: 'intern', penalty: -2, reason: 'Internship' },
    { keyword: 'junior', penalty: -1, reason: 'Junior level' },
    { keyword: 'entry level', penalty: -1.5, reason: 'Entry level' },
    { keyword: '3+ years', penalty: 0, reason: '' }, // Not a flag
    { keyword: '5+ years', penalty: 0, reason: '' },
    { keyword: '10+ years', penalty: -0.5, reason: 'High experience requirement' },
    { keyword: 'requires sponsorship', penalty: -2, reason: 'Requires visa sponsorship' },
    { keyword: 'security clearance', penalty: -1, reason: 'Security clearance required' },
  ];

  let redFlagPenalty = 0;
  for (const flag of redFlags) {
    if (text.includes(flag.keyword)) {
      redFlagPenalty += flag.penalty;
      if (flag.reason && reasons.length < 10) reasons.push(flag.reason);
    }
  }
  // Score: -3 to 0 (0 = no flags, -3 = many flags)
  dims.redFlags = Math.max(-3, Math.min(0, redFlagPenalty));

  // ── Dimension F: Global Score ─────────────────────────────────────
  // Weighted average: CV Match (30%), North Star (25%), Comp (15%), Culture (20%), Red Flags (10%)
  const weights = { cvMatch: 0.30, northStar: 0.25, compensation: 0.15, culture: 0.20, redFlags: 0.10 };
  const rawGlobal =
    dims.cvMatch * weights.cvMatch +
    dims.northStar * weights.northStar +
    dims.compensation * weights.compensation +
    dims.culture * weights.culture +
    (dims.redFlags + 3) * weights.redFlags; // Normalize redFlags to 0-3 scale

  dims.global = Math.round(rawGlobal * 10) / 10;

  // Cap at 1-5
  dims.global = Math.max(1, Math.min(5, dims.global));

  // Clean up reasons — remove empty, limit to top 6
  const cleanReasons = reasons.filter(r => r && r.length > 0).slice(0, 6);

  return {
    score: dims.global,
    matchReasons: cleanReasons,
    dimensionScores: dims,
  };
}

/**
 * Determine if a job should be auto-applied based on score and profile settings.
 *
 * @param {number} score - Job score (1-5)
 * @param {boolean} autoApplyEnabled - User's auto-apply toggle
 * @param {object} profile - User profile (for threshold override)
 * @param {number} [minScore=4] - Per-user minimum score threshold (1-5)
 * @returns {{ autoApply: boolean, reason: string }}
 */
export function shouldAutoApply(score, autoApplyEnabled, profile, minScore = 4) {
  if (!autoApplyEnabled) {
    return { autoApply: false, reason: 'Auto-apply is disabled' };
  }
  if (score >= minScore) {
    return { autoApply: true, reason: `Score ${score} >= ${minScore} threshold` };
  }
  return { autoApply: false, reason: `Score ${score} < ${minScore} threshold` };
}
