import { getSql } from "@/lib/db";
import { getUserId, resolveDataOwner } from "@/lib/user-context";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


/**
 * Present a plain-text cover letter as a styled document.
 *
 * Rows written before cover_letter_html existed only have the text body. Those
 * still deserve the accent colour and readable typography rather than a wall of
 * monospaced text, so wrap them to match the generated document.
 */
const ACCENT = "#ff8bb1";

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function wrapPlainText(text: string | null, company: string | null) {
  if (!text) return "";
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Cover Letter${
    company ? ` - ${escapeHtml(company)}` : ""
  }</title><style>
    @page { margin: 0.75in; }
    body { font: 11.5pt/1.6 Georgia, "Times New Roman", serif; color: #1a1a1a; max-width: 6.9in; }
    .rule { height: 3px; background: ${ACCENT}; margin: 0 0 22px; }
    p { margin: 0 0 12px; }
  </style></head><body><div class="rule"></div>${paras}</body></html>`;
}

export async function GET(req: Request) {
  const userId = getUserId(req);
  const owner = resolveDataOwner(userId);
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const type = url.searchParams.get("type"); // cv, cl, rl

  if (!id || !type) {
    return new Response("Missing id or type", { status: 400 });
  }

  try {
    const sql = getSql();
    const rows = await sql`SELECT company, role, cv_html, cover_letter, cover_letter_html, reference_letter FROM job_inbox WHERE id = ${id} AND user_id = ${owner}`;
    
    if (rows.length === 0) {
      return new Response("Not found", { status: 404 });
    }

    const job = rows[0];
    let content = "";
    let filename = "";
    let slug = `${job.company}-${job.role}`.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");

    if (type === "cv") {
      content = job.cv_html;
      filename = `${slug}-CV.pdf`;
    } else if (type === "cl") {
      // Prefer the themed HTML the generator produced. `cover_letter` holds the
      // plain-text email body; rendering that as a PDF gave an unstyled page
      // that looked nothing like the pink document attached to the Gmail draft.
      content = job.cover_letter_html || wrapPlainText(job.cover_letter, job.company);
      filename = `${slug}-CoverLetter.pdf`;
    } else if (type === "rl") {
      content = job.reference_letter;
      filename = `${slug}-Reference.pdf`;
    }

    if (!content) {
      return new Response("Document content not found", { status: 404 });
    }

    // Try to generate PDF on the fly
    const root = careerOpsRoot();
    const tempHtml = path.join(os.tmpdir(), `${filename}.html`);
    const tempPdf = path.join(os.tmpdir(), filename);

    try {
      fs.writeFileSync(tempHtml, content);
      await execFileAsync(
        process.execPath || "node",
        [
          path.join(root, "generate-pdf.mjs"),
          tempHtml,
          tempPdf,
          "--format=letter"
        ],
        { cwd: root, timeout: 30000, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ""}` } }
      );
      
      const pdfBuffer = fs.readFileSync(tempPdf);
      
      // Cleanup
      try { fs.unlinkSync(tempHtml); fs.unlinkSync(tempPdf); } catch(e){}
      
      return new Response(pdfBuffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`
        }
      });
    } catch (pdfErr) {
      console.warn("[api/documents] PDF generation failed, returning HTML fallback", pdfErr);
      // Fallback to HTML if PDF generation fails
      return new Response(content, {
        headers: {
          "Content-Type": "text/html",
          "Content-Disposition": `attachment; filename="${filename.replace('.pdf', '.html')}"`
        }
      });
    }

  } catch (e) {
    console.error("[api/documents]", e);
    return new Response("Server error", { status: 500 });
  }
}
