#!/usr/bin/env node
/**
 * daily-digest.mjs — one branded email per day, at 18:00 Australia/Brisbane.
 *
 * Replaces the per-cycle plain-markdown report that auto-apply.mjs used to email
 * at the end of every 15-minute cycle (~96 messages a day). Everything here is
 * read from Postgres, which is the authoritative record, plus the day's cycle
 * report files in output/ for scan counts.
 *
 * Run:  node daily-digest.mjs            (send)
 *       node daily-digest.mjs --dry-run  (print HTML to stdout, send nothing)
 *       node daily-digest.mjs --to=x@y   (override recipient)
 */

import { readFileSync, existsSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import nodemailer from "nodemailer";
import yaml from "js-yaml";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry-run");
const toArg = process.argv.find((a) => a.startsWith("--to="));

// --- config -----------------------------------------------------------------
function loadEnv() {
  const f = join(ROOT, ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/^["']|["']$/g, "");
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv();

const emailCfg = existsSync(join(ROOT, "config/email.yml"))
  ? yaml.load(readFileSync(join(ROOT, "config/email.yml"), "utf8")) || {}
  : {};
const profile = existsSync(join(ROOT, "config/profile.yml"))
  ? yaml.load(readFileSync(join(ROOT, "config/profile.yml"), "utf8")) || {}
  : {};

const ACCENT = profile?.style?.accent_color || "#ff8bb1";
const RECIPIENT = toArg ? toArg.slice(5) : emailCfg?.report?.to || process.env.GMAIL_USER;
const DASHBOARD = process.env.DASHBOARD_URL || "https://107.175.88.18";
const TZ = "Australia/Brisbane";

const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
const prettyDate = new Date().toLocaleDateString("en-AU", {
  timeZone: TZ, weekday: "long", day: "numeric", month: "long",
});

// --- data -------------------------------------------------------------------
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const [totals] = await q(`
  SELECT
    COUNT(*)::int                                                      AS total,
    COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'Australia/Brisbane')::date = (now() AT TIME ZONE 'Australia/Brisbane')::date)::int       AS new_today,
    COUNT(*) FILTER (WHERE score IS NOT NULL)::int                     AS scored,
    COUNT(*) FILTER (WHERE score IS NULL)::int                         AS unscored,
    COUNT(*) FILTER (WHERE score >= 4)::int                            AS strong,
    COUNT(*) FILTER (WHERE score >= 4 AND (created_at AT TIME ZONE 'Australia/Brisbane')::date = (now() AT TIME ZONE 'Australia/Brisbane')::date)::int AS strong_today,
    COUNT(*) FILTER (WHERE score >= 4 AND doc_status = 'ready'
                       AND job_status = 'evaluated')::int              AS ready_now,
    COUNT(*) FILTER (WHERE gmail_draft_id IS NOT NULL)::int            AS drafts,
    COUNT(*) FILTER (WHERE job_status = 'applied')::int                AS applied_total,
    COUNT(*) FILTER (WHERE (applied_at AT TIME ZONE 'Australia/Brisbane')::date = (now() AT TIME ZONE 'Australia/Brisbane')::date)::int       AS applied_today
  FROM job_inbox`);

const ready = await q(`
  SELECT company, role, score, url, gmail_draft_id
  FROM job_inbox
  WHERE score >= 4 AND doc_status = 'ready' AND job_status = 'evaluated'
  ORDER BY score DESC, company LIMIT 25`);

const appliedToday = await q(`
  SELECT company, role, score FROM job_inbox
  WHERE (applied_at AT TIME ZONE 'Australia/Brisbane')::date = (now() AT TIME ZONE 'Australia/Brisbane')::date ORDER BY score DESC`);

const newBest = await q(`
  SELECT company, role, score, url FROM job_inbox
  WHERE (created_at AT TIME ZONE 'Australia/Brisbane')::date = (now() AT TIME ZONE 'Australia/Brisbane')::date AND score IS NOT NULL
  ORDER BY score DESC LIMIT 8`);

// Scan counts come from the cycle report files the worker writes each run.
let cyclesToday = 0, scannedToday = 0;
try {
  const f = join(ROOT, "output", `daily-report-${today}.md`);
  if (existsSync(f)) {
    const txt = readFileSync(f, "utf8");
    const m = txt.match(/\*\*Jobs scanned:\*\*\s*(\d+)/);
    if (m) scannedToday = parseInt(m[1], 10);
  }
  cyclesToday = readdirSync(join(ROOT, "output"))
    .filter((n) => n === `daily-report-${today}.md`).length;
} catch {}

await pool.end();

// --- render -----------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const scorePill = (s) => {
  const v = Number(s);
  const bg = v >= 4.5 ? "#ecfdf5" : v >= 4.2 ? "#f0fdf4" : "#fff7ed";
  const fg = v >= 4.2 ? "#15803d" : "#b45309";
  return `<span style="display:inline-block;background:${bg};color:${fg};border-radius:20px;
    padding:2px 9px;font-size:12px;font-weight:700;white-space:nowrap">${v.toFixed(2)}</span>`;
};

const stat = (v, l, accent = false) => `
  <td style="padding:14px 16px;background:#ffffff;border:1px solid #eee6e0;border-radius:10px;
      text-align:center;width:25%">
    <div style="font:700 27px Georgia,serif;color:${accent ? ACCENT : "#1c1a19"};line-height:1.1">${v}</div>
    <div style="font-size:11.5px;color:#7a736d;margin-top:3px;line-height:1.35">${l}</div>
  </td>`;

const readyRows = ready.map((r) => `
  <tr>
    <td style="padding:11px 12px;border-bottom:1px solid #f0ebe5">
      <div style="font-weight:600;color:#1c1a19;font-size:14.5px">${esc(r.company)}</div>
      <div style="color:#7a736d;font-size:13px;margin-top:1px">${esc(r.role)}</div>
    </td>
    <td style="padding:11px 8px;border-bottom:1px solid #f0ebe5;text-align:right;white-space:nowrap">
      ${scorePill(r.score)}
    </td>
    <td style="padding:11px 12px;border-bottom:1px solid #f0ebe5;text-align:right;white-space:nowrap">
      ${r.url ? `<a href="${esc(r.url)}" style="color:${ACCENT};font-size:13px;font-weight:600;text-decoration:none">Job&nbsp;&rsaquo;</a>` : `<span style="color:#b8b0a9;font-size:13px">no link</span>`}
      ${r.gmail_draft_id ? `<span style="color:#15803d;font-size:11px;margin-left:8px">draft&nbsp;ready</span>` : `<span style="color:#b45309;font-size:11px;margin-left:8px">no&nbsp;draft</span>`}
    </td>
  </tr>`).join("");

const appliedRows = appliedToday.length
  ? appliedToday.map((r) => `
      <tr><td style="padding:8px 12px;border-bottom:1px solid #f0ebe5;font-size:14px;color:#3b3734">
        <strong style="color:#1c1a19">${esc(r.company)}</strong> — ${esc(r.role)}
      </td></tr>`).join("")
  : `<tr><td style="padding:10px 12px;color:#7a736d;font-size:14px">
       Nothing marked applied today.</td></tr>`;

const newRows = newBest.length
  ? newBest.map((r) => `
      <tr>
        <td style="padding:9px 12px;border-bottom:1px solid #f0ebe5;font-size:14px">
          ${r.url ? `<a href="${esc(r.url)}" style="color:#1c1a19;text-decoration:none;font-weight:600">${esc(r.company)}</a>` : `<strong>${esc(r.company)}</strong>`}
          <span style="color:#7a736d"> — ${esc(r.role)}</span>
        </td>
        <td style="padding:9px 12px;border-bottom:1px solid #f0ebe5;text-align:right">${scorePill(r.score)}</td>
      </tr>`).join("")
  : `<tr><td style="padding:10px 12px;color:#7a736d;font-size:14px">No new scored jobs today.</td></tr>`;

const alerts = [];
if (totals.unscored > 0)
  alerts.push(`<strong>${totals.unscored}</strong> jobs still waiting to be scored — the free AI tier throttles this, so it drains over a few days.`);
if (totals.ready_now > 0 && totals.drafts < totals.ready_now)
  alerts.push(`<strong>${totals.ready_now - totals.drafts}</strong> ready-to-apply jobs don't have a Gmail draft yet.`);

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Career Ops — ${prettyDate}</title></head>
<body style="margin:0;padding:0;background:#faf7f3;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#3b3734">
<div style="display:none;max-height:0;overflow:hidden">${totals.ready_now} ready to submit · ${totals.new_today} new jobs found today</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7f3">
<tr><td align="center" style="padding:26px 14px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%">

  <!-- header -->
  <tr><td style="padding:0 0 18px">
    <div style="height:4px;background:${ACCENT};border-radius:4px;margin-bottom:16px"></div>
    <div style="font:11px/1 -apple-system,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#918a84">
      Career Ops · Daily
    </div>
    <div style="font:600 27px/1.2 Georgia,serif;color:#1c1a19;margin-top:7px">${prettyDate}</div>
    <div style="font-size:14.5px;color:#6b6560;margin-top:6px">
      ${totals.ready_now > 0
        ? `<strong style="color:#1c1a19">${totals.ready_now} job${totals.ready_now === 1 ? "" : "s"} ready to submit</strong> right now, documents and drafts already prepared.`
        : `Nothing is ready to submit right now — the scanner is still working through the queue.`}
    </div>
  </td></tr>

  <!-- numbers -->
  <tr><td style="padding:0 0 8px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>
      ${stat(totals.new_today, "found today")}
      ${stat(totals.strong_today, "scored 4+ today")}
      ${stat(totals.ready_now, "ready to submit", true)}
      ${stat(totals.applied_total, "applied to date")}
    </tr></table>
  </td></tr>

  <!-- ready to submit -->
  <tr><td style="padding:22px 0 0">
    <div style="font:600 19px/1.3 Georgia,serif;color:#1c1a19;margin-bottom:4px">Ready to submit</div>
    <div style="font-size:13px;color:#7a736d;margin-bottom:10px">
      Scored 4.0 or higher with a tailored CV, cover letter and reference letter already generated.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:#fff;border:1px solid #eee6e0;border-radius:10px;border-collapse:separate;overflow:hidden">
      ${readyRows || `<tr><td style="padding:14px 12px;color:#7a736d;font-size:14px">Nothing ready at the moment.</td></tr>`}
    </table>
    <div style="text-align:center;padding:16px 0 0">
      <a href="${DASHBOARD}/pipeline?tab=READY_TO_APPLY"
        style="display:inline-block;background:${ACCENT};color:#fff;text-decoration:none;
        font-size:14px;font-weight:700;padding:12px 26px;border-radius:8px">Open the pipeline</a>
    </div>
  </td></tr>

  <!-- applied today -->
  <tr><td style="padding:26px 0 0">
    <div style="font:600 19px/1.3 Georgia,serif;color:#1c1a19;margin-bottom:8px">
      Applied today${appliedToday.length ? ` · ${appliedToday.length}` : ""}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:#fff;border:1px solid #eee6e0;border-radius:10px">${appliedRows}</table>
  </td></tr>

  <!-- new today -->
  <tr><td style="padding:26px 0 0">
    <div style="font:600 19px/1.3 Georgia,serif;color:#1c1a19;margin-bottom:8px">Best of today's new finds</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:#fff;border:1px solid #eee6e0;border-radius:10px">${newRows}</table>
  </td></tr>

  <!-- pipeline -->
  <tr><td style="padding:26px 0 0">
    <div style="font:600 19px/1.3 Georgia,serif;color:#1c1a19;margin-bottom:8px">Where everything stands</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:#fff;border:1px solid #eee6e0;border-radius:10px;font-size:14px">
      <tr><td style="padding:9px 14px;border-bottom:1px solid #f0ebe5;color:#6b6560">Jobs tracked in total</td>
          <td style="padding:9px 14px;border-bottom:1px solid #f0ebe5;text-align:right;font-weight:600">${totals.total}</td></tr>
      <tr><td style="padding:9px 14px;border-bottom:1px solid #f0ebe5;color:#6b6560">Scored so far</td>
          <td style="padding:9px 14px;border-bottom:1px solid #f0ebe5;text-align:right;font-weight:600">${totals.scored}</td></tr>
      <tr><td style="padding:9px 14px;border-bottom:1px solid #f0ebe5;color:#6b6560">Waiting to be scored</td>
          <td style="padding:9px 14px;border-bottom:1px solid #f0ebe5;text-align:right;font-weight:600">${totals.unscored}</td></tr>
      <tr><td style="padding:9px 14px;border-bottom:1px solid #f0ebe5;color:#6b6560">Strong matches (4.0+)</td>
          <td style="padding:9px 14px;border-bottom:1px solid #f0ebe5;text-align:right;font-weight:600">${totals.strong}</td></tr>
      <tr><td style="padding:9px 14px;color:#6b6560">Gmail drafts prepared</td>
          <td style="padding:9px 14px;text-align:right;font-weight:600">${totals.drafts}</td></tr>
    </table>
  </td></tr>

  ${alerts.length ? `
  <!-- attention -->
  <tr><td style="padding:26px 0 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px">
      <tr><td style="padding:14px 16px">
        <div style="font-weight:700;color:#92400e;font-size:14px;margin-bottom:6px">Worth a look</div>
        <div style="font-size:13.5px;color:#78350f;line-height:1.6">
          ${alerts.map((a) => `• ${a}`).join("<br>")}
        </div>
      </td></tr>
    </table>
  </td></tr>` : ""}

  <!-- footer -->
  <tr><td style="padding:30px 0 0;text-align:center">
    <div style="height:1px;background:#eee6e0;margin-bottom:16px"></div>
    <div style="font-size:12px;color:#918a84;line-height:1.6">
      One email a day at 6pm, covering every scan since the last one.<br>
      ${scannedToday ? `${scannedToday} jobs scanned in the latest cycle report. ` : ""}Nothing is ever submitted or sent without you.
    </div>
    <div style="padding-top:12px">
      <a href="${DASHBOARD}/pipeline" style="color:${ACCENT};font-size:12.5px;text-decoration:none;font-weight:600">Pipeline</a>
      <span style="color:#d6cfc8;padding:0 7px">·</span>
      <a href="${DASHBOARD}/analytics" style="color:${ACCENT};font-size:12.5px;text-decoration:none;font-weight:600">Analytics</a>
      <span style="color:#d6cfc8;padding:0 7px">·</span>
      <a href="${DASHBOARD}/portals" style="color:${ACCENT};font-size:12.5px;text-decoration:none;font-weight:600">Portals</a>
    </div>
  </td></tr>

</table></td></tr></table></body></html>`;

const plain = [
  `Career Ops — ${prettyDate}`, "",
  `${totals.ready_now} ready to submit · ${totals.new_today} found today · ${totals.strong_today} scored 4+ today · ${totals.applied_total} applied to date`,
  "", "READY TO SUBMIT",
  ...(ready.length ? ready.map((r) => `- ${r.company} — ${r.role} (${Number(r.score).toFixed(2)}) ${r.url || ""}`) : ["- nothing ready"]),
  "", "APPLIED TODAY",
  ...(appliedToday.length ? appliedToday.map((r) => `- ${r.company} — ${r.role}`) : ["- none"]),
  "", `Pipeline: ${totals.total} tracked · ${totals.scored} scored · ${totals.unscored} awaiting scoring · ${totals.drafts} drafts`,
  "", `${DASHBOARD}/pipeline?tab=READY_TO_APPLY`,
].join("\n");

const subject = `Career Ops · ${totals.ready_now} ready to submit · ${totals.new_today} new today`;

if (DRY) {
  writeFileSync(join(ROOT, "output", "digest-preview.html"), html);
  console.log(`[dry-run] subject: ${subject}`);
  console.log(`[dry-run] to: ${RECIPIENT}`);
  console.log(`[dry-run] preview written to output/digest-preview.html`);
  process.exit(0);
}

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com", port: 465, secure: true,
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});
const info = await transporter.sendMail({
  from: `"Career Ops" <${process.env.GMAIL_USER}>`,
  to: RECIPIENT, subject, text: plain, html,
});
console.log(`sent daily digest to ${RECIPIENT} — ${info.messageId}`);
console.log(`  ${totals.ready_now} ready · ${totals.new_today} new · ${totals.applied_total} applied to date`);
