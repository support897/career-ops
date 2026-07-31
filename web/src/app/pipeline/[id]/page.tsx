import { notFound } from "next/navigation";
import { readReport, findApplication, trackerCanDelete } from "@/lib/career-ops";
import { ReportView } from "@/components/report-view";
import { getSql } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const app = findApplication(id);
  const report = readReport(id);
  if (!app && !report) notFound();

  // Load database job for documents (cover letter, email draft, gmail draft ID)
  let dbJob: any = null;
  try {
    const sql = getSql();
    const formattedId = id.padStart(3, "0");
    const rows = await sql`
      SELECT cv_html, cover_letter, email_draft, gmail_draft_id, reference_letter 
      FROM job_inbox 
      WHERE user_id = 'default' 
        AND (company ILIKE ${app?.company || ""} OR id = ${`00000000-0000-0000-0000-000000000${formattedId}`})
      LIMIT 1
    `;
    if (rows.length > 0) {
      dbJob = rows[0];
    }
  } catch (e) {
    console.warn("[pipeline-detail] DB fetch failed:", e);
  }

  return (
    <ReportView 
      id={id} 
      app={app} 
      report={report?.content ?? null} 
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
