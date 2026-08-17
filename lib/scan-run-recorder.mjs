/**
 * scan-run-recorder.mjs — record every scan run in Postgres.
 *
 * The scan already appended a row to data/scan-runs.tsv, but that file lives
 * only on the VPS, so the hosted dashboard could never see it: the scan_runs
 * table sat at 0 rows while scans ran hourly. This writes the same funnel to
 * Postgres so both dashboards can show an honest "last scan" status, including
 * WHY a run added nothing.
 *
 * Deliberately best-effort: a database hiccup must never fail a scan that
 * otherwise succeeded, so every error is caught and logged, never thrown.
 */
import { hostname } from 'os';

export async function recordScanRun({
  userId = process.env.VIP_USER_ID || 'default',
  startedAt,
  completedAt = new Date(),
  status = 'completed',
  companies = 0,
  boards = 0,
  found = 0,
  newAdded = 0,
  filteredTitle = 0,
  filteredLocation = 0,
  filteredOther = 0,
  dupes = 0,
  errors = 0,
  note = null,
} = {}) {
  if (!process.env.DATABASE_URL) return { recorded: false, reason: 'no DATABASE_URL' };

  try {
    const { sqlClient } = await import('./sql.mjs');
    const sql = sqlClient();
    const started = startedAt ? new Date(startedAt) : new Date(completedAt);
    const durationMs = Math.max(0, new Date(completedAt) - started);

    await sql`
      INSERT INTO scan_runs (
        user_id, started_at, completed_at, status,
        users_scanned, companies_scanned, boards_scanned,
        total_offers, new_offers,
        filtered_title, filtered_location, filtered_other, dupes,
        errors, duration_ms, host, note
      ) VALUES (
        ${userId}, ${started.toISOString()}, ${new Date(completedAt).toISOString()}, ${status},
        ${1}, ${companies}, ${boards},
        ${found}, ${newAdded},
        ${filteredTitle}, ${filteredLocation}, ${filteredOther}, ${dupes},
        ${errors}, ${durationMs}, ${hostname()}, ${note}
      )
    `;
    return { recorded: true };
  } catch (err) {
    console.error(`   ⚠️  could not record scan run in Postgres: ${err.message}`);
    return { recorded: false, reason: err.message };
  }
}

export default recordScanRun;
