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
// Gemini is the primary scorer. Ollama needs a local model server, which does
// not fit on this VPS, so on the server the Ollama path is never available and
// scoring silently degraded to keyword matching.
const GEMINI_MODEL = process.env.GEMINI_SCORING_MODEL || 'gemini-2.5-flash';
const GEMINI_KEY = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

let _ollamaAvailable = null;

/**
 * Send a prompt to Gemini and return the raw text, or null if unavailable.
 *
 * Uses the REST endpoint directly rather than the SDK: this module is imported
 * by CLI scripts that must not hard-depend on @google/generative-ai being
 * installed, and the response shape used here is stable.
 */
// Serialise and pace Gemini calls. Firing one request per job as fast as the
// loop allowed produced `fetch failed` (an undici connection error, not an HTTP
// status) on 174 of 190 jobs in one cycle. Each failure fell through to keyword
// scoring, which cannot reach the 4.0 document threshold — so the run looked
// like it had scored everything while almost nothing could ever qualify.
const GEMINI_MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS) || 1200;
const GEMINI_MAX_ATTEMPTS = Number(process.env.GEMINI_MAX_ATTEMPTS) || 3;
let _geminiChain = Promise.resolve();
let _lastGeminiAt = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Run fn serially across all callers, spaced by GEMINI_MIN_INTERVAL_MS. */
function geminiQueue(fn) {
  const run = _geminiChain.then(async () => {
    const wait = GEMINI_MIN_INTERVAL_MS - (Date.now() - _lastGeminiAt);
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      _lastGeminiAt = Date.now();
    }
  });
  // Keep the chain alive regardless of this call's outcome, so one failure does
  // not permanently reject the queue for every later job.
  _geminiChain = run.then(() => {}, () => {});
  return run;
}

// OpenAI-compatible chat completion — Groq and OpenRouter both speak this.
async function openaiCompatCall(baseUrl, key, model, prompt, extraHeaders = {}, maxTokens = 1024) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: maxTokens,
  };
  // gpt-oss models reason before answering, and that reasoning is billed against
  // max_tokens. On a long prompt (a full CV plus a job description) the budget
  // was spent thinking and `message.content` came back empty, which read as
  // "provider returned nothing" and pushed document generation onto the
  // template for no good reason. Ask for less reasoning instead.
  if (/gpt-oss|reason/i.test(model)) body.reasoning_effort = 'low';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${body.slice(0, 160)}`);
  }
  const data = await res.json();
  const choice = data?.choices?.[0];
  const text = choice?.message?.content || '';
  if (!text) {
    const why = choice?.finish_reason === 'length'
      ? 'empty completion (hit max_tokens while reasoning)'
      : `empty completion (finish_reason=${choice?.finish_reason || 'unknown'})`;
    throw new Error(why);
  }
  return text;
}

// Ordered fallback chain. Gemini first by preference; the rest exist so a single
// exhausted free tier cannot silently disable document generation.
const LLM_PROVIDERS = [
  {
    name: 'gemini',
    label: () => `Gemini (${GEMINI_MODEL})`,
    key: () => GEMINI_KEY(),
    call: (key, prompt, maxTokens) => geminiCall(key, prompt, maxTokens),
  },
  {
    name: 'groq',
    label: () => `Groq (${process.env.GROQ_MODEL || 'openai/gpt-oss-20b'})`,
    key: () => process.env.GROQ_API_KEY || '',
    call: (key, prompt, maxTokens) => openaiCompatCall(
      'https://api.groq.com/openai/v1', key,
      process.env.GROQ_MODEL || 'openai/gpt-oss-20b', prompt, {}, maxTokens),
  },
  {
    name: 'openrouter',
    label: () => `OpenRouter (${process.env.OPENROUTER_MODEL || 'qwen/qwen3.7-flash'})`,
    key: () => process.env.OPENROUTER_API_KEY || '',
    call: (key, prompt, maxTokens) => openaiCompatCall(
      'https://openrouter.ai/api/v1', key,
      process.env.OPENROUTER_MODEL || 'qwen/qwen3.7-flash', prompt,
      { 'HTTP-Referer': 'https://career-ops-2.vercel.app', 'X-Title': 'career-ops' }, maxTokens),
  },
];

const usableProviders = () => LLM_PROVIDERS.filter(p => {
  const k = p.key();
  return k && !k.startsWith('your_') && !k.includes('REPLACE');
});

// Providers that returned a quota/rate error this process. Retrying them for
// every remaining job wastes a request and a backoff sleep each time.
const _exhausted = new Set();

/**
 * Label of the provider that served the most recent successful completion.
 *
 * llmBackendName() describes the whole configured chain, which is right for a
 * startup log and wrong for an audit column: generation_method ended up holding
 * the entire multi-line chain description for every row instead of naming the
 * one model that wrote the document.
 */
let _lastProvider = null;
export function lastLlmProvider() {
  return _lastProvider;
}

/**
 * Ask each usable provider in turn for a completion.
 * Returns null only when no provider has a key at all.
 */
/**
 * Exported so document generation reuses this exact chain — including the
 * shared `_exhausted` set and the Gemini pacing queue. A second, independent
 * copy of the provider logic would race this one through the same free-tier
 * quota and rediscover the 429 the hard way.
 */
export async function llmComplete(prompt, { maxTokens = 1024 } = {}) {
  const providers = usableProviders();
  if (!providers.length) return null;
  let lastErr = null;
  for (const provider of providers) {
    if (_exhausted.has(provider.name)) continue;
    // An empty body is a failure, not an answer. Returning '' let a provider
    // that answered with nothing end the chain, so a healthy next provider was
    // never asked and the caller fell back to a template for no reason.
    const attempt = async () => {
      const out = await geminiQueue(() => provider.call(provider.key(), prompt, maxTokens));
      if (!out || !String(out).trim()) throw new Error('empty completion from provider');
      _lastProvider = provider.label();
      return out;
    };
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || '');
      // Quota and auth failures will not fix themselves mid-run; stop asking.
      if (/\b429\b|quota|rate.?limit|\b401\b|\b403\b/i.test(msg)) {
        _exhausted.add(provider.name);
        console.error(`   ⚠️  ${provider.label()} unavailable (${msg.slice(0, 80)}) — falling back to the next provider.`);
        continue;
      }
      // Transient transport error: one retry on this provider, then move on.
      if (/fetch failed|timeout|ECONNRESET|EAI_AGAIN|empty completion|\b5\d\d\b/i.test(msg)) {
        try {
          await sleep(2000);
          return await attempt();
        } catch (err2) {
          lastErr = err2;
          continue;
        }
      }
      continue;
    }
  }
  throw lastErr || new Error('no provider produced a completion');
}

async function geminiComplete(prompt) {
  const key = GEMINI_KEY();
  if (!key) return null;
  let lastErr = null;
  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
    try {
      return await geminiQueue(() => geminiCall(key, prompt));
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || '');
      // Retry transient transport failures and rate limits; a bad key or a
      // malformed request will fail identically every time, so stop early.
      const transient = msg.includes('fetch failed') || msg.includes('timeout')
        || msg.includes('429') || msg.includes('500') || msg.includes('503')
        || msg.includes('ECONNRESET') || msg.includes('EAI_AGAIN');
      if (!transient || attempt === GEMINI_MAX_ATTEMPTS) throw err;
      // Exponential backoff: 2s, 4s.
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

async function geminiCall(key, prompt, maxTokens = 1024) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        // Low temperature: scoring must be repeatable, not creative.
        temperature: 0.1,
        // Gemini 2.5+ are thinking models: internal reasoning tokens are drawn
        // from the SAME budget as the reply. At 500 the model spent it all
        // thinking and the response came back truncated mid-line
        // (finishReason: MAX_TOKENS) — the SCORE line survived but DIMENSIONS
        // and REASONS were cut off, so every job synced with an empty
        // "why match". Disable thinking for this strictly-formatted task and
        // leave clear headroom for the four output lines.
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: maxTokens,
      },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 160)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text) throw new Error('Gemini returned no text');
  // A truncated reply can still contain a parseable SCORE line while losing the
  // reasons, which looks like a successful score with no explanation. Treat it
  // as a failure so it is visible rather than quietly degrading the output.
  if (data?.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
    throw new Error('Gemini response truncated (MAX_TOKENS) — raise maxOutputTokens');
  }
  return text;
}

/**
 * True when any real LLM backend can be reached, so callers stop gating LLM
 * scoring on Ollama specifically.
 */
export async function isLlmAvailable() {
  if (usableProviders().length) return true;
  return isOllamaAvailable();
}

/** Which backend isLlmAvailable() would use — for honest logging. */
export function llmBackendName() {
  const ps = usableProviders();
  if (ps.length) return ps.map(p => p.label()).join(' → ') + ' → keyword';
  return `Ollama (${OLLAMA_MODEL})`;
}

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
/**
 * Keyword score below which an LLM call is not worth a request.
 *
 * Scoring the whole backlog exhausted a day of free Gemini quota on jobs that
 * were never plausible (on-site overseas roles, wrong discipline). The keyword
 * scorer is a poor absolute judge but a decent cheap filter, so it screens
 * first and the LLM only sees jobs within reach of the 4.0 threshold.
 * Set LLM_SCORE_FLOOR=0 to score everything.
 */
const LLM_SCORE_FLOOR = process.env.LLM_SCORE_FLOOR !== undefined
  ? Number(process.env.LLM_SCORE_FLOOR)
  : 2.4;

export async function llmScoreJob(job, profile) {
  // Cheap pre-rank first: skip the LLM for jobs it would only confirm as poor.
  if (LLM_SCORE_FLOOR > 0) {
    const pre = scoreJob(job, profile);
    if (pre.score < LLM_SCORE_FLOOR) {
      return { ...pre, source: 'keyword', skippedLlm: true };
    }
  }

  const cv = loadCV();
  const jd = (job.description || '').slice(0, 2000);
  const targetRoles = (profile.targetRoles || []).join(', ') || 'AI automation, marketing automation, operations';
  const employmentType = (profile.employmentType || []).join(', ') || 'contract, part-time, casual';
  const jobType = (profile.jobType || []).join(', ') || 'remote';
  const salaryRange = profile.salaryMin && profile.salaryMax
    ? `$${profile.salaryMin}-${profile.salaryMax} AUD/hr`
    : '$50-100 AUD/hr';

  const prompt = `You are an expert job-matching evaluator. Score this job (1-5) against the candidate's profile.

CANDIDATE RESUME:
${cv}

TARGET ROLES: ${targetRoles}
EMPLOYMENT TYPE PREFERENCE: ${employmentType}
WORK TYPE PREFERENCE: ${jobType}
SALARY TARGET: ${salaryRange}

JOB TITLE: ${job.title || 'Unknown'}
COMPANY: ${job.company || 'Unknown'}
JOB DESCRIPTION:
${jd}

SALARY: ${job.salaryMin && job.salaryMax ? `$${job.salaryMin}-${job.salaryMax}` : 'Not specified'}
LOCATION: ${job.location || 'Not specified'}
EMPLOYMENT TYPE: ${job.employmentType || 'Not specified'}

EVALUATION DIMENSIONS:
1. CV Match (25%): Skills and experience alignment. How well does the candidate's background match the JD requirements?
2. North Star (20%): Role fit. How well does this role match the target archetypes (AI automation, marketing, operations, growth)?
3. Compensation (15%): Salary vs target range (${salaryRange}).
4. Culture/Location (15%): Remote policy, company culture signals, stability.
5. Employment Type (15%): Does the job's employment type (${job.employmentType || 'unknown'}) match the candidate's preference (${employmentType})?
6. Red Flags (10%): On-site requirements, seniority mismatches, visa sponsorship, too junior/senior.

SCORING RULES:
- 4.5+ = Strong match, recommend applying immediately
- 4.0-4.4 = Good match, worth applying
- 3.5-3.9 = Decent but not ideal
- Below 3.5 = Recommend against applying
- Remote only = max 2/5 for culture if on-site required
- Part-time/casual/contract preferred over full-time
- Employment type mismatch = max 3/5 for employment type dimension

OUTPUT FORMAT (respond ONLY with this exact format):
SCORE: <number 1-5, one decimal>
DIMENSIONS: CV=<1-5> NORTH=<1-5> COMP=<1-5> CULTURE=<1-5> EMP=<1-5> RED=<0-3 penalty>
REASONS: <comma-separated list of top 3-5 reasons>
VERDICT: <apply|skip>`;

  let lastErr = null;
  try {
    // Same prompt, same parser — only the backend differs. Gemini first
    // because it is the one that actually exists in production.
    let text = null;
    try {
      text = await llmComplete(prompt);
    } catch (gErr) {
      lastErr = gErr;
      text = null;
    }

    if (text === null) {
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
      text = data.response || '';
    }

    // Parse SCORE
    const scoreMatch = text.match(/SCORE:\s*([\d.]+)/i);
    const score = scoreMatch ? Math.max(1, Math.min(5, parseFloat(scoreMatch[1]))) : null;

    // Parse DIMENSIONS
    const dimMatch = text.match(/DIMENSIONS:\s*CV=(\d+(?:\.\d+)?)\s+NORTH=(\d+(?:\.\d+)?)\s+COMP=(\d+(?:\.\d+)?)\s+CULTURE=(\d+(?:\.\d+)?)\s+EMP=(\d+(?:\.\d+)?)\s+RED=(\d+(?:\.\d+)?)/i);
    const dims = dimMatch ? {
      cvMatch: parseFloat(dimMatch[1]),
      northStar: parseFloat(dimMatch[2]),
      compensation: parseFloat(dimMatch[3]),
      culture: parseFloat(dimMatch[4]),
      employmentType: parseFloat(dimMatch[5]),
      redFlags: -parseFloat(dimMatch[6]),
      global: score
    } : { global: score };

    // Parse REASONS.
    // The original single-line regex assumed the model puts the list on the
    // same line as the label. Gemini often emits a newline and/or a markdown
    // bullet list, which parsed as zero reasons and left "why match" empty on
    // the dashboard for every job. Capture everything up to VERDICT (or the end)
    // and accept commas, newlines or bullets as separators.
    const reasonsMatch = text.match(/REASONS:\s*([\s\S]*?)(?:\n\s*VERDICT:|$)/i);
    const reasons = reasonsMatch
      ? reasonsMatch[1]
          .split(/\s*(?:,|\n)\s*/)
          .map(r => r.replace(/^[-*•\d.)\s]+/, '').replace(/\*\*/g, '').trim())
          .filter(r => r.length > 2)
          .slice(0, 6)
      : [];

    if (score !== null) {
      return { score, matchReasons: reasons, dimensionScores: dims, source: 'llm' };
    }
  } catch (err) {
    lastErr = err;
  }

  // Keyword scoring caps far below the 4.0 document threshold, so falling back
  // here is not a neutral degradation — it silently disables document
  // generation for every job. Say so.
  if (lastErr) {
    console.error(`   ⚠️  LLM scoring unavailable (${String(lastErr.message).slice(0, 120)}) — keyword scoring cannot reach the 4.0 document threshold.`);
  }
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
  
  // Early return for jobs with insufficient data
  if (text.trim().length < 10) {
    return {
      score: 0,
      matchReasons: ['Insufficient job data to evaluate'],
      dimensionScores: { cvMatch: 0, northStar: 0, compensation: 0, culture: 0, employmentType: 0, redFlags: 0, global: 0 },
    };
  }
  
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
  const salaryMin = job.salaryMin ?? job.salary_min;
  const salaryMax = job.salaryMax ?? job.salary_max;
  const profileMin = profile.salaryMin || 50;
  const profileMax = profile.salaryMax || 100;

  if (salaryMin != null && salaryMax != null) {
    const overlap = Math.min(salaryMax, profileMax) - Math.max(salaryMin, profileMin);
    const range = Math.max(salaryMax, profileMax) - Math.min(salaryMin, profileMin);
    const overlapRatio = range > 0 ? overlap / range : (overlap >= 0 ? 1 : 0);

    if (overlapRatio >= 0.8) { dims.compensation = 5; reasons.push(`Salary: $${salaryMin}-${salaryMax} matches target`); }
    else if (overlapRatio >= 0.5) { dims.compensation = 4; reasons.push(`Salary: $${salaryMin}-${salaryMax} overlaps target`); }
    else if (overlapRatio >= 0.2) { dims.compensation = 3; }
    else if (overlapRatio >= 0) { dims.compensation = 2; }
    else { dims.compensation = 1; reasons.push(`Salary: $${salaryMin}-${salaryMax} below target`); }
  } else if (salaryMin != null || salaryMax != null) {
    // Only one bound available
    const sal = salaryMin ?? salaryMax;
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

  // ── Dimension D2: Employment Type alignment ───────────────────────
  const profileEmpTypes = (profile.employmentType || []).map(t => t.toLowerCase());
  const jobEmpType = (job.employmentType || '').toLowerCase();
  if (profileEmpTypes.length > 0 && jobEmpType) {
    const empMatch = profileEmpTypes.some(t => jobEmpType.includes(t));
    if (empMatch) {
      dims.employmentType = 5;
      if (reasons.length < 8) reasons.push(`Employment type: ${jobEmpType} matches preference`);
    } else if (jobEmpType.includes('full-time') && profileEmpTypes.some(t => t.includes('contract') || t.includes('part-time') || t.includes('casual'))) {
      dims.employmentType = 2;
      if (reasons.length < 8) reasons.push(`Employment type: full-time but you prefer ${profileEmpTypes.join('/')}`);
    } else {
      dims.employmentType = 3;
    }
  } else {
    dims.employmentType = 4; // Unknown, neutral-positive
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
  // Weighted average: CV Match (25%), North Star (20%), Comp (15%), Culture (15%), Employment Type (15%), Red Flags (10%)
  const weights = { cvMatch: 0.25, northStar: 0.20, compensation: 0.15, culture: 0.15, employmentType: 0.15, redFlags: 0.10 };
  const rawGlobal =
    dims.cvMatch * weights.cvMatch +
    dims.northStar * weights.northStar +
    dims.compensation * weights.compensation +
    dims.culture * weights.culture +
    dims.employmentType * weights.employmentType +
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
export function shouldAutoApply(score, autoApplyEnabled, profile, minScore = 4.0) {
  if (!autoApplyEnabled) {
    return { autoApply: false, reason: 'Auto-apply is disabled' };
  }
  if (score >= minScore) {
    return { autoApply: true, reason: `Score ${score} >= ${minScore} threshold` };
  }
  return { autoApply: false, reason: `Score ${score} < ${minScore} threshold` };
}


