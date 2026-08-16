import { Pool, PoolConfig } from "pg";
import { resolveDataOwner } from "@/lib/user-context";

/**
 * Database layer for Careerflow cloud deployment.
 * Connects natively via pg pool to support unlimited self-hosted Postgres.
 */

export type SqlFunction = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

let pool: Pool;
let sql: SqlFunction;

export function getSql(): SqlFunction {
  if (!sql) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error(
        "DATABASE_URL is not set. Set it in web/.env.local (see .env.example) or in the platform env for production."
      );
    }
    
    const config: PoolConfig = { connectionString: dbUrl };
    pool = new Pool(config);

    sql = async function (strings: TemplateStringsArray, ...values: any[]) {
      const query = strings.reduce((prev, curr, i) => prev + "$" + i + curr);
      const res = await pool.query(query, values);
      return res.rows;
    };
  }
  return sql;
}


// ── Types ────────────────────────────────────────────────────────────

export type UserProfile = {
  id: string;
  user_id: string;
  email: string | null;
  full_name: string | null;
  location: string | null;
  timezone: string;
  scanning_enabled: boolean;
  scan_mode: 'schedule' | 'interval' | 'disabled';
  scan_frequency_hours: number;
  preferred_days: number[];
  preferred_hours: number[];
  platforms: string[];
  keywords: string[];
  location_filter: string[];
  cv_data: Record<string, unknown> | null;
  cv_markdown: string | null;
  profile_config: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  last_scan_at: Date | null;
};

export type Application = {
  id: string;
  user_id: string;
  num: string;
  date: string | null;
  company: string;
  role: string;
  score: string | null;
  status: string;
  pdf_generated: boolean;
  report_path: string | null;
  notes: string | null;
  via: string | null;
  created_at: Date;
  updated_at: Date;
};

export type InboxJob = {
  id: string;
  user_id: string;
  url: string;
  company: string;
  role: string;
  location: string | null;
  compensation: string | null;
  salary: string | null;
  apply_url: string | null;
  posted_at: string | null;
  done: boolean;
  processed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  // AI pipeline fields (from schema-v2.sql)
  score: number | null;
  score_breakdown: Record<string, number> | null;
  why_match: string | null;
  jd_text: string | null;
  cv_html: string | null;
  cover_letter: string | null;
  email_draft: string | null;
  doc_status: 'pending' | 'generating' | 'ready' | 'failed';
  job_status: 'new' | 'applied' | 'discarded';
  gmail_draft_id: string | null;
};

export type ScanHistoryEntry = {
  id: string;
  user_id: string;
  url: string;
  company: string | null;
  title: string | null;
  location: string | null;
  ats_source: string | null;
  first_seen: string;
  last_seen: string;
  created_at: Date;
};

export type ScanRun = {
  id: string;
  user_id: string;
  started_at: Date;
  completed_at: Date | null;
  users_scanned: number;
  new_offers: number;
  total_offers: number;
  errors: number;
  created_at: Date;
};

export type Report = {
  id: string;
  user_id: string;
  report_num: string;
  company_slug: string;
  report_date: string;
  content: string;
  created_at: Date;
};

export type PortalsConfig = {
  id: string;
  user_id: string;
  title_filter: { positive: string[]; negative: string[] } | null;
  location_filter: { allow: string[]; block: string[]; always_allow: string[] } | null;
  tracked_companies: Record<string, unknown>[] | null;
  created_at: Date;
  updated_at: Date;
};

// ── User Profile Operations ──────────────────────────────────────────

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM user_profiles 
    WHERE user_id = ${owner}
    ORDER BY updated_at DESC LIMIT 1
  `;
  return (rows[0] as UserProfile) || null;
}

export async function upsertUserProfile(
  userId: string,
  data: Partial<UserProfile>
): Promise<UserProfile> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    INSERT INTO user_profiles (user_id, email, full_name, location, timezone, scanning_enabled, scan_mode, scan_frequency_hours, preferred_days, preferred_hours, platforms, keywords, location_filter, cv_data, cv_markdown, profile_config)
    VALUES (
      ${owner},
      ${data.email || null},
      ${data.full_name || null},
      ${data.location || null},
      ${data.timezone || "UTC"},
      ${data.scanning_enabled ?? true},
      ${data.scan_mode || "interval"},
      ${data.scan_frequency_hours || 6},
      ${data.preferred_days || [1,2,3,4,5]},
      ${data.preferred_hours || [9,13,18]},
      ${data.platforms || []},
      ${data.keywords || []},
      ${data.location_filter || []},
      ${data.cv_data ? JSON.stringify(data.cv_data) : null}::jsonb,
      ${data.cv_markdown || null},
      ${data.profile_config ? JSON.stringify(data.profile_config) : null}::jsonb
    )
    ON CONFLICT (user_id) DO UPDATE SET
      email = COALESCE(${data.email}, user_profiles.email),
      full_name = COALESCE(${data.full_name}, user_profiles.full_name),
      location = COALESCE(${data.location}, user_profiles.location),
      timezone = ${data.timezone || "UTC"},
      scanning_enabled = ${data.scanning_enabled ?? true},
      scan_mode = ${data.scan_mode || "interval"},
      scan_frequency_hours = ${data.scan_frequency_hours || 6},
      preferred_days = ${data.preferred_days || [1,2,3,4,5]},
      preferred_hours = ${data.preferred_hours || [9,13,18]},
      platforms = ${data.platforms || []},
      keywords = ${data.keywords || []},
      location_filter = ${data.location_filter || []},
      cv_data = COALESCE(${data.cv_data ? JSON.stringify(data.cv_data) : null}::jsonb, user_profiles.cv_data),
      cv_markdown = COALESCE(${data.cv_markdown}, user_profiles.cv_markdown),
      profile_config = COALESCE(${data.profile_config ? JSON.stringify(data.profile_config) : null}::jsonb, user_profiles.profile_config),
      updated_at = NOW()
    RETURNING *
  `;
  return rows[0] as UserProfile;
}

// ── Application Operations ───────────────────────────────────────────

export async function getApplications(userId: string): Promise<Application[]> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM applications 
    WHERE user_id = ${owner}
    ORDER BY num::integer DESC
  `;
  return rows as Application[];
}

export async function getApplication(userId: string, num: string): Promise<Application | null> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM applications 
    WHERE user_id = ${owner} AND num = ${num} 
    LIMIT 1
  `;
  return (rows[0] as Application) || null;
}

export async function upsertApplication(
  userId: string,
  data: Partial<Application> & { num: string; company: string; role: string }
): Promise<Application> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    INSERT INTO applications (user_id, num, date, company, role, score, status, pdf_generated, report_path, notes, via)
    VALUES (
      ${owner},
      ${data.num},
      ${data.date || null},
      ${data.company},
      ${data.role},
      ${data.score || null},
      ${data.status || "Evaluated"},
      ${data.pdf_generated ?? false},
      ${data.report_path || null},
      ${data.notes || null},
      ${data.via || null}
    )
    ON CONFLICT (user_id, num) DO UPDATE SET
      date = COALESCE(${data.date}, applications.date),
      company = ${data.company},
      role = ${data.role},
      score = COALESCE(${data.score}, applications.score),
      status = ${data.status || "Evaluated"},
      pdf_generated = ${data.pdf_generated ?? false},
      report_path = COALESCE(${data.report_path}, applications.report_path),
      notes = COALESCE(${data.notes}, applications.notes),
      via = COALESCE(${data.via}, applications.via),
      updated_at = NOW()
    RETURNING *
  `;
  return rows[0] as Application;
}

export async function updateApplicationStatus(
  userId: string,
  num: string,
  status: string
): Promise<boolean> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const result = await sql`
    UPDATE applications SET status = ${status}, updated_at = NOW()
    WHERE user_id = ${owner} AND num = ${num}
    RETURNING id
  `;
  return result.length > 0;
}

// ── Job Inbox Operations ─────────────────────────────────────────────

export async function getInboxJobs(userId: string): Promise<InboxJob[]> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM job_inbox 
    WHERE user_id = ${owner}
    ORDER BY created_at DESC
  `;
  return rows as InboxJob[];
}


export async function addInboxJob(
  userId: string,
  job: {
    url: string;
    company: string;
    role: string;
    location?: string;
    compensation?: string;
    salary?: string;
    apply_url?: string;
    posted_at?: string;
    jd_text?: string;
  }
): Promise<InboxJob | null> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    INSERT INTO job_inbox (user_id, url, company, role, location, compensation, salary, apply_url, posted_at, jd_text, doc_status, job_status)
    VALUES (
      ${owner},
      ${job.url},
      ${job.company},
      ${job.role},
      ${job.location || null},
      ${job.compensation || null},
      ${job.salary || null},
      ${job.apply_url || job.url},
      ${job.posted_at || null},
      ${job.jd_text || null},
      'pending',
      'new'
    )
    ON CONFLICT (user_id, url) DO NOTHING
    RETURNING *
  `;
  return (rows[0] as InboxJob) || null;
}

/**
 * Update a job's AI pipeline fields (score, documents).
 * Called by the Lambda after scoring/generation.
 */
export async function updateInboxJobPipeline(
  userId: string,
  jobId: string,
  data: {
    score?: number;
    score_breakdown?: Record<string, number>;
    why_match?: string;
    cv_html?: string;
    cover_letter?: string;
    email_draft?: string;
    doc_status?: 'pending' | 'generating' | 'ready' | 'failed';
    gmail_draft_id?: string;
  }
): Promise<boolean> {
  // Validate if jobId is a valid UUID format before querying PostgreSQL
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(jobId)) {
    console.warn(`[db] Skipping updateInboxJobPipeline: invalid UUID format for jobId "${jobId}"`);
    return false;
  }

  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const result = await sql`
    UPDATE job_inbox SET
      score = COALESCE(${data.score ?? null}, score),
      score_breakdown = COALESCE(${data.score_breakdown ? JSON.stringify(data.score_breakdown) : null}::jsonb, score_breakdown),
      why_match = COALESCE(${data.why_match ?? null}, why_match),
      cv_html = COALESCE(${data.cv_html ?? null}, cv_html),
      cover_letter = COALESCE(${data.cover_letter ?? null}, cover_letter),
      email_draft = COALESCE(${data.email_draft ?? null}, email_draft),
      doc_status = ${data.doc_status ?? 'pending'},
      gmail_draft_id = COALESCE(${data.gmail_draft_id ?? null}, gmail_draft_id),
      updated_at = NOW()
    WHERE id = ${jobId} AND user_id = ${owner}
    RETURNING id
  `;
  return result.length > 0;
}

/**
 * Update a job's user-facing status (applied / discarded / new).
 */
export async function updateInboxJobStatus(
  userId: string,
  jobId: string,
  status: 'new' | 'applied' | 'discarded'
): Promise<boolean> {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(jobId)) {
    console.warn(`[db] Skipping updateInboxJobStatus: invalid UUID format for jobId "${jobId}"`);
    return false;
  }

  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const result = await sql`
    UPDATE job_inbox SET
      job_status = ${status},
      done = ${status !== 'new'},
      updated_at = NOW()
    WHERE id = ${jobId} AND user_id = ${owner}
    RETURNING id
  `;
  return result.length > 0;
}

/**
 * Get jobs by status for the jobs dashboard.
 */
export async function getInboxJobsByStatus(
  userId: string,
  status?: 'new' | 'applied' | 'discarded'
): Promise<InboxJob[]> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = status
    ? await sql`SELECT * FROM job_inbox WHERE user_id = ${owner} AND job_status = ${status} ORDER BY score DESC NULLS LAST, created_at DESC`
    : await sql`SELECT * FROM job_inbox WHERE user_id = ${owner} ORDER BY job_status ASC, score DESC NULLS LAST, created_at DESC`;
  return rows as InboxJob[];
}

export async function markInboxJobDone(userId: string, url: string): Promise<boolean> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const result = await sql`
    UPDATE job_inbox SET done = true, processed_at = NOW(), updated_at = NOW()
    WHERE user_id = ${owner} AND url = ${url}
    RETURNING id
  `;
  return result.length > 0;
}

// ── Scan History Operations ──────────────────────────────────────────

export async function getScanHistory(userId: string): Promise<ScanHistoryEntry[]> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM scan_history WHERE user_id = ${owner} ORDER BY first_seen DESC
  `;
  return rows as ScanHistoryEntry[];
}

export async function getScanDates(userId: string): Promise<Map<string, string>> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    SELECT url, first_seen FROM scan_history WHERE user_id = ${owner}
  `;
  const dates = new Map<string, string>();
  for (const row of rows) {
    const url = row.url as string;
    const firstSeen = row.first_seen as string;
    if (!dates.has(url)) {
      dates.set(url, firstSeen);
    }
  }
  return dates;
}

export async function addScanHistoryEntry(
  userId: string,
  entry: { url: string; company?: string; title?: string; location?: string; ats_source?: string }
): Promise<ScanHistoryEntry | null> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const today = new Date().toISOString().split("T")[0];
  const rows = await sql`
    INSERT INTO scan_history (user_id, url, company, title, location, ats_source, first_seen, last_seen)
    VALUES (
      ${owner},
      ${entry.url},
      ${entry.company || null},
      ${entry.title || null},
      ${entry.location || null},
      ${entry.ats_source || null},
      ${today},
      ${today}
    )
    ON CONFLICT (user_id, url) DO UPDATE SET
      last_seen = ${today},
      company = COALESCE(${entry.company || null}, scan_history.company),
      title = COALESCE(${entry.title || null}, scan_history.title),
      location = COALESCE(${entry.location || null}, scan_history.location),
      ats_source = COALESCE(${entry.ats_source || null}, scan_history.ats_source)
    RETURNING *
  `;
  return (rows[0] as ScanHistoryEntry) || null;
}

// ── Scan Run Operations ──────────────────────────────────────────────

export async function createScanRun(userId: string): Promise<ScanRun> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    INSERT INTO scan_runs (user_id, started_at)
    VALUES (${owner}, NOW())
    RETURNING *
  `;
  return rows[0] as ScanRun;
}

export async function completeScanRun(
  runId: string,
  stats: { users_scanned: number; new_offers: number; total_offers: number; errors: number }
): Promise<boolean> {
  const sql = getSql();
  const result = await sql`
    UPDATE scan_runs SET
      completed_at = NOW(),
      users_scanned = ${stats.users_scanned},
      new_offers = ${stats.new_offers},
      total_offers = ${stats.total_offers},
      errors = ${stats.errors}
    WHERE id = ${runId}
    RETURNING id
  `;
  return result.length > 0;
}

// ── Report Operations ────────────────────────────────────────────────

export async function getReports(userId: string): Promise<Report[]> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM reports WHERE user_id = ${owner} ORDER BY report_num::integer DESC
  `;
  return rows as Report[];
}

export async function getReport(userId: string, reportNum: string): Promise<Report | null> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM reports WHERE user_id = ${owner} AND report_num = ${reportNum} LIMIT 1
  `;
  return (rows[0] as Report) || null;
}

export async function upsertReport(
  userId: string,
  data: { report_num: string; company_slug: string; report_date: string; content: string }
): Promise<Report> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    INSERT INTO reports (user_id, report_num, company_slug, report_date, content)
    VALUES (
      ${owner},
      ${data.report_num},
      ${data.company_slug},
      ${data.report_date},
      ${data.content}
    )
    ON CONFLICT (user_id, report_num) DO UPDATE SET
      company_slug = ${data.company_slug},
      report_date = ${data.report_date},
      content = ${data.content}
    RETURNING *
  `;
  return rows[0] as Report;
}

// ── Portals Config Operations ────────────────────────────────────────

export async function getPortalsConfig(userId: string): Promise<PortalsConfig | null> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM portals_config WHERE user_id = ${owner} LIMIT 1
  `;
  return (rows[0] as PortalsConfig) || null;
}

export async function upsertPortalsConfig(
  userId: string,
  data: Partial<PortalsConfig>
): Promise<PortalsConfig> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const rows = await sql`
    INSERT INTO portals_config (user_id, title_filter, location_filter, tracked_companies)
    VALUES (
      ${owner},
      ${data.title_filter ? JSON.stringify(data.title_filter) : null}::jsonb,
      ${data.location_filter ? JSON.stringify(data.location_filter) : null}::jsonb,
      ${data.tracked_companies ? JSON.stringify(data.tracked_companies) : null}::jsonb
    )
    ON CONFLICT (user_id) DO UPDATE SET
      title_filter = COALESCE(${data.title_filter ? JSON.stringify(data.title_filter) : null}::jsonb, portals_config.title_filter),
      location_filter = COALESCE(${data.location_filter ? JSON.stringify(data.location_filter) : null}::jsonb, portals_config.location_filter),
      tracked_companies = COALESCE(${data.tracked_companies ? JSON.stringify(data.tracked_companies) : null}::jsonb, portals_config.tracked_companies),
      updated_at = NOW()
    RETURNING *
  `;
  return rows[0] as PortalsConfig;
}

// ── Utility Functions ────────────────────────────────────────────────

export async function deleteUser(userId: string): Promise<boolean> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  await sql`DELETE FROM reports WHERE user_id = ${owner}`;
  await sql`DELETE FROM scan_history WHERE user_id = ${owner}`;
  await sql`DELETE FROM scan_runs WHERE user_id = ${owner}`;
  await sql`DELETE FROM job_inbox WHERE user_id = ${owner}`;
  await sql`DELETE FROM applications WHERE user_id = ${owner}`;
  await sql`DELETE FROM portals_config WHERE user_id = ${owner}`;
  await sql`DELETE FROM user_profiles WHERE user_id = ${owner}`;
  return true;
}

export async function getUserStats(userId: string): Promise<{
  applications: number;
  inboxJobs: number;
  scanHistory: number;
  reports: number;
}> {
  const owner = resolveDataOwner(userId);
  const sql = getSql();
  const [appCount, inboxCount, scanCount, reportCount] = await Promise.all([
    sql`SELECT COUNT(*)::integer as count FROM applications WHERE user_id = ${owner}`,
    sql`SELECT COUNT(*)::integer as count FROM job_inbox WHERE user_id = ${owner}`,
    sql`SELECT COUNT(*)::integer as count FROM scan_history WHERE user_id = ${owner}`,
    sql`SELECT COUNT(*)::integer as count FROM reports WHERE user_id = ${owner}`,
  ]);
  return {
    applications: (appCount[0] as any).count,
    inboxJobs: (inboxCount[0] as any).count,
    scanHistory: (scanCount[0] as any).count,
    reports: (reportCount[0] as any).count,
  };
}
