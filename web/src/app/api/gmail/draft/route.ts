import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/user-context";
import { getSql } from "@/lib/db";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const userId = getUserId(request);
  let body: { jobId?: string; cvBase64?: string; clBase64?: string; rlBase64?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { jobId, cvBase64, clBase64, rlBase64 } = body;
  if (!jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(jobId)) {
    return NextResponse.json({ error: "Invalid jobId UUID format" }, { status: 400 });
  }

  try {
    const sql = getSql();
    // 1. Fetch job from DB
    const result = await sql`
      SELECT id, company, role, url, cover_letter, email_draft, cv_html, gmail_draft_id
      FROM job_inbox
      WHERE id = ${jobId} AND user_id = ${userId}
    `;
    if (result.length === 0) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const job = result[0];
    if (job.gmail_draft_id && job.gmail_draft_id !== "created") {
      return NextResponse.json({ ok: true, gmailDraftId: job.gmail_draft_id, message: "Gmail draft already exists" });
    }
    const textContent = job.email_draft || job.cover_letter;
    if (!textContent) {
      return NextResponse.json({ error: "No cover letter or email draft found. Generate documents first." }, { status: 400 });
    }

    // Parse subject and body from the email_draft text (if formatted as Subject: ...)
    let subject = `Application: ${job.role} at ${job.company}`;
    let emailBody = textContent;
    if (textContent.startsWith("Subject:")) {
      const firstNewline = textContent.indexOf("\n");
      if (firstNewline !== -1) {
        subject = textContent.slice(8, firstNewline).trim();
        emailBody = textContent.slice(firstNewline).trim();
      }
    }

    // Prepend APPLY HERE URL if missing
    if (!emailBody.includes("APPLY HERE")) {
      emailBody = `🔗 APPLY HERE: ${job.url}\n\n` + emailBody;
    }

    // 2. Locate the tailored CV, Cover Letter, and Reference Letter PDFs
    const root = path.join(process.cwd(), "..");
    let attachments = [];
    if (cvBase64) {
      attachments.push({ content: cvBase64, filename: `${job.company.replace(/[^a-zA-Z0-9]/g, "")}_Resume.pdf` });
    }
    if (clBase64) {
      attachments.push({ content: clBase64, filename: `${job.company.replace(/[^a-zA-Z0-9]/g, "")}_Cover_Letter.pdf` });
    }
    if (rlBase64) {
      attachments.push({ content: rlBase64, filename: `${job.company.replace(/[^a-zA-Z0-9]/g, "")}_Reference_Letter.pdf` });
    }

    if (attachments.length === 0) {
      const outputDir = path.join(root, "output");
      try {
      if (fs.existsSync(outputDir)) {
        const files = fs.readdirSync(outputDir);
        const cleanCompany = job.company.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");

        // Find CV PDF (starts with cv- or llm-cv-)
        const cvMatch = files.filter(f => (f.startsWith("cv-") || f.startsWith("llm-cv-")) && f.toLowerCase().includes(cleanCompany) && f.endsWith(".pdf"))
                             .sort((a, b) => fs.statSync(path.join(outputDir, b)).mtimeMs - fs.statSync(path.join(outputDir, a)).mtimeMs)[0];
        if (cvMatch) {
          attachments.push({
            path: path.join(outputDir, cvMatch),
            filename: `${job.company.replace(/[^a-zA-Z0-9]/g, "")}_Resume.pdf`
          });
        }

        // Find Cover Letter PDF (starts with cl-)
        const clMatch = files.filter(f => f.startsWith("cl-") && f.toLowerCase().includes(cleanCompany) && f.endsWith(".pdf"))
                             .sort((a, b) => fs.statSync(path.join(outputDir, b)).mtimeMs - fs.statSync(path.join(outputDir, a)).mtimeMs)[0];
        if (clMatch) {
          attachments.push({
            path: path.join(outputDir, clMatch),
            filename: `${job.company.replace(/[^a-zA-Z0-9]/g, "")}_Cover_Letter.pdf`
          });
        }

        // Find Reference Letter PDF (starts with rl-)
        const rlMatch = files.filter(f => f.startsWith("rl-") && f.toLowerCase().includes(cleanCompany) && f.endsWith(".pdf"))
                             .sort((a, b) => fs.statSync(path.join(outputDir, b)).mtimeMs - fs.statSync(path.join(outputDir, a)).mtimeMs)[0];
        if (rlMatch) {
          attachments.push({
            path: path.join(outputDir, rlMatch),
            filename: `${job.company.replace(/[^a-zA-Z0-9]/g, "")}_Reference_Letter.pdf`
          });
        }
      }
    } catch (e) {
      console.warn("[gmail-draft-api] Attachment resolution failed:", e);
    }
    }

    // 3. Create Gmail Draft
    console.log(`[gmail-draft-api] Creating draft for ${job.company} with attachments:`, attachments);
    const gmailMod = await import(/* webpackIgnore: true */ `${root}/lib/gmail-draft.mjs`);
    const draftResult = await gmailMod.createGmailDraft({
      from: "placenciailse@gmail.com",
      to: "", // Keep to empty to create draft
      subject,
      body: emailBody,
      attachments
    });

    if (!draftResult.success) {
      throw new Error(draftResult.error || "IMAP APPEND failed");
    }

    // 4. Update job status in DB
    const draftId = draftResult.uid || "created";
    await sql`
      UPDATE job_inbox
      SET gmail_draft_id = ${draftId}, updated_at = NOW()
      WHERE id = ${jobId} AND user_id = ${userId}
    `;

    return NextResponse.json({ ok: true, gmailDraftId: draftId });
  } catch (err: any) {
    console.error("[POST /api/gmail/draft]", err);
    return NextResponse.json({ error: err.message || "Failed to create Gmail draft" }, { status: 500 });
  }
}
