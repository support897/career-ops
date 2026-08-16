import { pipelineSummary, careerOpsRoot } from "@/lib/career-ops";
import { getSql } from "@/lib/db";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { getUserId, resolveDataOwner, PRINCIPAL_USER_ID, SUPPORT_WORKER_USER_ID } from "@/lib/user-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeIsoDate(val: any): string {
  if (!val) return new Date().toISOString();
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

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

export async function GET(req: Request) {
  const userId = getUserId(req);
  const owner = resolveDataOwner(userId);
  const isCareProfile = owner === SUPPORT_WORKER_USER_ID;

  // Sync evaluated DB jobs to the local tracker ONLY for the primary owner's
  // own rows. Never sync another tenant's data, and never fabricate a review:
  // the report records what actually exists (score + why_match from the AI
  // pipeline, nothing else).
  if (owner === PRINCIPAL_USER_ID) {
    try {
      const root = careerOpsRoot();
      const sql = getSql();
      const rows = await sql`
        SELECT * FROM job_inbox 
        WHERE user_id = ${owner} AND score >= 3.0
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
        const status = row.job_status === "applied" ? "Applied" : "Evaluated";

        const reportContent = `# Evaluation: ${row.company} — ${row.role}

**Date:** ${date}
**URL:** ${row.url}
**Via:** —
**Score:** ${row.score}/5
**Legitimacy:** Not assessed (auto-synced from pipeline — no review performed)
**PDF:** ❌

---

## Machine Summary

\`\`\`yaml
company: "${row.company}"
role: "${row.role}"
score: ${row.score}
legitimacy_tier: "Not assessed"
final_decision: "Pending review"
\`\`\`

## A) Role Summary
${row.why_match || ""}
`;
        const reportFilename = `${reportNum}-${slug}-${date}.md`;
        fs.writeFileSync(path.join(root, "reports", reportFilename), reportContent, "utf8");

        const notes = (row.why_match || "").slice(0, 100).replace(/\s+/g, " ");
        const tsvRow = `${reportNum}\t${date}\t${row.company}\t${row.role}\t${status}\t${row.score}/5\t❌\t[${reportNum}](reports/${reportFilename})\t${notes}\n`;
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

  // Fast local pipeline data load
  try {
    const s = pipelineSummary();
    // Care-keyword filtering belongs ONLY to the primary (tech) pipeline so the
    // support_worker tenant never sees its own roles hidden by the tech filter.
    if (!isCareProfile) {
      const careKeywords = ['support coordinator', 'disability support', 'aged care', 'care coordinator', 'kinsela care', 'hireup', 'aspect care'];
      s.applications = s.applications.filter((a: any) => {
        const lower = `${a.company} ${a.role}`.toLowerCase();
        return !careKeywords.some(k => lower.includes(k));
      });
    }
    inbox = s.inbox;
    applications = s.applications;
  } catch (e) {
    console.error('[api/pipeline] Error loading local summary:', e);
  }

  // DB query for inbox & applications
  try {
    const sql = getSql();
    const inboxRows = await sql`
      SELECT * FROM job_inbox 
      WHERE user_id = ${owner}
      ORDER BY created_at DESC
    `;
    if (inboxRows && inboxRows.length > 0) {
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
        postedAt: safeIsoDate(r.posted_at),
        done: r.job_status === 'discarded',
      }));
    }

    const appRows = await sql`
      SELECT * FROM job_inbox 
      WHERE user_id = ${owner} AND (score IS NOT NULL OR job_status != 'new' OR doc_status = 'ready')
      ORDER BY updated_at DESC
    `;
    if (appRows && appRows.length > 0) {
      const dbApps = appRows.map((r: any, idx: number) => ({
        n: String(idx + 1),
        num: String(idx + 1),
        date: safeYmdDate(r.posted_at),
        company: r.company,
        role: r.role,
        score: r.score ? `${r.score}/5` : null,
        status: r.job_status === 'applied' ? 'Applied' : (r.job_status === 'discarded' ? 'Discarded' : 'Evaluated'),
        pdf: r.doc_status === 'ready' ? '✅' : '❌',
        report: '',
        notes: r.why_match || '',
      }));

      // Combine with local applications if any, deduplicating by company + role
      const seenKey = new Set<string>();
      const combined: any[] = [];
      for (const a of [...dbApps, ...applications]) {
        const key = `${a.company.toLowerCase()}||${a.role.toLowerCase()}`;
        if (!seenKey.has(key)) {
          seenKey.add(key);
          combined.push(a);
        }
      }
      applications = combined;
    }
  } catch (e) {
    console.error('[api/pipeline] DB query error:', e);
  }

  return Response.json({
    inbox,
    applications,
    root: careerOpsRoot(),
    rootExists: true,
  });
}
