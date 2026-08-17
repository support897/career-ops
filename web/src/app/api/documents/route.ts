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
    const rows = await sql`SELECT company, role, cv_html, cover_letter, reference_letter FROM job_inbox WHERE id = ${id} AND user_id = ${owner}`;
    
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
      content = job.cover_letter;
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
