"use client";

import { useState, useEffect, useCallback } from "react";
import type { InboxJob } from "@/lib/db";
import { CompanyLogo } from "@/components/company-logo";

// Score circle with grade color
function ScoreCircle({ score: rawScore }: { score: number | string | null | undefined }) {
  if (rawScore == null) {
    return (
      <div className="score-circle pending" title="Scoring in progress">
        <span className="score-value">…</span>
      </div>
    );
  }

  const score = Number(rawScore);

  const pct = Math.round((score / 5) * 100);
  const color =
    score >= 4.5 ? "#22c55e"
    : score >= 3.5 ? "#3b82f6"
    : score >= 2.5 ? "#f59e0b"
    : "#ef4444";

  const radius = 26;
  const circ = 2 * Math.PI * radius;
  const dash = (pct / 100) * circ;

  return (
    <div className="score-circle-wrap" title={`Score: ${score}/5`}>
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
      </div>
    </div>
  );
}

// Doc status badge
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending:    { label: "Pending",      cls: "badge-pending" },
    generating: { label: "Generating…",  cls: "badge-generating" },
    ready:      { label: "Docs Ready",   cls: "badge-ready" },
    failed:     { label: "Failed",       cls: "badge-failed" },
  };
  const { label, cls } = map[status] ?? { label: status, cls: "" };
  return <span className={`doc-badge ${cls}`}>{label}</span>;
}

// Score breakdown modal
function BreakdownModal({ job, onClose }: { job: InboxJob; onClose: () => void }) {
  const bd = job.score_breakdown ?? {};
  const rows: [string, string][] = [
    ["Role Fit",     String(bd.role_fit ?? "—")],
    ["Tech Match",   String(bd.tech_match ?? "—")],
    ["Culture Fit",  String(bd.culture_fit ?? "—")],
    ["Compensation", String(bd.compensation ?? "—")],
    ["Legitimacy",   String(bd.legitimacy ?? "—")],
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>
        <h3 className="modal-title">Score Breakdown — {job.company}</h3>
        <p className="modal-role">{job.role}</p>
        {job.why_match && <p className="modal-why">{job.why_match}</p>}
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

// Document viewer modal (CV HTML or plain text)
function DocModal({
  title, content, onClose, isHtml = false,
}: {
  title: string; content: string; onClose: () => void; isHtml?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box modal-doc" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">{title}</h3>
          <div className="modal-actions">
            <button
              className="btn-secondary"
              onClick={() => {
                navigator.clipboard.writeText(content).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? "✓ Copied!" : "Copy"}
            </button>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>
        </div>
        {isHtml ? (
          <iframe srcDoc={content} className="doc-iframe" title={title} />
        ) : (
          <pre className="doc-pre">{content}</pre>
        )}
      </div>
    </div>
  );
}

// Generate progress modal
function GenerateModal({
  job,
  onClose,
  onDone,
}: {
  job: InboxJob;
  onClose: () => void;
  onDone: () => void;
}) {
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [step, setStep] = useState("Reading cv.md and profile…");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function generate() {
      try {
        setStep("Reading CV, profile, article-digest.md…");
        await new Promise((r) => setTimeout(r, 400));
        if (cancelled) return;

        setStep("Extracting JD keywords for tailoring…");
        await new Promise((r) => setTimeout(r, 400));
        if (cancelled) return;

        setStep("Running build-cv-html.mjs with tailored payload…");

        const res = await fetch("/api/generate-docs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId: job.id,
            company: job.company,
            role: job.role,
            url: job.url,
            jdText: job.jd_text || "",
            type: "both",
          }),
        });

        if (cancelled) return;

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Generation failed");
        }

        const data = await res.json();
        if (cancelled) return;

        setStep(
          `✅ Done! ${data.hasCv ? "CV generated. " : ""}${data.hasCoverLetter ? "Cover letter generated." : ""}`
        );
        setStatus("done");
        setTimeout(() => {
          if (!cancelled) onDone();
        }, 1200);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
          setStatus("error");
        }
      }
    }

    generate();
    return () => { cancelled = true; };
  }, [job.id, job.company, job.role, job.url, job.jd_text, onDone]);

  return (
    <div className="modal-backdrop" onClick={status !== "running" ? onClose : undefined}>
      <div className="modal-box modal-generate" onClick={(e) => e.stopPropagation()}>
        <div className="generate-header">
          <h3 className="modal-title">
            {status === "running" && "⚙️ Generating Documents…"}
            {status === "done" && "✅ Documents Ready!"}
            {status === "error" && "❌ Generation Failed"}
          </h3>
          {status !== "running" && (
            <button className="modal-close" onClick={onClose}>×</button>
          )}
        </div>

        <p className="generate-job">
          {job.role} at <strong>{job.company}</strong>
        </p>

        <div className="generate-steps">
          {/* Steps tracker */}
          <div className={`gen-step ${status !== "error" ? "gen-step--active" : ""}`}>
            <span className="gen-step-icon">
              {status === "done" ? "✅" : status === "error" ? "❌" : "⟳"}
            </span>
            <span className="gen-step-label">
              {status === "error" ? error : step}
            </span>
          </div>

          <div className="career-ops-note">
            <p>Following career-ops pipeline:</p>
            <ol>
              <li>Read <code>CV</code> + <code>profile</code></li>
              <li>Extract JD keywords → tailor bullets &amp; summary</li>
              <li>Run <code>build-cv-html.mjs</code> with JSON payload</li>
              <li>Generate cover letter (cover.md logic)</li>
              <li>Store in dashboard DB</li>
            </ol>
          </div>
        </div>

        {status === "running" && (
          <div className="generate-spinner">
            <div className="spinner" />
          </div>
        )}
      </div>
    </div>
  );
}

// Single job card
function JobCard({
  job,
  onStatusChange,
  onRefresh,
}: {
  job: InboxJob;
  onStatusChange: (id: string, status: "new" | "applied" | "discarded") => void;
  onRefresh: () => void;
}) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showCV, setShowCV] = useState(false);
  const [showCL, setShowCL] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [sendingDraft, setSendingDraft] = useState(false);

  const handleSendGmailDraft = async () => {
    setSendingDraft(true);
    try {
      const res = await fetch("/api/gmail/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id }),
      });
      if (res.ok) {
        onRefresh();
      } else {
        const data = await res.json();
        alert(`Error: ${data.error || "Failed to create draft"}`);
      }
    } catch (e: any) {
      alert(`Error: ${e.message}`);
    } finally {
      setSendingDraft(false);
    }
  };

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

  const handleGenerateDone = () => {
    setShowGenerate(false);
    setGenerating(false);
    // Refresh the jobs list to pick up new cv_html and cover_letter
    onRefresh();
  };

  const isGenerating = job.doc_status === "generating" || generating;
  const hasDocuments = !!(job.cv_html || job.cover_letter || job.email_draft);

  return (
    <>
      <div className={`job-card ${job.job_status !== "new" ? "job-card--muted" : ""}`}>
        {/* Score circle */}
        <div className="job-card__score">
          <ScoreCircle score={job.score} />
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
              <div className="flex items-center gap-2">
                <CompanyLogo name={job.company} size={22} />
                <p className="job-company">{job.company}</p>
              </div>
              {job.location && <p className="job-location">📍 {job.location}</p>}
              {job.salary && <p className="job-salary">💰 {job.salary}</p>}
            </div>
            <div className="job-status-tag">
              {job.job_status === "applied" && <span className="tag tag-applied">✅ Applied</span>}
              {job.job_status === "discarded" && <span className="tag tag-discarded">🗑 Discarded</span>}
              {job.gmail_draft_id && (
                <span className="tag tag-gmail" title={`Gmail Draft: ${job.gmail_draft_id}`}>
                  📬 In Gmail
                </span>
              )}
            </div>
          </div>

          {job.why_match && <p className="job-why">{job.why_match}</p>}

          {/* Action buttons */}
          <div className="job-card__actions">
            <button
              className="btn-outline btn-sm"
              onClick={() => setShowBreakdown(true)}
            >
              📊 Score
            </button>

            {/* Generate CV & Cover Letter — career-ops pipeline */}
            {!hasDocuments && !isGenerating && (
              <button
                className="btn-primary btn-sm generate-btn"
                onClick={() => { setGenerating(true); setShowGenerate(true); }}
                title="Generates tailored CV + cover letter using career-ops: reads CV, profile, tailors to JD keywords, runs build-cv-html.mjs"
              >
                ✨ Generate CV &amp; Letter
              </button>
            )}

            {isGenerating && (
              <span className="tag tag-generating">
                <span className="spinner-inline" /> Generating…
              </span>
            )}

            {/* View generated documents */}
            {job.cv_html && (
              <button className="btn-outline btn-sm" onClick={() => setShowCV(true)}>
                📄 View CV
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

            {hasDocuments && !job.gmail_draft_id && (
              <button
                className="btn-outline btn-sm btn-gmail"
                onClick={handleSendGmailDraft}
                disabled={sendingDraft}
                title="Save this tailored email and CV PDF directly as a draft in your Gmail account"
              >
                {sendingDraft ? "⏳ Creating..." : "📬 Send to Gmail"}
              </button>
            )}

            {/* Re-generate if already has docs */}
            {hasDocuments && !isGenerating && (
              <button
                className="btn-ghost btn-sm"
                onClick={() => { setGenerating(true); setShowGenerate(true); }}
                title="Re-run career-ops pipeline to regenerate CV and cover letter"
              >
                🔄 Regenerate
              </button>
            )}

            <div className="job-card__divider" />

            {/* Apply link */}
            <a
              href={job.apply_url || job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary btn-sm"
            >
              🔗 Apply
            </a>

            {job.job_status === "new" && (
              <>
                <button
                  className="btn-outline btn-sm"
                  onClick={() => handleStatus("applied")}
                  disabled={updating}
                >
                  ✅ Mark Applied
                </button>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => handleStatus("discarded")}
                  disabled={updating}
                >
                  🗑 Discard
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

          {/* Status footer */}
          <div className="job-card__status-text">
            {job.doc_status === "ready" ? (
              <span className="status-ready">✅ CV + cover letter ready</span>
            ) : job.doc_status === "generating" ? (
              <span className="status-generating">⚙️ Generating documents…</span>
            ) : job.doc_status === "failed" ? (
              <span className="status-failed">❌ Generation failed — try again</span>
            ) : (
              <span className="status-pending">
                Click <strong>Generate CV &amp; Letter</strong> to create tailored documents
              </span>
            )}
          </div>
        </div>
      </div>

      {showBreakdown && <BreakdownModal job={job} onClose={() => setShowBreakdown(false)} />}
      {showCV && job.cv_html && (
        <DocModal
          title={`Tailored CV — ${job.company} (career-ops build-cv-html.mjs)`}
          content={job.cv_html}
          isHtml
          onClose={() => setShowCV(false)}
        />
      )}
      {showCL && job.cover_letter && (
        <DocModal
          title={`Cover Letter — ${job.company} (career-ops cover.md)`}
          content={job.cover_letter}
          onClose={() => setShowCL(false)}
        />
      )}
      {showEmail && job.email_draft && (
        <DocModal
          title={`Email Draft — ${job.company}`}
          content={job.email_draft}
          onClose={() => setShowEmail(false)}
        />
      )}
      {showGenerate && (
        <GenerateModal
          job={job}
          onClose={() => { setShowGenerate(false); setGenerating(false); }}
          onDone={handleGenerateDone}
        />
      )}
    </>
  );
}

// ── Main Jobs Page ─────────────────────────────────────────────────────────

type Tab = "new" | "applied" | "discarded";
type SortKey = "score-desc" | "score-asc" | "date-desc" | "date-asc";

export default function JobsPage() {
  const [jobs, setJobs] = useState<InboxJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("new");
  const [sort, setSort] = useState<SortKey>("score-desc");
  const [search, setSearch] = useState("");

  const loadJobs = useCallback(() => {
    setLoading(true);
    const activeAccount = typeof window !== "undefined" ? (localStorage.getItem("career-ops:active-account") || "default") : "default";
    fetch(`/api/jobs?status=${tab}`, {
      headers: { "x-user-id": activeAccount },
    })
      .then((r) => r.json())
      .then((data) => { setJobs(data.jobs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [tab]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // Poll every 30s to pick up new AI pipeline results
  useEffect(() => {
    if (tab !== "new") return;
    const activeAccount = typeof window !== "undefined" ? (localStorage.getItem("career-ops:active-account") || "default") : "default";
    const id = setInterval(() => {
      fetch("/api/jobs?status=new", {
        headers: { "x-user-id": activeAccount },
      })
        .then((r) => r.json())
        .then((data) => setJobs(data.jobs ?? []));
    }, 30000);
    return () => clearInterval(id);
  }, [tab]);

  const handleStatusChange = (id: string, _status: "new" | "applied" | "discarded") => {
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
      if (sort === "score-desc") return (b.score ?? 0) - (a.score ?? 0);
      if (sort === "score-asc") return (a.score ?? 0) - (b.score ?? 0);
      if (sort === "date-asc")
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  return (
    <div className="jobs-page">
      <div className="jobs-header">
        <div>
          <h1 className="jobs-title">Job Opportunities</h1>
          <p className="jobs-subtitle">
            AI-scored · Click <strong>Generate CV &amp; Letter</strong> to run career-ops pipeline per job
          </p>
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
            <option value="score-desc">Sort: Highest Score</option>
            <option value="score-asc">Sort: Lowest Score</option>
            <option value="date-desc">Sort: Newest</option>
            <option value="date-asc">Sort: Oldest</option>
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
            {t === tab && jobs.length > 0 && (
              <span className="tab-count">{jobs.length}</span>
            )}
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
              {search
                ? "No jobs match your search."
                : tab === "new"
                ? "No active jobs. Run a scan to find opportunities."
                : `No ${tab} jobs.`}
            </p>
          </div>
        ) : (
          filtered.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onStatusChange={handleStatusChange}
              onRefresh={loadJobs}
            />
          ))
        )}
      </div>
    </div>
  );
}
