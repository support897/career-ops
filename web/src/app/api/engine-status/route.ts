/**
 * /api/engine-status — real, measured state of the scanning engine.
 *
 * The dashboard's engine panel used to be hardcoded: a PID that no longer
 * existed, "Neon PostgreSQL" long after the move to self-hosted Postgres, an
 * "Active (Playwright)" form engine that has since been deleted, and a green
 * "ONLINE 24/7" badge that was literally a static string. It reported healthy
 * while the pipeline had been producing nothing for weeks.
 *
 * Everything below is derived from the database the VPS writes to. Vercel cannot
 * inspect a process on another host, so liveness is expressed the only honest
 * way available: how long ago the runner last recorded a scan.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { getUserId } from "@/lib/user-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A scan is expected hourly. Two missed hours is a real problem worth surfacing
// rather than a slow cycle.
const STALE_AFTER_MIN = 150;

export async function GET(request: NextRequest) {
  const userId = getUserId(request);
  const sql = getSql();

  try {
    const [lastRun] = await sql`
      SELECT started_at, status, total_offers, new_offers,
             filtered_title, filtered_location, dupes, errors,
             companies_scanned, boards_scanned, duration_ms, host, note
        FROM scan_runs
       ORDER BY started_at DESC
       LIMIT 1
    `;

    const [counts] = await sql`
      SELECT
        COUNT(*)                                                      AS total,
        COUNT(score)                                                  AS scored,
        COUNT(*) FILTER (WHERE score >= 4.0)                          AS ready,
        COUNT(*) FILTER (WHERE cv_html IS NOT NULL)                   AS with_documents,
        COUNT(*) FILTER (WHERE gmail_draft_id IS NOT NULL)            AS with_draft,
        COUNT(*) FILTER (WHERE job_status ILIKE 'applied')            AS applied,
        MAX(updated_at)                                               AS last_activity
      FROM job_inbox
      WHERE user_id = ${userId}
    `;

    const [runs24h] = await sql`
      SELECT COUNT(*) AS runs, COALESCE(SUM(new_offers), 0) AS added
        FROM scan_runs
       WHERE started_at > NOW() - INTERVAL '24 hours'
    `;

    const lastScanAt = lastRun?.started_at ? new Date(lastRun.started_at) : null;
    const minutesAgo = lastScanAt
      ? Math.floor((Date.now() - lastScanAt.getTime()) / 60000)
      : null;

    // Liveness cannot be judged on scans alone. A cycle deliberately SKIPS
    // discovery while a backlog is waiting — evaluating queued jobs is worth
    // more than finding new ones — so a perfectly healthy night of scoring
    // writes no scan_runs row at all. Judging on scans alone reported "stale"
    // while the pipeline was working.
    const lastActivityAt = counts?.last_activity ? new Date(counts.last_activity) : null;
    const activityMinutesAgo = lastActivityAt
      ? Math.floor((Date.now() - lastActivityAt.getTime()) / 60000)
      : null;

    // Freshest evidence of the runner doing anything at all.
    const freshest = [minutesAgo, activityMinutesAgo].filter(
      (n): n is number => typeof n === "number"
    );
    const sinceAnyWork = freshest.length ? Math.min(...freshest) : null;

    // Three states, each meaning something specific:
    //   idle    — nothing has ever run, so nothing can be claimed
    //   stale   — it ran once but nothing recently enough to be trusted as live
    //   online  — a scan OR pipeline write landed inside the expected window
    const engineState =
      sinceAnyWork === null ? "idle" : sinceAnyWork <= STALE_AFTER_MIN ? "online" : "stale";

    return NextResponse.json({
      engine: {
        state: engineState,
        lastScanAt: lastScanAt ? lastScanAt.toISOString() : null,
        minutesSinceLastScan: minutesAgo,
        staleAfterMinutes: STALE_AFTER_MIN,
        host: lastRun?.host ?? null,
        minutesSinceAnyWork: sinceAnyWork,
        lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
        // Named so nobody mistakes this for a live process check. When discovery
        // was skipped, say that rather than implying the scanner failed.
        note:
          engineState === "online"
            ? minutesAgo !== null && minutesAgo <= STALE_AFTER_MIN
              ? `Last scan ${minutesAgo} min ago on ${lastRun?.host ?? "the runner"}.`
              : `Evaluating a backlog — last pipeline write ${activityMinutesAgo} min ago, discovery paused until it drains.`
            : engineState === "stale"
              ? `No scan or pipeline activity for ${sinceAnyWork} min — the runner may be down.`
              : "Nothing has run yet.",
      },
      lastScan: lastRun
        ? {
            status: lastRun.status,
            found: Number(lastRun.total_offers ?? 0),
            added: Number(lastRun.new_offers ?? 0),
            filteredByTitle: Number(lastRun.filtered_title ?? 0),
            filteredByLocation: Number(lastRun.filtered_location ?? 0),
            duplicates: Number(lastRun.dupes ?? 0),
            errors: Number(lastRun.errors ?? 0),
            companiesScanned: Number(lastRun.companies_scanned ?? 0),
            boardsScanned: Number(lastRun.boards_scanned ?? 0),
            durationMs: lastRun.duration_ms ?? null,
            note: lastRun.note ?? null,
          }
        : null,
      last24h: {
        scanRuns: Number(runs24h?.runs ?? 0),
        jobsAdded: Number(runs24h?.added ?? 0),
      },
      pipeline: {
        total: Number(counts?.total ?? 0),
        scored: Number(counts?.scored ?? 0),
        readyToApply: Number(counts?.ready ?? 0),
        withDocuments: Number(counts?.with_documents ?? 0),
        withGmailDraft: Number(counts?.with_draft ?? 0),
        applied: Number(counts?.applied ?? 0),
        lastActivityAt: counts?.last_activity
          ? new Date(counts.last_activity).toISOString()
          : null,
      },
      database: {
        // Reported from the actual connection string rather than asserted.
        kind: /neon\.tech/i.test(process.env.DATABASE_URL ?? "")
          ? "Neon"
          : "Postgres (self-hosted)",
        connected: true,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Surface the failure instead of rendering a green badge over it.
    return NextResponse.json(
      { error: message, engine: { state: "unknown", note: `Status unavailable: ${message}` } },
      { status: 500 }
    );
  }
}
