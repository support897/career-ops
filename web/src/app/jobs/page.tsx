"use client";

import { useState, useEffect } from "react";
import type { InboxJob } from "@/lib/db";

// Score circle with grade color
function ScoreCircle({ score, grade }: { score: number | null; grade?: string }) {
  if (score === null) {
    return (
      <div className="score-circle pending" title="Scoring in progress">
        <span className="score-value">…</span>
      </div>
    );
  }

  const pct = Math.round((score / 5) * 100);
  const color =
    score >= 4.5 ? "#22c55e"  // green — A
    : score >= 3.5 ? "#3b82f6" // blue — B
    : score >= 2.5 ? "#f59e0b" // amber — C
    : "#ef4444"; // red — D/F

  const radius = 26;
  const circ = 2 * Math.PI * radius;
  const dash = (pct / 100) * circ;

  return (
    <div className="score-circle-wrap" title={`Score: ${score}/5 (${grade ?? ""})`}>
      <svg width="68" height="68" viewBox="0 0 68 68">
        <circle cx="34" cy="34" r={radius} fill="none" stroke="#1e293b" strokeWidth="6" />
        <circle
          cx="34" cy="34" r={radius} fill="none"
          stroke={color} strokeWidth="6"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          transform="rotate(-90 34 34)"
        />
      </svg>
      <div className="score-label">
        <span className="score-val" style={{ color }}>{score.toFixed(1)}</span>
        <span className="score-grade">{grade ?? ""}</span>
      </div>
    </div>
  );
}

// Doc status badge
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending:    { label: "Scoring…",    cls: "badge-pending" },
    generating: { label: "Generating…", cls: "badge-generating" },
    ready:      { label: "Docs Ready",  cls: "badge-ready" },
    failed:     { label: "Score Failed",cls: "badge-failed" },
  };
  const { label, cls } = map[status] ?? { label: status, cls: "" };
  return <span className={`doc-badge ${cls}`}>{label}</span>;
}

// Expandable breakdown modal
function BreakdownModal({
  job,
  onClose,
}: {
  job: InboxJob;
  onClose: () => void;
}) {
  const bd = job.score_breakdown ?? {};
  const rows: [string, string][] = [
    ["Role Fit",      String(bd.role_fit ?? "—")],
    ["Tech Match",    String(bd.tech_match ?? "—")],
    ["Culture Fit",   String(bd.culture_fit ?? "—")],
    ["Compensation",  String(bd.compensation ?? "—")],
    ["Legitimacy",    String(bd.legitimacy ?? "—")],
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>
        <h3 className="modal-title">Score Breakdown — {job.company}</h3>
        <p className="modal-role">{job.role}</p>
        {job.why_match && (
          <p className="modal-why">{job.why_match}</p>
        )}
        <table className="breakdown-table">
          <tbody>
            {rows.map(([label, val]) => (
              <tr key={label}>
                <td className="bd-label">{label}</td>
                <td className="bd-val">
                  <div className="bd-bar">
                    <div
                      className="bd-fill"
                      style={{ width: `${Math.min(100, (parseInt(val) || 0) / 5 * 100)}%` }}
                    />
                  </div>
                  <span>{val}/5</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {job.location && <p className="modal-location">📍 {job.location}</p>}
        {job.salary && <p className="modal-salary">💰 {job.salary}</p>}
        <a href={job.url} target="_blank" rel="noopener noreferrer" className="modal-link">
          View Original Posting →
        </a>
      </div>
    </div>
  );
}

// Document viewer modal
function DocModal({
  title,
  content,
  onClose,
  isHtml = false,
}: {
  title: string;
  content: string;
  onClose: () => void;
  isHtml?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box modal-doc" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">{title}</h3>
          <div className="modal-actions">
            <button className="btn-secondary" onClick={handleCopy}>
              {copied ? "✓ Copied!" : "Copy"}
            </button>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>
        </div>
        {isHtml ? (
          <iframe
            srcDoc={content}
            className="doc-iframe"
            title={title}
          />
        ) : (
          <pre className="doc-pre">{content}</pre>
        )}
      </div>
    </div>
  );
}

// Single job card
function JobCard({
  job,
  onStatusChange,
}: {
  job: InboxJob;
  onStatusChange: (id: string, status: "new" | "applied" | "discarded") => void;
}) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showCV, setShowCV] = useState(false);
  const [showCL, setShowCL] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [updating, setUpdating] = useState(false);

  const handleStatus = async (status: "new" | "applied" | "discarded") => {
    setUpdating(true);
    await fetch("/api/jobs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: job.id, status }),
    });
    onStatusChange(job.id, status);
    setUpdating(false);
  };

  return (
    <>
      <div className={`job-card ${job.job_status !== "new" ? "job-card--muted" : ""}`}>
        {/* Score circle */}
        <div className="job-card__score">
          <ScoreCircle score={job.score} grade={undefined} />
          <StatusBadge status={job.doc_status} />
        </div>

        {/* Main content */}
        <div className="job-card__body">
          <div className="job-card__header">
            <div>
              <h3 className="job-title">
                <a href={job.url} target="_blank" rel="noopener noreferrer">
                  {job.role}
                </a>
              </h3>
              <p className="job-company">{job.company}</p>
              {job.location && <p className="job-location">📍 {job.location}</p>}
              {job.salary && <p className="job-salary">💰 {job.salary}</p>}
            </div>
            <div className="job-status-tag">
              {job.job_status === "applied" && <span className="tag tag-applied">✅ Applied</span>}
              {job.job_status === "discarded" && <span className="tag tag-discarded">🗑 Discarded</span>}
              {job.doc_status === "pending" || job.doc_status === "generating" ? (
                <span className="tag tag-generating">⚡ Processing</span>
              ) : null}
            </div>
          </div>

          {/* Why match */}
          {job.why_match && (
            <p className="job-why">{job.why_match}</p>
          )}

          {/* Action buttons */}
          <div className="job-card__actions">
            <button
              className="btn-outline btn-sm"
              onClick={() => setShowBreakdown(true)}
            >
              📊 Breakdown
            </button>

            {job.cv_html && (
              <button className="btn-outline btn-sm" onClick={() => setShowCV(true)}>
                📄 CV
              </button>
            )}

            {job.cover_letter && (
              <button className="btn-outline btn-sm" onClick={() => setShowCL(true)}>
                ✉️ Cover Letter
              </button>
            )}

            {job.email_draft && (
              <button className="btn-outline btn-sm" onClick={() => setShowEmail(true)}>
                📧 Email Draft
              </button>
            )}

            {job.gmail_draft_id && (
              <span className="tag tag-gmail" title={`Gmail Draft ID: ${job.gmail_draft_id}`}>
                📬 In Gmail
              </span>
            )}

            <div className="job-card__divider" />

            {job.job_status === "new" && (
              <>
                <button
                  className="btn-primary btn-sm"
                  onClick={() => handleStatus("applied")}
                  disabled={updating}
                >
                  Mark Applied
                </button>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => handleStatus("discarded")}
                  disabled={updating}
                >
                  Discard
                </button>
              </>
            )}
            {job.job_status !== "new" && (
              <button
                className="btn-ghost btn-sm"
                onClick={() => handleStatus("new")}
                disabled={updating}
              >
                ↩ Restore
              </button>
            )}
          </div>
        </div>
      </div>

      {showBreakdown && <BreakdownModal job={job} onClose={() => setShowBreakdown(false)} />}
      {showCV && job.cv_html && (
        <DocModal title={`Tailored CV — ${job.company}`} content={job.cv_html} isHtml onClose={() => setShowCV(false)} />
      )}
      {showCL && job.cover_letter && (
        <DocModal title={`Cover Letter — ${job.company}`} content={job.cover_letter} onClose={() => setShowCL(false)} />
      )}
      {showEmail && job.email_draft && (
        <DocModal title={`Email Draft — ${job.company}`} content={job.email_draft} onClose={() => setShowEmail(false)} />
      )}
    </>
  );
}

// ── Main Jobs Page ─────────────────────────────────────────────────────────

type Tab = "new" | "applied" | "discarded";
type SortKey = "score" | "date";

export default function JobsPage() {
  const [jobs, setJobs] = useState<InboxJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("new");
  const [sort, setSort] = useState<SortKey>("score");
  const [search, setSearch] = useState("");

  useEffect(() => {
    setLoading(true);
    fetch(`/api/jobs?status=${tab}`)
      .then((r) => r.json())
      .then((data) => { setJobs(data.jobs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [tab]);

  // Poll every 30s to pick up new AI pipeline results
  useEffect(() => {
    if (tab !== "new") return;
    const id = setInterval(() => {
      fetch(`/api/jobs?status=new`)
        .then((r) => r.json())
        .then((data) => setJobs(data.jobs ?? []));
    }, 30000);
    return () => clearInterval(id);
  }, [tab]);

  const handleStatusChange = (id: string, status: "new" | "applied" | "discarded") => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  };

  const filtered = jobs
    .filter((j) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        j.company.toLowerCase().includes(q) ||
        j.role.toLowerCase().includes(q) ||
        (j.location ?? "").toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (sort === "score") return (b.score ?? 0) - (a.score ?? 0);
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  const counts = { new: 0, applied: 0, discarded: 0 };
  // We show count from the current list only
  counts[tab] = jobs.length;

  return (
    <div className="jobs-page">
      <div className="jobs-header">
        <div>
          <h1 className="jobs-title">Job Opportunities</h1>
          <p className="jobs-subtitle">AI-scored · CV & cover letter generated per job</p>
        </div>
        <div className="jobs-controls">
          <input
            className="search-input"
            placeholder="Search company, role, location…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="sort-select"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="score">Sort: Best Score</option>
            <option value="date">Sort: Newest</option>
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className="jobs-tabs">
        {(["new", "applied", "discarded"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`tab-btn ${tab === t ? "tab-btn--active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "new" ? "🎯 Active" : t === "applied" ? "✅ Applied" : "🗑 Discarded"}
          </button>
        ))}
      </div>

      {/* Job list */}
      <div className="jobs-list">
        {loading ? (
          <div className="jobs-empty">
            <div className="spinner" />
            <p>Loading jobs…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="jobs-empty">
            <p className="empty-icon">🔍</p>
            <p>
              {search ? "No jobs match your search." : tab === "new" ? "No active jobs. Run a scan to find opportunities." : `No ${tab} jobs.`}
            </p>
          </div>
        ) : (
          filtered.map((job) => (
            <JobCard key={job.id} job={job} onStatusChange={handleStatusChange} />
          ))
        )}
      </div>
    </div>
  );
}
