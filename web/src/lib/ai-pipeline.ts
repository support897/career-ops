/**
 * ai-pipeline.ts — Career-ops AI pipeline: scoring + document generation.
 *
 * Uses the SAME scoring rubric as career-ops (modes/_shared.md + modes/oferta.md)
 * but calls the Gemini API directly — no CLI needed. Runs on Lambda and Vercel.
 *
 * Functions:
 *  - scoreJob(job, userProfile)          → score 1.0–5.0 + breakdown + whyMatch
 *  - generateTailoredCV(job, userProfile) → HTML string
 *  - generateCoverLetter(job, userProfile) → plain text
 *  - generateEmailDraft(job, userProfile)  → plain text
 *  - runFullPipeline(job, userProfile)     → all of the above
 */

import type { InboxJob, UserProfile } from "./db";

// ── Gemini API helper ─────────────────────────────────────────────────────────

async function callGemini(prompt: string, model = "gemini-2.5-flash"): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScoreResult = {
  score: number;                              // 1.0–5.0
  grade: "A" | "B" | "C" | "D" | "F";
  why_match: string;
  breakdown: {
    role_fit: number;                         // 1–5 each dimension
    tech_match: number;
    culture_fit: number;
    compensation: number;
    legitimacy: number;
  };
  deal_breakers: string[];
  missing_skills: string[];
  raw: string;
};

export type PipelineResult = {
  score: ScoreResult;
  cv_html: string;
  cover_letter: string;
  email_draft: string;
};

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Score a job against the user's CV using career-ops rubric.
 * Mirrors modes/_shared.md scoring logic (A–F rubric, 5 blocks).
 */
export async function scoreJob(
  job: Pick<InboxJob, "company" | "role" | "url" | "location" | "jd_text" | "salary">,
  profile: Pick<UserProfile, "cv_data" | "cv_markdown" | "profile_config" | "keywords" | "location_filter">
): Promise<ScoreResult> {
  const cvSummary = profile.cv_markdown || (profile.cv_data
    ? JSON.stringify(profile.cv_data).slice(0, 3000)
    : "No CV data available");

  const profileConfig = profile.profile_config
    ? JSON.stringify(profile.profile_config).slice(0, 1000)
    : "";

  const jd = job.jd_text || `Role: ${job.role} at ${job.company}. Location: ${job.location || "unknown"}. URL: ${job.url}`;

  const prompt = `You are a career advisor running the career-ops job evaluation rubric. 
Evaluate this job against the candidate's CV and return a structured JSON assessment.

## Job Description
Company: ${job.company}
Role: ${job.role}
Location: ${job.location || "Not specified"}
Salary: ${job.salary || "Not specified"}
URL: ${job.url}

${jd.slice(0, 4000)}

## Candidate CV Summary
${cvSummary}

## Candidate Profile
${profileConfig}

## Instructions
Score this job opportunity using the career-ops rubric. Return ONLY valid JSON with this exact structure:
{
  "score": <1.0-5.0 float>,
  "grade": "<A|B|C|D|F>",
  "why_match": "<2-3 sentences explaining why this is/isn't a good match, written for the candidate>",
  "breakdown": {
    "role_fit": <1-5>,
    "tech_match": <1-5>,
    "culture_fit": <1-5>,
    "compensation": <1-5>,
    "legitimacy": <1-5>
  },
  "deal_breakers": ["<any hard deal-breakers found>"],
  "missing_skills": ["<skills the JD requires but CV lacks>"]
}

Score guide:
- 5.0 = Exceptional match, apply immediately
- 4.0–4.9 = Strong match, worth applying
- 3.0–3.9 = Decent match, consider applying
- 2.0–2.9 = Weak match, significant gaps
- 1.0–1.9 = Poor match, don't apply

Grade: A=4.5+, B=3.5–4.4, C=2.5–3.4, D=1.5–2.4, F<1.5`;

  const raw = await callGemini(prompt);

  try {
    // Extract JSON from the response (handle markdown code blocks)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score: Math.min(5, Math.max(1, parseFloat(parsed.score) || 3.0)),
      grade: parsed.grade || "C",
      why_match: parsed.why_match || "No match analysis available.",
      breakdown: {
        role_fit: parsed.breakdown?.role_fit || 3,
        tech_match: parsed.breakdown?.tech_match || 3,
        culture_fit: parsed.breakdown?.culture_fit || 3,
        compensation: parsed.breakdown?.compensation || 3,
        legitimacy: parsed.breakdown?.legitimacy || 3,
      },
      deal_breakers: parsed.deal_breakers || [],
      missing_skills: parsed.missing_skills || [],
      raw,
    };
  } catch {
    // Fallback if JSON parsing fails
    return {
      score: 3.0,
      grade: "C",
      why_match: "Score analysis incomplete — review manually.",
      breakdown: { role_fit: 3, tech_match: 3, culture_fit: 3, compensation: 3, legitimacy: 3 },
      deal_breakers: [],
      missing_skills: [],
      raw,
    };
  }
}

// ── Cover Letter Generation ───────────────────────────────────────────────────

/**
 * Generate a personalized cover letter for this job using Gemini.
 */
export async function generateCoverLetterText(
  job: Pick<InboxJob, "company" | "role" | "jd_text" | "why_match">,
  profile: Pick<UserProfile, "cv_data" | "cv_markdown" | "full_name" | "email" | "location" | "profile_config">
): Promise<string> {
  const cvSummary = profile.cv_markdown || (profile.cv_data ? JSON.stringify(profile.cv_data).slice(0, 3000) : "");
  const jd = job.jd_text || `${job.role} at ${job.company}`;

  const prompt = `Write a professional, personalized cover letter payload for this job application.

## Rules
- Use ONLY facts from the candidate's CV (never invent experience)
- Ensure "Fiesta Fresh Cleaning" is highlighted as a primary work experience when relevant to automation/AI.
- Address real skill matches from the JD to the CV

Return ONLY valid JSON matching this exact structure (no markdown fences, just JSON):
{
  "opening": "I'm writing to express my strong interest in the ${job.role} position at ${job.company}...",
  "profile_intro": "Your role emphasizes [Key JD terms] — here's what I've built in these areas:",
  "achievements": [
    { "lead": "Short bold lead", "impact": "Description of achievement..." },
    { "lead": "Another lead", "impact": "..." }
  ]
}

## Job Details
Company: ${job.company}
Role: ${job.role}
${jd.slice(0, 2000)}

## Their Background
${cvSummary.slice(0, 2000)}`;

  const text = await callGemini(prompt);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  return text;
}

// ── Email Draft Generation ────────────────────────────────────────────────────

/**
 * Generate a cold outreach / application email draft using Gemini.
 */
export async function generateEmailDraft(
  job: Pick<InboxJob, "company" | "role" | "jd_text" | "url">,
  profile: Pick<UserProfile, "cv_data" | "cv_markdown" | "full_name" | "email" | "location">
): Promise<string> {
  const cvSummary = profile.cv_markdown || (profile.cv_data ? JSON.stringify(profile.cv_data).slice(0, 2000) : "");
  const jd = job.jd_text || `${job.role} at ${job.company}`;
  const name = profile.full_name || "Ilse Placencia";
  const email = profile.email || "placenciailse@gmail.com";

  const prompt = `Analyze the job description and extract 2 powerful bullet points from the candidate's experience that perfectly match the role requirements.

## Rules
- Use ONLY facts from the candidate's CV (never invent experience)
- Ensure "Fiesta Fresh Cleaning" is highlighted as a primary work experience when relevant to automation/AI.
- DO NOT use dashes (-) for bullet points. Use asterisks (*).

Return ONLY the 2 bullet points as raw text, one per line. Do not include introductory text.

## Job
Company: ${job.company}
Role: ${job.role}
${jd.slice(0, 1500)}

## Candidate
${cvSummary.slice(0, 1500)}`;

  const bullets = await callGemini(prompt);

  return `Subject: Application: ${job.role} — ${name}

${job.url || ""}

I believe I'm the perfect candidate for the ${job.role} position at ${job.company}.

I build AI-powered automation systems. With over 6 years of experience across three businesses I founded, I bring a unique combination of technical depth and business outcomes. I have personally built, deployed, and run production AI agents, covering the full stack from prospecting to campaign management to sales operations.

${bullets.trim()}

I am fluent in TypeScript, Node.js, Python, REST APIs, and webhooks. I develop with Claude, Cursor, and multi-agent orchestration as my primary tools. I do not just evaluate AI tools; I build production systems with them.

Furthermore, I speak fluently English, Spanish (Native), Italian, and basic French, which allows me to effectively communicate with international clients and diverse teams.

I'd be thrilled to bring this experience to ${job.company}. Wishing you a great week regardless.

Best regards,
${name}
${email} | +61498570497
https://www.ilseplacencia.shop`;
}

