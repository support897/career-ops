import { notFound } from "next/navigation";
import { readReport, findApplication, trackerCanDelete } from "@/lib/career-ops";
import { ReportView } from "@/components/report-view";
import { getSql } from "@/lib/db";
import { getUserId } from "@/lib/user-context";

export const dynamic = "force-dynamic";

function safeYmdDate(val: any): string {
  if (!val) return new Date().toISOString().slice(0, 10);
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let app = findApplication(id);
  let report = readReport(id);
  let reportContent = report?.content ?? null;

  // Load database job for documents (cover letter, email draft, gmail draft ID)
  let dbJob: any = null;
  const userId = getUserId();
  
  try {
    const sql = getSql();
    const formattedId = id.padStart(3, "0");
    const rows = await sql`
      SELECT * 
      FROM job_inbox 
      WHERE user_id = ${userId} 
        AND (company ILIKE ${app?.company || ""} OR id = ${`00000000-0000-0000-0000-000000000${formattedId}`})
      LIMIT 1
    `;
    if (rows.length > 0) {
      dbJob = rows[0];
    }
  } catch (e) {
    console.warn("[pipeline-detail] DB fetch failed:", e);
  }

  if (!app) {
    // Database fallback for production Vercel
    try {
      const sql = getSql();
      const rows = await sql`
        SELECT * FROM job_inbox 
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
      `;
      // Find the one corresponding to the 1-based index 'id'
      const idx = parseInt(id) - 1;
      if (rows[idx]) {
        const row = rows[idx];
        const rowDate = safeYmdDate(row.posted_at);
        const rowScore = row.score ? `${row.score}/5` : "—";
        app = {
          n: id,
          date: rowDate,
          company: row.company,
          role: row.role,
          score: rowScore,
          status: row.job_status === 'applied' ? 'Applied' : 'Evaluated',
          pdf: row.doc_status === 'ready' ? '✅' : '❌',
          report: '',
          notes: row.why_match || '',
          via: '—'
        } as any;
        dbJob = row;
        
        reportContent = `# Evaluation: ${row.company} — ${row.role}
        
**Date:** ${rowDate}
**URL:** ${row.url}
**Via:** —
**Score:** ${rowScore}
**Legitimacy:** Not assessed (auto-synced from pipeline)

---

## Machine Summary
${row.why_match || ""}
`;
      }
    } catch (e) {
      console.error("[pipeline-detail] DB fallback failed:", e);
    }
  }

  if (!app) notFound();

  return (
    <ReportView 
      id={id} 
      app={app} 
      report={reportContent} 
      file={report?.file ?? null} 
      canDelete={trackerCanDelete()}
      dbCoverLetter={dbJob?.cover_letter ?? null}
      dbCvHtml={dbJob?.cv_html ?? null}
      dbEmailDraft={dbJob?.email_draft ?? null}
      dbGmailDraftId={dbJob?.gmail_draft_id ?? null}
      dbReferenceLetter={dbJob?.reference_letter ?? null}
    />
  );
}
