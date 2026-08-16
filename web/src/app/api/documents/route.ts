import { getSql } from "@/lib/db";
import { getUserId, resolveDataOwner } from "@/lib/user-context";

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
      filename = `${slug}-CV.html`;
    } else if (type === "cl") {
      content = job.cover_letter;
      filename = `${slug}-CoverLetter.html`;
    } else if (type === "rl") {
      content = job.reference_letter;
      filename = `${slug}-Reference.html`;
    }

    if (!content) {
      return new Response("Document content not found", { status: 404 });
    }

    // Return as HTML download
    return new Response(content, {
      headers: {
        "Content-Type": "text/html",
        "Content-Disposition": `attachment; filename="${filename}"`
      }
    });

  } catch (e) {
    console.error("[api/documents]", e);
    return new Response("Server error", { status: 500 });
  }
}
