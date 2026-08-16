import { notFound } from "next/navigation";
import { readReport, findApplication, trackerCanDelete } from "@/lib/career-ops";
import { ReportView } from "@/components/report-view";
import { getSql } from "@/lib/db";
import { getUserId } from "@/lib/user-context";

import { headers } from "next/headers";

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
  let app: any = null;
  let reportContent: string | null = null;
  let reportFile: string | null = null;
  let dbJob: any = null;
  const hdrs = await headers();
  const userId = getUserId({ headers: { get: (k: string) => hdrs.get(k) } });
  const sql = getSql();

  // 1. Try querying by direct UUID from database first
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (isUuid) {
    try {
      const rows = await sql`
        SELECT * FROM job_inbox 
        WHERE user_id = ${userId} AND id::text = ${id}
        LIMIT 1
      `;
      if (rows.length > 0) {
        dbJob = rows[0];
        const rowDate = safeYmdDate(dbJob.posted_at);
        const rowScore = dbJob.score ? `${dbJob.score}/5` : "—";
        app = {
          id: dbJob.id,
          n: id,
          date: rowDate,
          company: dbJob.company,
          role: dbJob.role,
          score: rowScore,
          status: dbJob.job_status === 'applied' ? 'Applied' : (dbJob.job_status === 'discarded' ? 'Discarded' : 'Evaluated'),
          pdf: dbJob.doc_status === 'ready' ? '✅' : '❌',
          report: '',
          notes: dbJob.why_match || '',
          via: '—'
        };

        reportContent = `# Evaluation: ${dbJob.company} — ${dbJob.role}

**Date:** ${rowDate}
**URL:** ${dbJob.url}
**Via:** —
**Score:** ${rowScore}
**Legitimacy:** Not assessed (auto-synced from pipeline)

---

## Machine Summary
${dbJob.why_match || ""}
`;
      }
    } catch (e) {
      console.warn("[pipeline-detail] UUID lookup failed:", e);
    }
  }

  // 2. If not found by UUID, try local applications list (filesystem check)
  if (!app) {
    app = findApplication(id);
    const report = readReport(id);
    reportContent = report?.content ?? null;
    reportFile = report?.file ?? null;

    if (app) {
      try {
        const rows = await sql`
          SELECT * FROM job_inbox 
          WHERE user_id = ${userId} AND company ILIKE ${app.company}
          LIMIT 1
        `;
        if (rows.length > 0) dbJob = rows[0];
      } catch (e) {}
    }
  }

  // 3. Fallback: indexed lookup on database rows
  if (!app) {
    try {
      const rows = await sql`
        SELECT * FROM job_inbox 
        WHERE user_id = ${userId} AND (score IS NOT NULL OR job_status != 'new' OR doc_status = 'ready')
        ORDER BY updated_at DESC
      `;
      const idx = parseInt(id) - 1;
      if (rows[idx]) {
        dbJob = rows[idx];
        const rowDate = safeYmdDate(dbJob.posted_at);
        const rowScore = dbJob.score ? `${dbJob.score}/5` : "—";
        app = {
          id: dbJob.id,
          n: id,
          date: rowDate,
          company: dbJob.company,
          role: dbJob.role,
          score: rowScore,
          status: dbJob.job_status === 'applied' ? 'Applied' : (dbJob.job_status === 'discarded' ? 'Discarded' : 'Evaluated'),
          pdf: dbJob.doc_status === 'ready' ? '✅' : '❌',
          report: '',
          notes: dbJob.why_match || '',
          via: '—'
        };

        reportContent = `# Evaluation: ${dbJob.company} — ${dbJob.role}

**Date:** ${rowDate}
**URL:** ${dbJob.url}
**Via:** —
**Score:** ${rowScore}
**Legitimacy:** Not assessed (auto-synced from pipeline)

---

## Machine Summary
${dbJob.why_match || ""}
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
      file={reportFile} 
      canDelete={trackerCanDelete()}
      dbCoverLetter={dbJob?.cover_letter ?? null}
      dbCvHtml={dbJob?.cv_html ?? null}
      dbEmailDraft={dbJob?.email_draft ?? null}
      dbGmailDraftId={dbJob?.gmail_draft_id ?? null}
      dbReferenceLetter={dbJob?.reference_letter ?? null}
      dbGenerationMethod={dbJob?.generation_method ?? 'keyword'}
    />
  );
}
