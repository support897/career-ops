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

// ── CV Generation ─────────────────────────────────────────────────────────────

/**
 * Generate a tailored CV HTML for this specific job.
 * Uses the user's master CV and adapts keywords to match the JD.
 * Harvard-style, blue titles, black body text.
 */
export async function generateTailoredCV(
  job: Pick<InboxJob, "company" | "role" | "jd_text" | "url">,
  profile: Pick<UserProfile, "cv_data" | "cv_markdown" | "full_name" | "email" | "location">
): Promise<string> {
  const cvData = profile.cv_markdown || (profile.cv_data ? JSON.stringify(profile.cv_data).slice(0, 5000) : "");
  const jd = job.jd_text || `${job.role} at ${job.company}`;

  const prompt = `You are a professional CV writer. Create a tailored CV in HTML format for this job application.

## Instructions
1. Use the candidate's EXACT experience and job history (do NOT invent anything)
2. Adapt the LANGUAGE and KEYWORDS to match the job description
3. Keep the same number of pages as the master CV
4. Format: Harvard style with BLUE (#1a56db) titles, BLACK body text
5. Include ALL sections from the master CV (Summary, Experience, Skills, Education)
6. Do NOT include a Projects section
7. Return ONLY the complete HTML (no markdown, no explanation)

## Job Description
Company: ${job.company}
Role: ${job.role}
${jd.slice(0, 3000)}

## Candidate Information
Name: ${profile.full_name || "Candidate"}
Email: ${profile.email || ""}
Location: ${profile.location || ""}

## Master CV Data
${cvData}

Generate the complete, self-contained HTML CV tailored to this specific job. Use inline styles.`;

  const html = await callGemini(prompt);

  // If the response looks like HTML, return it. Otherwise wrap it.
  if (html.includes("<html") || html.includes("<div")) {
    return html;
  }

  // Fallback: wrap in basic HTML structure
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
body { font-family: Georgia, serif; max-width: 800px; margin: 0 auto; padding: 40px; color: #111; }
h1, h2, h3 { color: #1a56db; }
h2 { border-bottom: 1px solid #1a56db; padding-bottom: 4px; }
</style>
</head>
<body>
${html}
</body>
</html>`;
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
  const name = profile.full_name || "Ilse Placencia";
  const email = profile.email || "placenciailse@gmail.com";
  const location = profile.location || "";

  const prompt = `Write a professional, personalized cover letter for this job application.

## Rules
- Use ONLY facts from the candidate's CV (never invent experience)
- Ensure "Fiesta Fresh Cleaning" is highlighted as a primary work experience when relevant to automation/AI.
- Match the language and keywords from the job description
- 3-4 paragraphs: opening, proof of skills, why this company, call to action
- Warm but professional tone
- DO NOT use generic phrases like "I am a highly motivated individual"
- Address real skill matches from the JD to the CV

## Job Details
Company: ${job.company}
Role: ${job.role}
${jd.slice(0, 2000)}

## Candidate
Name: ${name}
Email: ${email}
Location: ${location}

## Their Background
${cvSummary.slice(0, 2000)}

Return ONLY the cover letter text (no subject line, no HTML, no markdown).`;

  const text = await callGemini(prompt);

  // Add signature
  return `${text.trim()}

Best regards,
${name}
${email} | ${location}`;
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

  const prompt = `Write a compelling cold outreach email for this job application.

## Rules
- Subject line: "Application: ${job.role} — ${name}"
- Keep the email full page length. DO NOT make it short or concise.
- Start the email body directly with "I believe I'm the perfect candidate for the ${job.role} position at ${job.company}." (no formal greeting)
- Ensure "Fiesta Fresh Cleaning" is highlighted as a primary work experience when relevant to automation/AI.
- Open with their strongest relevant achievement
- One specific reason why this company/role is exciting
- Clear call to action
- Use facts from the CV only — never invent
- MUST use bullet points to list achievements or skills. However, NEVER use dashes (-) for bullet points (use asterisks or emojis or other symbols instead).
- Highlight the candidate's language proficiency prominently.
- Embed the raw job URL directly at the top of the body (no 'Apply here' labels): ${job.url}

## Job
Company: ${job.company}
Role: ${job.role}
${jd.slice(0, 1500)}

## Candidate
${cvSummary.slice(0, 1500)}

Return the email in this format:
Subject: [subject line]

[email body]

Best regards,
${name}
${email}`;

  return callGemini(prompt);
}

// ── Full Pipeline ─────────────────────────────────────────────────────────────

/**
 * Run the complete AI pipeline for a single job.
 * Scores → if above threshold, generates CV + CL + email.
 */
export async function runFullPipeline(
  job: InboxJob,
  profile: UserProfile,
  scoreThreshold = 3.0
): Promise<{ score: ScoreResult; cv_html?: string; cover_letter?: string; email_draft?: string }> {
  console.log(`[ai-pipeline] Scoring ${job.company} — ${job.role}`);

  // Step 1: Score the job
  const score = await scoreJob(job, profile);

  console.log(`[ai-pipeline] Score: ${score.score} (${score.grade}) — threshold: ${scoreThreshold}`);

  // Step 2: Only generate docs if above threshold
  if (score.score < scoreThreshold) {
    return { score };
  }

  console.log(`[ai-pipeline] Generating documents for ${job.company}...`);

  // Step 3: Generate all documents in parallel
  const [cv_html, cover_letter, email_draft] = await Promise.all([
    generateTailoredCV(job, profile).catch((e) => {
      console.error(`[ai-pipeline] CV gen failed: ${e.message}`);
      return "";
    }),
    generateCoverLetterText(job, profile).catch((e) => {
      console.error(`[ai-pipeline] CL gen failed: ${e.message}`);
      return "";
    }),
    generateEmailDraft(job, profile).catch((e) => {
      console.error(`[ai-pipeline] Email gen failed: ${e.message}`);
      return "";
    }),
  ]);

  return { score, cv_html, cover_letter, email_draft };
}
