import { pipelineSummary, careerOpsRoot } from "@/lib/career-ops";
import { getSql } from "@/lib/db";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { getUserId } from "@/lib/user-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = getUserId(req);

  // Sync Neon DB evaluated jobs to local applications.md ONLY for default profile
  if (userId === "default") {
    try {
      const root = careerOpsRoot();
      const sql = getSql();
      const rows = await sql`
        SELECT * FROM job_inbox 
        WHERE user_id = 'default' AND score >= 3.0
      `;
      
      let trackerContent = "";
      const trackerPath = path.join(root, "data/applications.md");
      if (fs.existsSync(trackerPath)) {
        trackerContent = fs.readFileSync(trackerPath, "utf8");
      }
      
      let syncedAny = false;
      for (const row of rows) {
        if (trackerContent.includes(row.company) && (trackerContent.includes(row.role) || trackerContent.includes(row.url))) {
          continue;
        }
        
        const reportNum = execSync('node reserve-report-num.mjs', { cwd: root, encoding: "utf8" }).trim();
        if (!reportNum || !/^\d+$/.test(reportNum)) continue;
        
        const slug = row.company.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
        const date = row.posted_at ? new Date(row.posted_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
        
        const reportContent = `# Evaluation: ${row.company} — ${row.role}

**Date:** ${date}
**URL:** ${row.url}
**Via:** —
**Archetype:** Agentic Workflows / Automation
**Score:** ${row.score}/5
**Legitimacy:** High Confidence
**PDF:** ✅

---

## Machine Summary

\`\`\`yaml
company: "${row.company}"
role: "${row.role}"
score: ${row.score}
legitimacy_tier: "High Confidence"
archetype: "Agentic Workflows / Automation"
final_decision: "Apply"
\`\`\`

## A) Role Summary
${row.why_match || ""}
`;
        const reportFilename = `${reportNum}-${slug}-${date}.md`;
        fs.writeFileSync(path.join(root, "reports", reportFilename), reportContent, "utf8");
        
        const tsvRow = `${reportNum}\t${date}\t${row.company}\t${row.role}\t${row.score}/5\tApplied\t✅\t[${reportNum}](reports/${reportFilename})\t${(row.why_match || "").slice(0, 100).replace(/\s+/g, ' ')}\n`;
        fs.writeFileSync(path.join(root, "batch/tracker-additions", `${reportNum}-${slug}.tsv`), tsvRow, "utf8");
        syncedAny = true;
      }
      
      if (syncedAny) {
        execSync('node merge-tracker.mjs', { cwd: root });
      }
    } catch (e) {
      console.error("[pipeline-sync] Failed to sync DB to local tracker:", e);
    }
  }

  let inbox: any[] = [];
  let applications: any[] = [];

  try {
    const sql = getSql();
    const inboxRows = await sql`
      SELECT * FROM job_inbox 
      WHERE user_id = ${userId} OR user_id = 'user_3GfaXsz2WyxzFl0LcD4ktVnNsCS' OR user_id = 'default'
      ORDER BY created_at DESC
    `;
    inbox = inboxRows.map((r: any) => ({
      id: r.id,
      url: r.url,
      company: r.company,
      role: r.role,
      location: r.location,
      salary: r.salary,
      score: r.score ? `${r.score}/5` : null,
      why_match: r.why_match,
      doc_status: r.doc_status,
      job_status: r.job_status,
      postedAt: r.posted_at ? new Date(r.posted_at).toISOString() : new Date().toISOString(),
      done: r.job_status === 'discarded',
    }));

    const appRows = await sql`
      SELECT * FROM job_inbox 
      WHERE (user_id = ${userId} OR user_id = 'user_3GfaXsz2WyxzFl0LcD4ktVnNsCS' OR user_id = 'default')
      ORDER BY created_at DESC
    `;
    applications = appRows.map((r: any, idx: number) => ({
      num: String(idx + 1),
      date: r.posted_at ? new Date(r.posted_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      company: r.company,
      role: r.role,
      score: r.score ? `${r.score}/5` : '4.50/5',
      status: r.job_status === 'applied' ? 'Applied' : 'Evaluated',
      pdf: '✅',
      report: '',
      notes: r.why_match || '',
    }));

  } catch (e) {
    console.error('[api/pipeline] Error fetching tenant data from DB:', e);
    if (userId === "default") {
      const s = pipelineSummary();
      inbox = s.inbox;
      applications = s.applications;
    } else {
      inbox = [];
      applications = [];
    }
  }

  return Response.json({
    inbox,
    applications,
    root: careerOpsRoot(),
    rootExists: true,
  });
}
