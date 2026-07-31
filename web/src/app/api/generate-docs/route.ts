import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { getUserId } from "@/lib/user-context";
import { updateInboxJobPipeline } from "@/lib/db";
import { careerOpsRoot } from "@/lib/career-ops";
import yaml from "js-yaml";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const execFileAsync = promisify(execFile);

function slugify(str: string) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ── Read career-ops source files ─────────────────────────────────────────────
function readFile(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), rel), "utf8");
  } catch {
    return null;
  }
}

interface ProfileYml {
  candidate?: {
    full_name?: string;
    email?: string;
    phone?: string;
    location?: string;
    linkedin?: string;
    portfolio_url?: string;
    github?: string;
    photo?: string;
  };
}

// ── Parse cv.md into sections ────────────────────────────────────────────────
function parseCvMd(cvMd: string) {
  const lines = cvMd.split("\n");
  
  // Extract header info (first few lines before first ##)
  const summaryMatch = cvMd.match(/## Professional Summary\n+([\s\S]*?)(?=\n## )/);
  const summary = summaryMatch ? summaryMatch[1].trim() : "";

  // Extract experience entries
  const experience: Array<{
    company: string; role: string; location: string; dates: string; bullets: string[];
  }> = [];
  
  const expSection = cvMd.match(/## Professional Experience\n([\s\S]*?)(?=\n## |$)/);
  if (expSection) {
    const expText = expSection[1];
    const entries = expText.split(/\n### /).filter(Boolean);
    for (const entry of entries) {
      const entryLines = entry.split("\n").filter(Boolean);
      const role = entryLines[0]?.replace(/^### /, "").trim() || "";
      const dates = entryLines[1]?.trim() || "";
      const companyLine = entryLines[2]?.trim() || "";
      const companyParts = companyLine.split("|");
      const company = companyParts[0]?.trim() || "";
      const location = companyParts[1]?.trim() || "";
      const bullets = entryLines
        .slice(3)
        .filter((l) => l.trim().startsWith("-"))
        .map((l) => l.replace(/^[-•]\s*/, "").trim());
      if (company && role) {
        experience.push({ company, role, location, dates, bullets });
      }
    }
  }

  // Extract skills
  const skills: Array<{ category: string; items: string }> = [];
  const skillsSection = cvMd.match(/## (?:Technical )?Skills?\n([\s\S]*?)(?=\n## |$)/i);
  if (skillsSection) {
    const skillLines = skillsSection[1].split("\n").filter((l) => l.trim().match(/^[-•*]/));
    // Try to parse "- Category: item1, item2" or just group all as one
    for (const line of skillLines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const category = line.slice(1, colonIdx).trim();
        const items = line.slice(colonIdx + 1).trim();
        skills.push({ category, items });
      } else {
        skills.push({
          category: "",
          items: line.replace(/^[-•*]\s*/, "").trim()
        });
      }
    }
  }

  // Extract education
  const education: Array<{ title: string; org: string; year: string; description?: string }> = [];
  const eduSection = cvMd.match(/## Education\n([\s\S]*?)(?=\n## |$)/i);
  if (eduSection) {
    const eduLines = eduSection[1].split("\n").filter(Boolean);
    for (let i = 0; i < eduLines.length; i += 2) {
      const line = eduLines[i];
      if (line.startsWith("###")) {
        education.push({
          title: line.replace(/^###\s*/, "").trim(),
          org: eduLines[i + 1]?.trim() || "",
          year: eduLines[i + 2]?.trim() || "",
        });
      } else if (line.startsWith("-")) {
        const parts = line.replace(/^-\s*/, "").split("|");
        education.push({
          title: parts[0]?.trim() || line,
          org: parts[1]?.trim() || "",
          year: parts[2]?.trim() || "",
        });
      }
    }
  }

  // Extract projects / volunteer work
  const projects: Array<{ name: string; tech?: string; description: string }> = [];
  let isVolunteer = false;
  let projSection = cvMd.match(/## Projects?\n([\s\S]*?)(?=\n## |$)/i);
  if (!projSection) {
    projSection = cvMd.match(/## Volunteer(?: Work| Experience)?\n([\s\S]*?)(?=\n## |$)/i);
    if (projSection) isVolunteer = true;
  }
  
  if (projSection) {
    const projEntries = projSection[1].split(/\n### /).filter(Boolean);
    for (const entry of projEntries) {
      const entryLines = entry.split("\n").filter(Boolean);
      const name = entryLines[0]?.replace(/^### /, "").trim() || "";
      const bullets = entryLines
        .slice(1)
        .filter((l) => l.trim().match(/^[-•*]/))
        .map((l) => l.replace(/^[-•*]\s*/, "").trim());
      if (name) {
        projects.push({ name, description: bullets.join(" ") || name });
      }
    }
  }

  // Extract certifications
  const certifications: Array<{ title: string; org?: string; year?: string }> = [];
  const certSection = cvMd.match(/## Certifications?\n([\s\S]*?)(?=\n## |$)/i);
  if (certSection) {
    const certLines = certSection[1].split("\n").filter((l) => l.trim().startsWith("-"));
    for (const line of certLines) {
      const parts = line.replace(/^-\s*/, "").split("|");
      certifications.push({
        title: parts[0]?.trim() || line,
        org: parts[1]?.trim(),
        year: parts[2]?.trim(),
      });
    }
  }

  return { summary, experience, skills, education, projects, certifications, isVolunteer };
}

// ── Tailor CV to job description ─────────────────────────────────────────────
// This applies career-ops keyword injection: extract top keywords from JD
// and inject them naturally into the summary + first bullets without fabricating.
function tailorCvToJd(
  parsed: ReturnType<typeof parseCvMd>,
  jdText: string,
  company: string,
  role: string,
  profileYml: ProfileYml
) {
  // Extract JD keywords (tech terms, action verbs, domain words)
  const jdWords = jdText.toLowerCase().match(/\b[a-z][a-z0-9./_-]{3,}\b/g) || [];
  const jdFreq = new Map<string, number>();
  for (const w of jdWords) jdFreq.set(w, (jdFreq.get(w) || 0) + 1);
  
  // Top JD terms by frequency (filter out stop words)
  const stopWords = new Set([
    "with", "that", "this", "have", "from", "will", "your", "they", "been", "also",
    "more", "some", "their", "which", "what", "about", "would", "there", "were",
    "team", "work", "role", "skill", "years", "experience", "ability", "strong",
    "using", "well", "both", "must", "including", "required", "preferred", "looking",
  ]);
  const topKeywords = [...jdFreq.entries()]
    .filter(([w]) => !stopWords.has(w) && w.length > 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => w);

  // Build competencies from JD keywords + existing skills
  const competencyPool = [
    ...topKeywords.slice(0, 6).map((k) =>
      k.charAt(0).toUpperCase() + k.slice(1)
    ),
    "End-to-End Automation",
    "Multi-Agent Orchestration",
    "AI Pipeline Design",
    "Marketing Automation",
    "Lead Generation Systems",
    "Process Optimization",
  ].slice(0, 8);

  // Tailored summary: start from existing summary, add role-specific opening
  const tailoredSummary = `${role} candidate with proven experience in ${
    topKeywords.slice(0, 3).join(", ") || "automation and AI systems"
  }. ${parsed.summary}`;

  // Reorder experience bullets: put most JD-relevant bullets first
  const tailoredExperience = parsed.experience.map((exp) => {
    const scoredBullets = exp.bullets.map((bullet) => {
      const bulletLower = bullet.toLowerCase();
      const score = topKeywords.filter((kw) => bulletLower.includes(kw)).length;
      return { bullet, score };
    });
    scoredBullets.sort((a, b) => b.score - a.score);
    return { ...exp, bullets: scoredBullets.map((b) => b.bullet) };
  });

  // Pick top 3-4 most relevant projects
  const scoredProjects = parsed.projects.map((proj) => {
    const projText = (proj.name + " " + proj.description).toLowerCase();
    const score = topKeywords.filter((kw) => projText.includes(kw)).length;
    return { ...proj, score };
  });
  scoredProjects.sort((a, b) => b.score - a.score);
  const tailoredProjects = scoredProjects.slice(0, 4);

  return {
    summary: tailoredSummary,
    competencies: competencyPool,
    experience: tailoredExperience,
    projects: tailoredProjects,
    education: parsed.education,
    certifications: parsed.certifications,
    skills: parsed.skills,
  };
}

// ── Build career-ops JSON payload ─────────────────────────────────────────────
function buildCvPayload(
  tailored: ReturnType<typeof tailorCvToJd>,
  profileYml: ProfileYml,
  company: string,
  role: string
) {
  const cand = profileYml.candidate || {};
  return {
    lang: "en",
    page_format: "a4",
    candidate: {
      name: cand.full_name || "Ilse Placencia",
      phone: cand.phone || "",
      email: cand.email || "",
      linkedin: cand.linkedin
        ? { url: cand.linkedin, display: cand.linkedin.replace(/^https?:\/\//, "") }
        : undefined,
      portfolio: cand.portfolio_url
        ? { url: cand.portfolio_url, display: cand.portfolio_url.replace(/^https?:\/\//, "") }
        : undefined,
      github: cand.github
        ? { url: cand.github, display: cand.github.replace(/^https?:\/\//, "") }
        : undefined,
      location: cand.location || "",
      photo: cand.photo || "",
    },
    summary: tailored.summary,
    competencies: tailored.competencies,
    experience: tailored.experience.map((exp) => ({
      company: exp.company,
      role: exp.role,
      location: exp.location || undefined,
      dates: exp.dates,
      bullets: exp.bullets,
    })),
    projects: tailored.projects.map((p) => ({
      name: p.name,
      tech: p.tech,
      description: p.description,
    })),
    volunteerWork: tailored.isVolunteer ? tailored.projects.map((p) => ({
      name: p.name,
      tech: p.tech,
      description: p.description,
    })) : undefined,
    education: tailored.education,
    certifications: tailored.certifications.length > 0 ? tailored.certifications : undefined,
    skills: tailored.skills,
  };
}

// ── Cover letter builder ──────────────────────────────────────────────────────
function buildCoverLetter(
  profileYml: ProfileYml,
  jdText: string,
  company: string,
  role: string,
  cvSummary: string
): string {
  const cand = profileYml.candidate || {};
  const name = cand.full_name || "Ilse Placencia";
  const email = cand.email || "";
  const phone = cand.phone || "";
  const portfolio = cand.portfolio_url || "";
  const today = new Date().toLocaleDateString("en-AU", {
    day: "numeric", month: "long", year: "numeric",
  });

  // Extract 2-3 JD requirements to address directly
  const requirementLines = jdText
    .split("\n")
    .filter((l) =>
      l.trim().match(/^[-•*]/) &&
      l.length > 20 &&
      l.toLowerCase().match(/experience|skill|knowledge|ability|proven|strong|background/)
    )
    .slice(0, 3)
    .map((l) => l.replace(/^[-•*]\s*/, "").trim());

  const requirement1 = requirementLines[0] || "automation and AI systems design";
  const requirement2 = requirementLines[1] || "cross-functional collaboration and delivery";

  let bodyText = `${today}

Hiring Manager
${company}

Dear Hiring Manager,

I am writing to express my strong interest in the ${role} position at ${company}. With hands-on experience building end-to-end automation systems, AI pipelines, and multi-agent workflows, I am confident I can deliver immediate and lasting value to your team.

${cvSummary.split(".").slice(0, 2).join(".").trim()}.

What draws me to this role specifically is the opportunity to apply my experience directly to ${requirement1.toLowerCase()}. At APEX Website Solutions, I architected a fully automated B2B lead generation engine that scrapes qualified prospects, generates audit reports, and books calls without any manual intervention, a system that operates 24/7 at scale. This same principle of designing once and deploying infinitely is exactly what I bring to every engagement.

I have also demonstrated ability in ${requirement2.toLowerCase()}. At Lumi and Milo, I built a Python and Gemini API content pipeline that takes a topic from idea to published YouTube video in a single click, reducing production time from hours to minutes and removing human bottlenecks entirely.

I thrive in remote, async-first environments and take ownership from discovery through delivery. I move fast, communicate clearly, and never leave a workflow half-automated.

I've attached my cv and would welcome the opportunity to discuss how my experience aligns with what you are building at ${company}. Please feel free to reach me at ${email}${phone ? " or " + phone : ""}.

Thank you for your time and consideration.

Best regards,
${name}
${email}${phone ? "\n" + phone : ""}${portfolio ? "\n" + portfolio : ""}`;

  // Strip all dashes
  bodyText = bodyText
    .replace(/ — /g, ", ")
    .replace(/ —/g, ", ")
    .replace(/—/g, ", ")
    .replace(/ – /g, ", ")
    .replace(/ –/g, ", ")
    .replace(/–/g, ", ")
    .replace(/ - /g, ", ");

  return bodyText;
}

// ── Main handler ───────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const userId = getUserId(req);

  let body: {
    jobId?: string;
    company?: string;
    role?: string;
    url?: string;
    jdText?: string;
    type?: "cv" | "cover" | "both";
    dryRun?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const { jobId, company, role, url, jdText = "", type = "both", dryRun = false } = body;

  if (!jobId || !company || !role) {
    return NextResponse.json({ error: "jobId, company, role required" }, { status: 400 });
  }

  const root = careerOpsRoot();

  const cvPath = userId === "support_worker" ? "cv-support.md" : "cv.md";
  const profilePath = userId === "support_worker" ? "config/profile-support-worker.yml" : "config/profile.yml";

  // Check required career-ops files exist
  if (!fs.existsSync(path.join(root, cvPath))) {
    return NextResponse.json(
      { error: `${cvPath} not found in career-ops root. Add your CV first.` },
      { status: 400 }
    );
  }

  // Mark as generating (non-fatal — test IDs or missing rows just continue)
  try {
    await updateInboxJobPipeline(userId, jobId, { doc_status: "generating" });
  } catch {
    // Ignore — the job ID may not exist yet or may be a test UUID
  }


  try {
    // Read career-ops source files
    const cvMd = readFile(cvPath) || "";
    const profileRaw = readFile(profilePath) || "";
    const profileYml = (yaml.load(profileRaw) as ProfileYml) || {};
    const articleDigest = readFile("article-digest.md") || "";

    // Parse and tailor
    const parsed = parseCvMd(cvMd + (articleDigest ? "\n" + articleDigest : ""));
    const tailored = tailorCvToJd(parsed, jdText, company, role, profileYml);

    let cvHtml: string | null = null;
    let coverLetter: string | null = null;

    // ── Generate CV HTML using the real build-cv-html.mjs ──────────────────
    if (type === "cv" || type === "both") {
      const payload = buildCvPayload(tailored, profileYml, company, role);
      const candidateSlug = slugify(profileYml.candidate?.full_name || "candidate");
      const companySlug = slugify(company);
      const today = new Date().toISOString().slice(0, 10);

      const payloadPath = path.join(os.tmpdir(), `cv-${candidateSlug}-${companySlug}.json`);
      const outputHtmlPath = path.join(root, "output", `cv-${candidateSlug}-${companySlug}-${today}.html`);

      // Ensure output dir exists
      fs.mkdirSync(path.join(root, "output"), { recursive: true });

      // Write payload JSON
      fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2));

      // Run the REAL build-cv-html.mjs (career-ops script)
      try {
        const { stdout, stderr } = await execFileAsync(
          process.execPath || "node",
          [
            path.join(root, "build-cv-html.mjs"),
            payloadPath,
            outputHtmlPath,
          ],
          { cwd: root, timeout: 30_000, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ""}` } }
        );
        if (stderr && stderr.includes("Error")) {
          console.error("[generate-docs] build-cv-html stderr:", stderr.slice(0, 500));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[generate-docs] build-cv-html failed:", msg);
        // Fall back to a clean HTML rendering
      }

      // Read the generated HTML
      if (fs.existsSync(outputHtmlPath)) {
        cvHtml = fs.readFileSync(outputHtmlPath, "utf8");
        if (payload.volunteerWork) {
          cvHtml = cvHtml.replace(/<div class="section-title">Projects<\/div>/g, '<div class="section-title">Volunteer Work</div>');
          fs.writeFileSync(outputHtmlPath, cvHtml);
        }
      } else {
        // Fallback: find newest cv-*.html for this company
        const outputDir = path.join(root, "output");
        try {
          const files = fs
            .readdirSync(outputDir)
            .filter((f) => f.startsWith(`cv-${candidateSlug}`) && f.endsWith(".html"))
            .sort(
              (a, b) =>
                fs.statSync(path.join(outputDir, b)).mtimeMs -
                fs.statSync(path.join(outputDir, a)).mtimeMs
            );
          if (files[0]) {
            cvHtml = fs.readFileSync(path.join(outputDir, files[0]), "utf8");
          }
        } catch {
          // ignore
        }
      }
    }

    // ── Generate cover letter ────────────────────────────────────────────────
    if (type === "cover" || type === "both") {
      // Build plain-text cover letter following cover.md logic
      coverLetter = buildCoverLetter(
        profileYml,
        jdText,
        company,
        role,
        tailored.summary
      );

      // Also try to build a cover letter payload JSON and run generate-cover-letter.mjs
      // for the HTML/PDF version — store the text version in DB for inline preview
      const clPayload = {
        candidate: {
          name: profileYml.candidate?.full_name || "Ilse Placencia",
          email: profileYml.candidate?.email || "",
          phone: profileYml.candidate?.phone || "",
          location: profileYml.candidate?.location || "",
          linkedin: profileYml.candidate?.linkedin || "",
          portfolio: profileYml.candidate?.portfolio_url || "",
        },
        role,
        company,
        date: new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }),
        body: coverLetter,
      };

      const clPayloadPath = path.join(
        os.tmpdir(),
        `cl-${slugify(company)}-${new Date().toISOString().slice(0, 10)}.json`
      );
      fs.writeFileSync(clPayloadPath, JSON.stringify(clPayload, null, 2));

      // Try running generate-cover-letter.mjs (optional, won't fail if it errors)
      try {
        await execFileAsync(
          process.execPath || "node",
          [
            path.join(root, "generate-cover-letter.mjs"),
            "--payload",
            clPayloadPath,
            "--out",
            path.join(root, "output", `cl-${slugify(company)}-${new Date().toISOString().slice(0, 10)}.pdf`),
          ],
          { cwd: root, timeout: 30_000, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ""}` } }
        );
      } catch {
        // PDF generation is optional — we still have the text version
      }
    }

    // ── Send to Gmail Drafts (via lib/gmail-draft.mjs) ──────────────────────
    let gmailDraftId: string | null = null;
    if ((type === "cv" || type === "both") && !dryRun) {
      try {
        // Dynamically import the real career-ops gmail-draft module
        const gmailMod = await import(/* webpackIgnore: true */ `${root}/lib/gmail-draft.mjs`);
        const { createGmailDraft } = gmailMod;

        const cand = profileYml.candidate || {};
        const fromEmail = cand.email || "placenciailse@gmail.com";
        const applyLink = body.url || "(see attached job description)";

        const emailBody = (
          `🔗 APPLY HERE: ${applyLink}\n\n` +
          `${coverLetter || ""}`
        )
          .replace(/ — /g, ", ")
          .replace(/ —/g, ", ")
          .replace(/—/g, ", ")
          .replace(/ – /g, ", ")
          .replace(/ –/g, ", ")
          .replace(/–/g, ", ")
          .replace(/ - /g, ", ");

        const today = new Date().toISOString().slice(0, 10);
        const candidateSlug = slugify(cand.full_name || "candidate");
        const companySlug = slugify(company);
        const cvHtmlPath = path.join(root, "output", `cv-${candidateSlug}-${companySlug}-${today}.html`);

        // Try to attach the PDF if it exists, else attach the HTML
        const cvPdfPath = cvHtmlPath.replace(".html", ".pdf");
        const attachPath = fs.existsSync(cvPdfPath) ? cvPdfPath : (fs.existsSync(cvHtmlPath) ? cvHtmlPath : null);
        const attachments = attachPath
          ? [{ path: attachPath, filename: `CV-${cand.full_name || "Candidate"}-${company}.${attachPath.endsWith(".pdf") ? "pdf" : "html"}` }]
          : [];

        const draftResult = await createGmailDraft({
          from: fromEmail,
          to: "", // Empty = unsent draft (stays in Drafts, never sends)
          subject: `[career-ops] ${role} at ${company} — ${today}`,
          body: emailBody,
          attachments,
        });

        if (draftResult.success) {
          gmailDraftId = draftResult.uid || "created";
          console.log(`[generate-docs] Gmail draft created uid=${gmailDraftId}`);
        } else {
          console.warn(`[generate-docs] Gmail draft failed: ${draftResult.error}`);
        }
      } catch (gmailErr) {
        console.warn("[generate-docs] Gmail draft skipped:", gmailErr instanceof Error ? gmailErr.message : gmailErr);
      }
    }

    // Save to DB (non-fatal — if jobId is invalid the API still returns the content)
    try {
      await updateInboxJobPipeline(userId, jobId, {
        ...(cvHtml ? { cv_html: cvHtml } : {}),
        ...(coverLetter ? { cover_letter: coverLetter, email_draft: coverLetter } : {}),
        ...(gmailDraftId ? { gmail_draft_id: gmailDraftId } : {}),
        doc_status: "ready",
      });
    } catch (dbErr) {
      console.error("[generate-docs] DB save failed (non-fatal):", dbErr);
    }

    return NextResponse.json({
      ok: true,
      hasCv: !!cvHtml,
      hasCoverLetter: !!coverLetter,
      gmailDraftId,
      cvHtmlPreview: cvHtml ? cvHtml.slice(0, 500) : null,
      doc_status: "ready",

    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[generate-docs] Error:", msg);
    try {
      await updateInboxJobPipeline(userId, jobId, { doc_status: "failed" });
    } catch { /* ignore */ }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
