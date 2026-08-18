import { getSql } from "@/lib/db";
import { getUserId, resolveDataOwner } from "@/lib/user-context";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
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
    // Human-readable download name: Ilse_Placencia_Role_Company_Type_date.pdf
    const clean = (v: string | null) => (v || "").replace(/[^a-zA-Z0-9]/g, "");
    const dateStr = new Date().toISOString().slice(0, 10);
    const niceName = (docType: string) =>
      `Ilse_Placencia_${clean(job.role)}_${clean(job.company)}_${docType}_${dateStr}.pdf`;

    if (type === "cv") {
      content = job.cv_html;
      filename = niceName("CV");
    } else if (type === "cl") {
      // Prefer the themed HTML the generator produced. `cover_letter` holds the
      // plain-text email body; rendering that as a PDF gave an unstyled page
      // that looked nothing like the pink document attached to the Gmail draft.
      content = job.cover_letter_html || wrapPlainText(job.cover_letter, job.company);
      filename = niceName("CoverLetter");
    } else if (type === "rl") {
      content = job.reference_letter;
      filename = niceName("ReferenceLetter");
    }

    if (!content) {
      return new Response("Document content not found", { status: 404 });
    }

    // Try to generate PDF on the fly
    const root = careerOpsRoot();
    // generate-pdf.mjs has a path-traversal guard that refuses to write outside
    // the repo, so the OS temp dir made every render fail and fall through to
    // the HTML branch below. Every "Download PDF" was really handing back a .html
    // file. Stage the temp files inside the repo instead.
    const tempDir = path.join(root, "output", ".pdftmp");
    fs.mkdirSync(tempDir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempHtml = path.join(tempDir, `${stamp}.html`);
    const tempPdf = path.join(tempDir, `${stamp}.pdf`);

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
      try { fs.unlinkSync(tempHtml); } catch { }
      try { fs.unlinkSync(tempPdf); } catch { }
      
      return new Response(pdfBuffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`
        }
      });
    } catch (pdfErr) {
      // Deliberately NOT falling back to HTML. Documents must download as PDF
      // only; silently serving a .html file is what hid this bug for so long.
      try { fs.unlinkSync(tempHtml); } catch { }
      try { fs.unlinkSync(tempPdf); } catch { }
      const detail = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
      console.error("[api/documents] PDF generation failed:", detail);
      return new Response(
        `Could not render this document as a PDF. ${detail}`,
        { status: 502, headers: { "Content-Type": "text/plain" } }
      );
    }

  } catch (e) {
    console.error("[api/documents]", e);
    return new Response("Server error", { status: 500 });
  }
}
