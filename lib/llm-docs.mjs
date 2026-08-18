/**
 * LLM-written document copy, with deterministic templates as the fallback.
 *
 * The dashboard has had "Use LLM for CV / Cover Letter / Reference Letter"
 * checkboxes since before this change, and `auto-apply.mjs` read them into
 * `useLlm` / `llmDocs` — then never used them. Every document was produced by
 * the keyword templates regardless, which is why cover letters repeated the
 * same three sentences with the company name swapped in.
 *
 * This module writes only the *prose*. Layout, the pink accent theme and the
 * PDF pipeline stay with the templates, so a model failure costs a tailored
 * paragraph, never a broken or unstyled document.
 *
 * Everything here throws on failure. Callers are expected to catch and fall
 * back to the template, and to say which path they took — a silently
 * substituted template is exactly the kind of failure that hid for months.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { llmComplete, llmBackendName } from './scorer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Her actual CV, which is the ONLY permitted source of claims about her.
 *
 * The first version of this module fed the model the job description and asked
 * it to write from "skills and themes present in the job description". It
 * dutifully produced a summary claiming she owns CI/CD pipelines, containerises
 * with Docker and works with Kubernetes — none of which came from her CV. That
 * is not tailoring, it is fabricating credentials in a document she sends to
 * employers. The job description now only selects which of her real experience
 * to foreground.
 */
let _cvTextCache;
function candidateCv() {
  if (_cvTextCache !== undefined) return _cvTextCache;
  _cvTextCache = '';
  for (const p of [join(__dirname, '..', 'cv.md'), join(process.cwd(), 'cv.md')]) {
    if (existsSync(p)) { _cvTextCache = readFileSync(p, 'utf8'); break; }
  }
  return _cvTextCache;
}

/** The CV is ~10KB; keep the evidence but leave room for the JD. */
const CV_LIMIT = 6000;

/** Keep prompts bounded; job descriptions run to tens of kilobytes. */
const JD_LIMIT = 4000;

function clean(text) {
  return String(text || '')
    // Models emit non-breaking hyphens, smart quotes and en/em dashes. They look
    // wrong in the PDF font and are a tell that a machine wrote the text.
    .replace(/[\u2010\u2011\u2012\u2013]/g, '-')
    .replace(/\u2014/g, ', ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ')
    // Strip the markdown a chat model reaches for even when told not to.
    .replace(/\*\*/g, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^#+\s*/gm, '')
    .trim();
}

/**
 * Pull LABEL: value blocks out of a completion.
 * Values may span lines, so each key runs until the next known key.
 */
function parseSections(raw, keys) {
  const out = {};
  for (const key of keys) {
    const others = keys.filter((k) => k !== key).join('|');
    const re = new RegExp(`${key}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${others})\\s*:|$)`, 'i');
    const m = raw.match(re);
    if (m) out[key.toLowerCase()] = clean(m[1]);
  }
  return out;
}

/** The shared, non-negotiable grounding rules. */
const GROUNDING = `GROUNDING RULES (absolute)
- The CANDIDATE CV below is the only source of truth about the candidate. Every skill, tool, employer, achievement and number you mention MUST appear in it.
- The job description tells you which of her REAL experience to emphasise. Never claim a requirement from the job description that the CV does not evidence. If the job asks for something she does not have, leave it out entirely rather than implying it.
- Do not restate the job description back as though it were her history.
- Invent no employers, dates, metrics, certifications, degrees or tools.`;

function candidateFacts(profile) {
  return [
    `Name: ${profile?.fullName || profile?.full_name || 'Ilse Placencia'}`,
    `Location: ${profile?.location?.city ? `${profile.location.city}, ${profile.location.country}` : profile?.location || 'Gold Coast, QLD, Australia'}`,
    `Portfolio: ${profile?.portfolioUrl || profile?.portfolio_url || 'https://www.ilseplacencia.shop'}`,
  ].join('\n');
}

/**
 * Write the three body paragraphs of a cover letter.
 *
 * Returns { opening, profile_intro, closing, method } where method names the
 * backend that produced it, for the generation_method column.
 * Throws if the model is unavailable or returns something unusable.
 */
export async function llmCoverLetterCopy(profile, job, jdText, matchReasons = []) {
  const company = job?.company || 'the company';
  const role = job?.role || job?.title || 'the role';
  const jd = String(jdText || '').slice(0, JD_LIMIT);

  const reasons = (matchReasons || []).filter(Boolean).slice(0, 6);

  const prompt = `Write the body of a job application cover letter in the candidate's own first-person voice.

CANDIDATE CV (the only source of claims about her)
${candidateCv().slice(0, CV_LIMIT) || candidateFacts(profile)}

CONTACT
${candidateFacts(profile)}

ROLE APPLIED FOR
${role} at ${company}

JOB DESCRIPTION (use only to choose which of her real experience to emphasise)
${jd || '(none provided)'}

WHY SHE WAS SCORED AS A MATCH
${reasons.length ? reasons.map((r) => `- ${r}`).join('\n') : '- (not supplied)'}

${GROUNDING}

STYLE RULES
- Name ${company} and the role, and refer to something concrete from the job description.
- Draw a specific line from her actual experience to what this job needs.
- Plain professional Australian English. Never open with "I am writing to" in any form. Banned: "I hope this finds you well", "passionate", "dynamic", "leverage", "synergy". Never use an em dash.
- Open with something specific about her experience or the role, not with an announcement that she is applying.
- No markdown, no bullets, no headings, no salutation, no sign-off. Body prose only.

Reply in EXACTLY this format, one paragraph per label, and write all three:

OPENING: <2 to 3 sentences: the role she is applying for and the strongest real reason to keep reading>
BODY: <3 to 5 sentences: her actual experience mapped to what this job asks for>
CLOSING: <2 sentences: what she would bring, and a plain request to talk>`;

  // A three-paragraph letter needs more room than a score, and reasoning
  // models spend part of this budget before writing anything.
  const raw = await llmComplete(prompt, { maxTokens: 2048 });
  if (!raw || !raw.trim()) throw new Error('empty completion');

  const parsed = parseSections(raw, ['OPENING', 'BODY', 'CLOSING']);

  // A partial letter is worse than a consistent template one.
  // A closing is legitimately shorter than the other two paragraphs, so holding
  // it to the same length rejected perfectly good letters.
  const minLen = { opening: 60, body: 120, closing: 25 };
  const missing = ['opening', 'body', 'closing'].filter(
    (k) => !parsed[k] || parsed[k].length < minLen[k]
  );
  if (missing.length) {
    throw new Error(
      `incomplete letter, missing/short: ${missing.join(', ')} | raw: ${raw.slice(0, 160).replace(/\s+/g, ' ')}`
    );
  }

  // Em dashes are a giveaway that a model wrote it.
  for (const k of ['opening', 'body', 'closing']) parsed[k] = parsed[k].replace(/\s*\u2014\s*/g, ', ');

  // Guard against the model leaking the label format into the text.
  for (const v of Object.values(parsed)) {
    if (/^(OPENING|BODY|CLOSING)\s*:/i.test(v)) throw new Error('malformed section');
  }

  return {
    opening: parsed.opening,
    profile_intro: parsed.body,
    closing: parsed.closing,
    method: `llm:${llmBackendName()}`,
  };
}

/**
 * Rewrite the CV professional summary so it speaks to one specific job.
 * Deliberately narrow: the rest of the CV stays deterministic, because
 * hallucinated employment history is unacceptable in a document she sends out.
 */
export async function llmCvSummary(profile, job, jdText) {
  const role = job?.role || job?.title || 'the role';
  const company = job?.company || 'the company';
  const jd = String(jdText || '').slice(0, JD_LIMIT);

  const prompt = `Rewrite the professional summary at the top of this candidate's CV so it speaks to one specific job.

CANDIDATE CV (the only source of claims about her)
${candidateCv().slice(0, CV_LIMIT) || candidateFacts(profile)}

TARGET ROLE
${role} at ${company}

JOB DESCRIPTION (use only to decide which of her real strengths to lead with)
${jd || '(none provided)'}

${GROUNDING}

STYLE RULES
- 2 to 3 sentences, maximum 70 words.
- CV summary style: no "I", no company name, no address to the reader.
- Lead with the experience from her CV that matters most for this role.
- Plain professional Australian English. No markdown, no headings. Never use an em dash.

Reply with the summary text only, no label.`;

  const raw = await llmComplete(prompt, { maxTokens: 1536 });
  const text = clean(raw).replace(/\s*\u2014\s*/g, ', ');
  if (!text || text.length < 40) throw new Error('summary too short');
  if (text.split(/\s+/).length > 90) throw new Error('summary too long');
  return { summary: text, method: `llm:${llmBackendName()}` };
}
