import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/user-context";
import { getSql } from "@/lib/db";
import { careerOpsRoot } from "@/lib/career-ops";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import yaml from "js-yaml";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Turn a stored document into a real PDF and return it base64-encoded.
 *
 * Attachments used to be built in the browser with html2pdf.js, which
 * rasterises the page and drops the stylesheet, so the PDFs that reached Gmail
 * were unstyled and clipped. generate-pdf.mjs is the same Playwright renderer
 * the download button uses, so Gmail and the dashboard now hand over identical
 * files. Its path-traversal guard refuses to write outside the repo, hence the
 * in-repo staging directory.
 */
async function htmlToPdfBase64(root: string, html: string): Promise<string | null> {
  if (!html || !html.trim()) return null;

  const wrapped = html.includes("<")
    ? html
    : `<div style="font-family:Georgia,serif;padding:40px;line-height:1.6;font-size:14px;white-space:pre-wrap">${html
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")}</div>`;

  const tempDir = path.join(root, "output", ".pdftmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempHtml = path.join(tempDir, `${stamp}.html`);
  const tempPdf = path.join(tempDir, `${stamp}.pdf`);

  try {
    fs.writeFileSync(tempHtml, wrapped, "utf8");
    await execFileAsync(
      process.execPath || "node",
      [path.join(root, "generate-pdf.mjs"), tempHtml, tempPdf, "--format=letter"],
      {
        cwd: root,
        timeout: 60_000,
        env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ""}` },
      }
    );
    return fs.readFileSync(tempPdf).toString("base64");
  } catch (e) {
    console.warn("[gmail-draft-api] PDF render failed:", e instanceof Error ? e.message : e);
    return null;
  } finally {
    try { fs.unlinkSync(tempHtml); } catch {}
    try { fs.unlinkSync(tempPdf); } catch {}
  }
}

/** Pull the tailored achievement bullets out of the stored cover letter.
 *
 * `job_inbox.cover_letter` holds the rendered HTML when a styled letter exists
 * and falls back to plain text otherwise, so both shapes have to be handled.
 * Reading it as text alone matched the `*` of the stylesheet's universal
 * selector and produced a single bullet reading "{".
 */
function stripTags(fragment: string): string {
  return fragment
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBullets(coverLetter: string | null): string[] {
  if (!coverLetter) return [];

  const looksLikeHtml = /<\/?(p|div|li|ul|html|body|span|style)\b/i.test(coverLetter);
  if (looksLikeHtml) {
    const withoutStyles = coverLetter
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "");
    const listItems = [...withoutStyles.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((m) => stripTags(m[1]))
      .filter(Boolean);
    if (listItems.length > 0) return listItems;

    // The rendered cover letter puts each achievement in a paragraph inside a
    // `.achievements` container rather than a list, so pull those out.
    const container = withoutStyles.match(
      /<(div|section)\b[^>]*class="[^"]*\bachievements\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/i
    );
    if (container) {
      const paragraphs = [...container[2].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((m) => stripTags(m[1]))
        .filter((t) => t.length > 30);
      if (paragraphs.length > 0) return paragraphs;
    }
    return [];
  }

  const bullets: string[] = [];
  for (const raw of coverLetter.split("\n")) {
    const line = raw.trim();
    if (!/^[*\-\u2022]\s+\S/.test(line)) continue;
    const text = line
      .replace(/^[*\-\u2022]\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) bullets.push(text);
  }
  return bullets;
}

export async function POST(request: NextRequest) {
  const userId = getUserId(request);
  let body: { jobId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { jobId } = body;
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(jobId)) {
    return NextResponse.json({ error: "Invalid jobId UUID format" }, { status: 400 });
  }

  try {
    const sql = getSql();
    const result = await sql`
      SELECT id, company, role, url, cover_letter, cover_letter_html,
             cv_html, reference_letter, gmail_draft_id
      FROM job_inbox
      WHERE id = ${jobId} AND user_id = ${userId}
    `;
    if (result.length === 0) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const job = result[0];
    if (job.gmail_draft_id && job.gmail_draft_id !== "created") {
      return NextResponse.json({
        ok: true,
        gmailDraftId: job.gmail_draft_id,
        message: "Gmail draft already exists",
      });
    }

    const root = careerOpsRoot();

    // Candidate details for the sign-off.
    let candidate: any = {};
    try {
      const profileRaw = fs.readFileSync(path.join(root, "config", "profile.yml"), "utf8");
      candidate = ((yaml.load(profileRaw) as any) || {}).candidate || {};
    } catch {}

    const fullName = candidate.full_name || "Ilse Placencia";
    const fromEmail = candidate.email || "placenciailse@gmail.com";
    const contactLine = [fromEmail, candidate.phone, candidate.portfolio_url]
      .filter(Boolean)
      .join(" | ");

    // ── The one approved email template ──────────────────────────────────────
    // It always opens with this sentence. Only the bullet points are tailored
    // per job; everything else is fixed wording. Any other Gmail body shape has
    // been removed, including the email_draft text the model used to produce.
    const bullets = extractBullets(job.cover_letter_html || job.cover_letter);
    if (bullets.length === 0) {
      return NextResponse.json(
        {
          error:
            "No tailored bullet points found for this job. Generate documents first so the cover letter exists.",
        },
        { status: 400 }
      );
    }

    const subject = `Application: ${job.role} - ${fullName}`;
    const emailBody = [
      `I believe I'm the perfect candidate for the ${job.role} role at ${job.company}.`,
      "",
      ...bullets.map((b) => `• ${b}`),
      "",
      "My CV, cover letter and a reference letter are attached as PDFs.",
      "",
      `Kind regards,`,
      fullName,
      contactLine,
      job.url ? `\nRole: ${job.url}` : "",
    ]
      .join("\n")
      .replace(/ [—–] /g, ", ")
      .replace(/[—–]/g, ", ")
      .trimEnd();

    // ── Attachments: PDF only, rendered server-side from the stored HTML ─────
    const companySlug = job.company.replace(/[^a-zA-Z0-9]/g, "");
    const attachments: Array<{ content: string; filename: string }> = [];

    const cvB64 = await htmlToPdfBase64(root, job.cv_html || "");
    if (cvB64) attachments.push({ content: cvB64, filename: `${companySlug}_Resume.pdf` });

    const clB64 = await htmlToPdfBase64(root, job.cover_letter_html || job.cover_letter || "");
    if (clB64) attachments.push({ content: clB64, filename: `${companySlug}_Cover_Letter.pdf` });

    const rlB64 = await htmlToPdfBase64(root, job.reference_letter || "");
    if (rlB64) attachments.push({ content: rlB64, filename: `${companySlug}_Reference_Letter.pdf` });

    if (attachments.length === 0) {
      return NextResponse.json(
        { error: "No documents could be rendered to PDF. Generate documents first." },
        { status: 400 }
      );
    }

    console.log(
      `[gmail-draft-api] Creating draft for ${job.company} with ${attachments.length} PDF attachment(s):`,
      attachments.map((a) => a.filename).join(", ")
    );

    const gmailMod = await import(/* webpackIgnore: true */ `${root}/lib/gmail-draft.mjs`);
    const draftResult = await gmailMod.createGmailDraft({
      from: fromEmail,
      to: "", // left empty on purpose: this stays a draft, never a send
      subject,
      body: emailBody,
      attachments,
    });

    if (!draftResult.success) {
      throw new Error(draftResult.error || "IMAP APPEND failed");
    }

    const draftId = draftResult.uid || "created";
    await sql`
      UPDATE job_inbox
      SET gmail_draft_id = ${draftId}, updated_at = NOW()
      WHERE id = ${jobId} AND user_id = ${userId}
    `;

    return NextResponse.json({
      ok: true,
      gmailDraftId: draftId,
      attachments: attachments.map((a) => a.filename),
    });
  } catch (err: any) {
    console.error("[POST /api/gmail/draft]", err);
    return NextResponse.json(
      { error: err.message || "Failed to create Gmail draft" },
      { status: 500 }
    );
  }
}
