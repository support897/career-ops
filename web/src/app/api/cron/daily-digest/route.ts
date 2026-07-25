import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { join } from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function validateCronAuth(request: Request): boolean {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  if (authHeader === `Bearer ${cronSecret}`) return true;
  const vercelCron = request.headers.get("x-vercel-cron");
  if (vercelCron) return true;
  return false;
}

function buildScanRows(jobs: any[]): string {
  return jobs
    .map(
      (j) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;">
        <div style="font-size:14px;font-weight:600;color:#1a1a2e;">${esc(j.company)} — ${esc(j.title)}</div>
        <div style="font-size:12px;color:#888;margin-top:3px;">
          📍 ${esc(j.location || "Remote")} · ${esc(j.platform || "unknown")}
          ${j.url ? ` · <a href="${esc(j.url)}" style="color:hsl(187,74%,32%);text-decoration:none;">View →</a>` : ""}
        </div>
      </td>
    </tr>`
    )
    .join("");
}

function buildPortalTags(portals: any[]): string {
  return portals
    .map(
      (p) =>
        `<span style="display:inline-block;padding:3px 8px;margin:2px 4px 2px 0;background-color:#f0f0f0;border-radius:4px;font-size:12px;color:#555;">${esc(p.platform)} <strong>${p.cnt}</strong></span>`
    )
    .join("");
}

function buildPipelineCells(statuses: Record<string, number>): string {
  const order = ["Evaluated", "Applied", "Responded", "Interview", "Offer", "Rejected"];
  const colors: Record<string, string> = {
    Evaluated: "#555",
    Applied: "hsl(187,74%,32%)",
    Responded: "hsl(270,70%,45%)",
    Interview: "hsl(26,73%,51%)",
    Offer: "hsl(140,50%,35%)",
    Rejected: "#cc4444",
  };
  return order
    .filter((s) => (statuses[s] || 0) > 0)
    .map(
      (s) =>
        `<td style="padding:8px 10px;text-align:center;background-color:#f7f6f3;border-radius:6px;">
          <div style="font-size:20px;font-weight:700;color:${colors[s] || "#555"};line-height:1;">${statuses[s]}</div>
          <div style="font-size:10px;color:#999;margin-top:3px;text-transform:uppercase;letter-spacing:0.5px;">${s}</div>
        </td>`
    )
    .join('<td width="6"></td>');
}

function buildFollowupRows(followups: any[]): string {
  return followups
    .map(
      (f) => `
    <div style="padding:10px 12px;margin-bottom:6px;background-color:#fef3f0;border-left:3px solid hsl(0,70%,55%);border-radius:0 6px 6px 0;">
      <div style="font-size:13px;font-weight:600;color:#1a1a2e;">#${f.num} ${esc(f.company)} — ${esc(f.role)}</div>
      <div style="font-size:12px;color:#888;margin-top:2px;">
        Applied ${esc(f.appliedDate || "unknown")} · ${f.daysSinceApplication || "?"} days ago · <span style="color:hsl(0,70%,55%);font-weight:600;">${esc(f.urgency?.toUpperCase() || "DUE")}</span>
      </div>
    </div>`
    )
    .join("");
}

function buildScoredRows(jobs: any[]): string {
  return jobs
    .map(
      (j) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">
        <div style="font-size:13px;font-weight:600;color:#1a1a2e;">
          ${esc(j.company)} — ${esc(j.title)}
          <span style="display:inline-block;padding:2px 6px;margin-left:6px;background-color:hsl(140,50%,92%);color:hsl(140,50%,30%);border-radius:4px;font-size:11px;font-weight:700;">${esc(j.score)}</span>
        </div>
        ${j.url ? `<div style="font-size:11px;margin-top:2px;"><a href="${esc(j.url)}" style="color:hsl(187,74%,32%);text-decoration:none;">View →</a></div>` : ""}
      </td>
    </tr>`
    )
    .join("");
}

function esc(s: any): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmailHtml(template: string, data: Record<string, any>): string {
  let html = template;

  // Simple {{VAR}} replacement
  for (const [key, val] of Object.entries(data)) {
    if (key.endsWith("_HTML") || key.endsWith("_CELLS") || key.endsWith("_TAGS")) continue;
    html = html.split(`{{${key}}}`).join(String(val ?? ""));
  }

  // {{#if VAR}}...{{/if}} blocks
  html = html.replace(
    /\{\{#if ([A-Z_]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key, block) => {
      const val = data[key];
      if (Array.isArray(val)) return val.length > 0 ? block : "";
      if (typeof val === "number") return val > 0 ? block : "";
      return val ? block : "";
    }
  );

  // Pre-built HTML blocks
  html = html.replace("{{SCANS_HTML}}", data.SCANS_HTML || "");
  html = html.replace("{{PORTALS_HTML}}", data.PORTALS_HTML || "");
  html = html.replace("{{PIPELINE_CELLS}}", data.PIPELINE_CELLS || "");
  html = html.replace("{{FOLLOWUPS_HTML}}", data.FOLLOWUPS_HTML || "");
  html = html.replace("{{EMAILS_HTML}}", data.EMAILS_HTML || "");
  html = html.replace("{{SCORED_HTML}}", data.SCORED_HTML || "");

  return html;
}

export async function GET(request: Request) {
  if (!validateCronAuth(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sql = neon(process.env.DATABASE_URL!);
  const VIP_USER_ID = "user_3GfaXsz2WyxzFl0LcD4ktVnNsCS";

  try {
    console.log("[Daily Digest] Starting");

    // ─── 0. Time guard: only send after 4pm Brisbane (prevents eating daily slot before 6pm cron) ───
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "true";
    const brisbaneNow = new Date().toLocaleString("en-US", { timeZone: "Australia/Brisbane", hour: "numeric", hour12: false });
    const guardHour = parseInt(brisbaneNow);
    if (guardHour < 16 && !force) {
      console.log(`[Daily Digest] Too early (${guardHour}:00 Brisbane), waits until 16:00`);
      return NextResponse.json({ success: true, message: "Too early, waits until 4pm Brisbane" });
    }

    // ─── 1. Check VIP ───
    const userCheck = await sql`SELECT vip FROM users WHERE id = ${VIP_USER_ID}`;
    if (!userCheck.length || !userCheck[0].vip) {
      console.log("[Daily Digest] User is not VIP, skipping");
      return NextResponse.json({ success: true, message: "Not VIP" });
    }

    // ─── 2. Claim today's slot atomically (race-proof: exactly one email per day) ───
    const [claimed] = await sql`INSERT INTO daily_digest_log (sent_date) VALUES (CURRENT_DATE) ON CONFLICT (sent_date) DO NOTHING RETURNING id`;
    if (!claimed) {
      console.log("[Daily Digest] Already sent today, skipping");
      return NextResponse.json({ success: true, message: "Already sent today" });
    }
    const claimId = claimed.id;

    // ─── 3. Query all data ───
    const [scansToday, portals, scoredToday, coverLettersToday] = await Promise.all([
      sql`SELECT title, company, platform, location, url FROM jobs WHERE user_id = ${VIP_USER_ID} AND created_at::date = CURRENT_DATE ORDER BY created_at DESC LIMIT 10`,
      sql`SELECT platform, COUNT(*)::int as cnt FROM jobs WHERE user_id = ${VIP_USER_ID} AND created_at::date = CURRENT_DATE GROUP BY platform ORDER BY cnt DESC`,
      sql`SELECT title, company, score, url FROM jobs WHERE user_id = ${VIP_USER_ID} AND created_at::date = CURRENT_DATE AND score IS NOT NULL ORDER BY score DESC LIMIT 5`,
      sql`SELECT COUNT(*)::int as cnt FROM jobs WHERE user_id = ${VIP_USER_ID} AND created_at::date = CURRENT_DATE AND cover_letter IS NOT NULL`,
    ]);

    const [totalScansToday] = await sql`SELECT COUNT(*)::int as cnt FROM jobs WHERE user_id = ${VIP_USER_ID} AND created_at::date = CURRENT_DATE`;

    // Pipeline status counts
    const pipelineRows = await sql`SELECT status, COUNT(*)::int as cnt FROM applications WHERE user_id = ${VIP_USER_ID} GROUP BY status`;
    const pipelineStatuses: Record<string, number> = {};
    let pipelineTotal = 0;
    let activeCount = 0;
    for (const row of pipelineRows) {
      pipelineStatuses[row.status] = row.cnt;
      pipelineTotal += row.cnt;
      if (["Applied", "Responded", "Interview", "Offer"].includes(row.status)) {
        activeCount += row.cnt;
      }
    }

    // Inbox count
    const [inboxRow] = await sql`SELECT COUNT(*)::int as cnt FROM job_inbox WHERE user_id = ${VIP_USER_ID} AND done = false`;

    // Follow-ups (run script)
    let followups: any[] = [];
    try {
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync("node", [
        join(process.cwd(), "..", "followup-cadence.mjs"),
        "--json",
      ], { timeout: 30000, cwd: join(process.cwd(), "..") });
      const cadenceData = JSON.parse(stdout);
      followups = (cadenceData.entries || [])
        .filter((e: any) => /overdue|urgent/i.test(e.urgency))
        .slice(0, 5);
    } catch (e) {
      console.log("[Daily Digest] Follow-up cadence skipped:", (e as Error).message?.substring(0, 80));
    }

    // ─── 4. Build email ───
    const now = new Date();
    const brisbaneStr = now.toLocaleDateString("en-AU", {
      timeZone: "Australia/Brisbane",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const brisbaneHour = parseInt(
      new Date(now.toLocaleString("en-US", { timeZone: "Australia/Brisbane" }))
        .toLocaleTimeString("en-US", { hour: "2-digit", hour12: false })
    );
    const timeOfDay = brisbaneHour < 12 ? "morning" : brisbaneHour < 17 ? "afternoon" : "evening";

    const totalScanned = totalScansToday?.cnt ?? 0;
    const emailsSent = coverLettersToday[0].cnt;
    const evaluated = pipelineStatuses["Evaluated"] || 0;

    // Preheader
    const preheader = `${totalScanned} new scans · ${activeCount} active apps · ${followups.length} follow-ups due`;

    // Load template
    let template: string;
    try {
      template = readFileSync(join(process.cwd(), "templates", "daily-digest.html"), "utf-8");
    } catch {
      template = readFileSync(join(process.cwd(), "..", "templates", "daily-digest.html"), "utf-8");
    }

    const templateData: Record<string, any> = {
      PREHEADER: preheader,
      DATE: brisbaneStr,
      TIME_OF_DAY: timeOfDay,
      STAT_SCANNED: totalScanned,
      STAT_APPLIED: pipelineStatuses["Applied"] || 0,
      STAT_EVALUATED: evaluated,
      STAT_ACTIVE: activeCount,
      STAT_INBOX: inboxRow?.cnt || 0,
      SCANS: scansToday,
      SCANS_TOTAL: totalScanned,
      SCANS_MORE: totalScansToday.cnt > 10,
      PORTAL_COUNT: portals.length,
      PORTALS: portals,
      PIPELINE_TOTAL: pipelineTotal,
      FOLLOWUPS: followups,
      SCORED: scoredToday,
      ALL_EMPTY: totalScanned === 0 && activeCount === 0 && followups.length === 0,
      SCANS_HTML: scansToday.length > 0 ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;">${buildScanRows(scansToday)}</table>` : "",
      PORTALS_HTML: buildPortalTags(portals),
      PIPELINE_CELLS: buildPipelineCells(pipelineStatuses),
      PIPELINE_SUMMARY: activeCount > 0 ? `${activeCount} application${activeCount > 1 ? "s" : ""} in flight` : "No active applications yet",
      FOLLOWUPS_HTML: followups.length > 0 ? buildFollowupRows(followups) : '<div style="font-size:13px;color:#888;padding:8px 0;">All caught up — no follow-ups due.</div>',
      EMAILS_SECTION: emailsSent > 0,
      EMAILS_HTML: `<div style="font-size:13px;color:#555;line-height:1.8;">${emailsSent} cover letter${emailsSent > 1 ? "s" : ""} generated today.<br>0 emails sent (cloud scan mode).</div>`,
      SCORED_HTML: scoredToday.length > 0 ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${buildScoredRows(scoredToday)}</table>` : "",
      EMAIL: "placenciailse@gmail.com",
    };

    const html = buildEmailHtml(template, templateData);

    // ─── 5. Send email ───
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SMTP_USER || "placenciailse@gmail.com",
        pass: process.env.SMTP_PASS || "",
      },
      connectionTimeout: 10000,
      greetingTimeout: 5000,
      socketTimeout: 15000,
    });

    const info = await transporter.sendMail({
      from: `"Ilse Placencia" <${process.env.SMTP_USER || "placenciailse@gmail.com"}>`,
      to: "placenciailse@gmail.com",
      subject: `[Careerflow Daily] ${brisbaneStr} — ${totalScanned} scans, ${activeCount} active`,
      html,
    });

    console.log(`[Daily Digest] Email sent: ${info.messageId}`);

    // ─── 6. Record message_id in digest log ───
    await sql`UPDATE daily_digest_log SET message_id = ${info.messageId} WHERE id = ${claimId}`;

    return NextResponse.json({
      success: true,
      messageId: info.messageId,
      stats: {
        scansToday: totalScanned,
        activeApps: activeCount,
        followupsDue: followups.length,
        portals: portals.length,
        scored: scoredToday.length,
      },
    });
  } catch (error) {
    console.error("[Daily Digest] Fatal error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "unknown" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
