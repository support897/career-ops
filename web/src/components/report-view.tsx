"use client";

import Link from "next/link";
import { ArrowLeft, FileText, ExternalLink, ChevronDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState } from "react";
import type { Application } from "@/lib/career-ops";
import { Badge } from "@/components/ui/badge";
import { scoreTone, scoreNum, legitimacyTone, parseReport } from "@/lib/format";
import { StatusSelect } from "@/components/status-select";
import { CompanyLogo } from "@/components/company-logo";
import { ScoreMethodology } from "@/components/score-methodology";

import { ApplyButton } from "@/components/apply-button";
import { DeleteFromTracker } from "@/components/delete-from-tracker";

// Progressive disclosure of the report. The core writes prose blocks
// "## F) Verdict (lead)", "## A) Role Summary", "## B) Match with CV", then
// C–G + machine artifacts (Machine Summary YAML, Application Answers, submit
// log). A mainstream user deciding "should I apply?" needs the verdict + fit;
// the rest is depth-on-demand. We lead with the verdict as a callout, keep A/B
// expanded, collapse C–G as content, and drop machine artifacts to a dimmer
// "Technical" tier — and strip the bare "F)" author-letters from headings
// (native <details>, no client JS — this stays a server component).

type Section = { heading: string; letter: string | null; content: string };

function cleanHeading(h: string): string {
  const stripped = h
    .replace(/^\s*(?:Block\s+)?[A-G][).:]\s*/i, "")
    .replace(/\s*\((?:lead|verdict)\)\s*$/i, "")
    .trim();
  return stripped || h.trim();
}

// Machine artifacts (collapsed because they're for devs, not the mainstream) vs
// human content C–G (collapsed only for length) — ux's "honest for devs" tier.
function isMachine(heading: string): boolean {
  return /machine summary|submitted|submit[-\s]?log/i.test(heading);
}

// A one-line teaser for a collapsed content section — drops the interaction cost
// of "what's in here?" without defeating the collapse.
function preview(md: string): string {
  const text = md
    .replace(/^#+\s.*$/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_`>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return sentence.length > 96 ? sentence.slice(0, 96).trimEnd() + "…" : sentence;
}

function splitSections(body: string): { intro: string; sections: Section[] } {
  const intro: string[] = [];
  const sections: Section[] = [];
  let cur: { heading: string; letter: string | null; lines: string[] } | null = null;
  for (const line of body.split("\n")) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      if (cur) sections.push({ heading: cur.heading, letter: cur.letter, content: cur.lines.join("\n").trim() });
      const heading = h[1].trim();
      const letter = heading.match(/^(?:Block\s+)?([A-G])[).:\s]/i)?.[1]?.toUpperCase() ?? null;
      cur = { heading, letter, lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      intro.push(line);
    }
  }
  if (cur) sections.push({ heading: cur.heading, letter: cur.letter, content: cur.lines.join("\n").trim() });
  return { intro: intro.join("\n").trim(), sections };
}

export function ReportView({
  id,
  app,
  report,
  canDelete = false,
  dbCoverLetter = null,
  dbCvHtml = null,
  dbEmailDraft = null,
  dbGmailDraftId = null,
  dbReferenceLetter = null,
  dbGenerationMethod = 'keyword',
}: {
  id: string;
  app: Application | null;
  report: string | null;
  file?: string | null;
  canDelete?: boolean;
  dbCoverLetter?: string | null;
  dbCvHtml?: string | null;
  dbEmailDraft?: string | null;
  dbGmailDraftId?: string | null;
  dbReferenceLetter?: string | null;
  dbGenerationMethod?: string | null;
}) {
  const [showCL, setShowCL] = useState(false);
  const [showTailoredCv, setShowTailoredCv] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [showReference, setShowReference] = useState(false);
  const [sendingDraft, setSendingDraft] = useState(false);
  const [gmailDraftId, setGmailDraftId] = useState<string | null>(dbGmailDraftId ?? null);

  const handleSendGmailDraft = async () => {
    setSendingDraft(true);
    try {
      const res = await fetch("/api/gmail/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: `00000000-0000-0000-0000-000000000${id.padStart(3, "0")}` }),
      });
      if (res.ok) {
        const data = await res.json();
        setGmailDraftId(data.uid || 'created');
        alert("Draft successfully uploaded to Gmail drafts folder!");
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

  const meta = report ? parseReport(report) : null;
  const field = (label: string) => meta?.fields.find((f) => f.label === label)?.value;
  const score = app?.score || field("Score");
  const date = app?.date || field("Date");
  const archetype = field("Archetype");
  const url = field("URL");

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Link
        href="/pipeline"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
      >
        <ArrowLeft className="size-4" /> Pipeline
      </Link>

      <header className="mt-5">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-faint">#{id}</p>
        <div className="mt-2 flex items-center gap-3">
          <CompanyLogo name={app?.company ?? meta?.title ?? `Report #${id}`} size={40} />
          <h1 className="font-display text-3xl tracking-tight text-landing">
            {app?.company ?? meta?.title ?? `Report #${id}`}
          </h1>
        </div>
        {app?.role && <p className="mt-1 text-muted">{app.role}</p>}

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          {score && <Badge tone={scoreTone(score)}>{score}</Badge>}
          {/* Verdict-first: the score's apply/don't-apply call (4.0 is the line,
              per the public methodology) as a <2s-scannable chip. */}
          {(() => {
            const n = scoreNum(score ?? "");
            if (Number.isNaN(n)) return null;
            return n >= 4.0 ? <Badge tone="good">Recommended</Badge> : <Badge tone="muted">Below the apply line</Badge>;
          })()}
          {meta?.legitimacy && <Badge tone={legitimacyTone(meta.legitimacy)}>{meta.legitimacy}</Badge>}
          {app && <StatusSelect n={id} current={app.status} />}

          <ApplyButton n={id} url={url && url.startsWith("http") ? url : undefined} company={app?.company ?? meta?.title ?? id} pdfReady={(app?.pdf ?? "").includes("✅")} />
          {app && app.status !== "Applied" && (
            <button
              onClick={async () => {
                try {
                  const res = await fetch("/api/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ n: id, status: "Applied" }),
                  });
                  if (res.ok) {
                    window.dispatchEvent(new CustomEvent("co-job-done"));
                  }
                } catch (e) {
                  console.error(e);
                }
              }}
              className="inline-flex items-center justify-center gap-1.5 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs font-semibold transition max-sm:min-h-[36px]"
            >
              ✅ Applied
            </button>
          )}
          
          {url && url.startsWith("http") && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-hover transition max-sm:min-h-[36px]"
            >
              🔗 View Job
            </a>
          )}

          <div className="w-full mt-2 mb-1">
            <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${dbGenerationMethod === 'llm' ? 'bg-purple-50 text-purple-700 ring-purple-600/20' : 'bg-blue-50 text-blue-700 ring-blue-600/20'}`}>
              {dbGenerationMethod === 'llm' ? '⚡ LLM Generated Documents' : '🔍 Keyword Generated Documents'}
            </span>
          </div>

          {dbCvHtml && (
            <button
              onClick={() => setShowTailoredCv(true)}
              className="inline-flex items-center justify-center rounded-lg bg-pink-500/10 text-pink-500 border border-pink-500/20 px-3 py-1.5 text-xs font-semibold hover:bg-pink-500/20 transition max-sm:min-h-[36px]"
            >
              🌸 View Tailored CV
            </button>
          )}
          {dbCoverLetter && (
            <button
              onClick={() => setShowCL(true)}
              className="inline-flex items-center justify-center rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-hover transition max-sm:min-h-[36px]"
            >
              ✉️ View Cover Letter
            </button>
          )}
          <button
            onClick={() => setShowReference(true)}
            className="inline-flex items-center justify-center rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-hover transition max-sm:min-h-[36px]"
          >
            📜 View Reference Letter
          </button>
          {dbEmailDraft && (
            <button
              onClick={() => setShowEmail(true)}
              className="inline-flex items-center justify-center rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-hover transition max-sm:min-h-[36px]"
            >
              📧 Email Draft
            </button>
          )}
          {dbEmailDraft && (
            gmailDraftId ? (
              <span className="inline-flex items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500 px-3 py-1.5 text-xs font-semibold border border-emerald-500/20 max-sm:min-h-[36px]">
                📬 In Gmail
              </span>
            ) : (
              <button
                onClick={handleSendGmailDraft}
                disabled={sendingDraft}
                className="inline-flex items-center justify-center rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 text-xs font-semibold transition disabled:opacity-55 max-sm:min-h-[36px]"
              >
                {sendingDraft ? "📬 Sending..." : "📬 Send to Gmail"}
              </button>
            )
          )}
        </div>

        {app && canDelete && (
          <div className="mt-3">
            <DeleteFromTracker n={id} />
          </div>
        )}

        {(archetype || date || (url && url.startsWith("http"))) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            {archetype && <span className="max-w-full truncate">{archetype}</span>}
            {date && <span className="tabular-nums text-faint">{date}</span>}
            {url && url.startsWith("http") && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-1 text-brand hover:underline max-sm:min-h-[44px]"
              >
                posting <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        )}
      </header>

      {report ? (
        <>
          {(() => {
            const { intro, sections } = splitSections(meta?.body ?? report);
            // Tolerant fallback: unrecognized layout → render the whole body as
            // before, so an old/odd report never loses content.
            if (sections.length === 0) {
              return (
                <article className="report-prose mt-8">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{meta?.body ?? report}</ReactMarkdown>
                </article>
              );
            }
            // Verdict (F) leads as a highlighted callout with no competing heading —
            // it's THE answer. A/B stay expanded (fit detail); C–G collapse as
            // content (with a 1-line preview); machine artifacts drop to a dimmer
            // "Technical" tier so the CLI-DNA is present-but-clearly-secondary.
            const verdict = sections.find((s) => s.letter === "F");
            const rest = sections.filter((s) => s !== verdict);
            const machine = rest.filter((s) => isMachine(s.heading));
            const mainSections = rest.filter((s) => !isMachine(s.heading));
            const anyAB = mainSections.some((s) => s.letter === "A" || s.letter === "B");
            return (
              <div className="mt-8">
                {intro && (
                  <article className="report-prose">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{intro}</ReactMarkdown>
                  </article>
                )}

                {verdict && (
                  <div className="rounded-2xl border border-brand/25 bg-brand-soft/50 px-5 py-4">
                    <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-brand/80">Verdict</p>
                    <article className="report-prose [&_p]:font-medium [&_p]:text-foreground">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{verdict.content}</ReactMarkdown>
                    </article>
                  </div>
                )}

                {mainSections.map((s, i) => {
                  const expanded = s.letter === "A" || s.letter === "B" || (!anyAB && i === 0);
                  if (expanded) {
                    return (
                      <article key={i} className="report-prose mt-6">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{`## ${cleanHeading(s.heading)}\n\n${s.content}`}</ReactMarkdown>
                      </article>
                    );
                  }
                  return (
                    <details key={i} className="group mt-3 overflow-hidden rounded-xl border border-border bg-surface/30">
                      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-4 py-3 transition-colors hover:bg-surface-hover">
                        <span className="text-sm font-medium">{cleanHeading(s.heading)}</span>
                        <span className="hidden truncate text-xs text-faint sm:inline">{preview(s.content)}</span>
                        <ChevronDown className="ml-auto size-4 shrink-0 text-faint transition-transform group-open:rotate-180" />
                      </summary>
                      <div className="report-prose border-t border-border px-4 py-3">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.content}</ReactMarkdown>
                      </div>
                    </details>
                  );
                })}

                {machine.length > 0 && (
                  <>
                    <div className="mt-6 flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-faint">
                      <span className="h-px flex-1 bg-border" />
                      Technical details · for developers
                      <span className="h-px flex-1 bg-border" />
                    </div>
                    {machine.map((s, i) => (
                      <details key={i} className="group mt-2 overflow-hidden rounded-xl border border-border/60 bg-surface/20">
                        <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-4 py-3 font-mono text-xs text-muted transition-colors hover:bg-surface-hover">
                          {cleanHeading(s.heading)}
                          <ChevronDown className="ml-auto size-4 shrink-0 text-faint transition-transform group-open:rotate-180" />
                        </summary>
                        <div className="report-prose border-t border-border/60 px-4 py-3 opacity-80">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.content}</ReactMarkdown>
                        </div>
                      </details>
                    ))}
                  </>
                )}
              </div>
            );
          })()}
          <ScoreMethodology />
        </>
      ) : (
        <div className="mt-8 flex items-center gap-3 rounded-2xl border border-dashed border-border bg-surface/30 p-5 text-sm text-muted">
          <FileText className="size-5 shrink-0 text-faint" />
          No report file found for #{id} in <code className="text-foreground">reports/</code>.
        </div>
      )}

      {showTailoredCv && dbCvHtml && (
        <DocModal
          title={`Tailored CV — ${app?.company ?? meta?.title ?? "Position"}`}
          content={dbCvHtml}
          isHtml={true}
          onClose={() => setShowTailoredCv(false)}
          company={app?.company ?? meta?.title ?? "Company"}
          role={app?.role ?? meta?.role ?? "Role"}
          docType="CV"
        />
      )}
      {showCL && dbCoverLetter && (
        <DocModal
          title={`Cover Letter — ${app?.company ?? meta?.title ?? "Job"}`}
          content={dbCoverLetter}
          isHtml={true}
          onClose={() => setShowCL(false)}
          company={app?.company ?? meta?.title ?? id}
          role={app?.role ?? meta?.role ?? "Role"}
          docType="CoverLetter"
        />
      )}
      {showEmail && dbEmailDraft && (
        <DocModal
          title={`Email Outreach — ${app?.company ?? meta?.title ?? "Job"}`}
          content={dbEmailDraft}
          onClose={() => setShowEmail(false)}
        />
      )}
      {showReference && (
        <DocModal
          title={`Reference Letter — Taylor Chorley (Evolve Marketing)`}
          content={dbReferenceLetter || `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Reference Letter for Ilse Placencia</title><style>body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1a1a2e;line-height:1.6;max-width:680px;margin:40px auto;padding:0 30px;background:#ffffff;}.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #107b89;padding-bottom:20px;margin-bottom:30px;}.brand{font-size:28px;font-weight:800;letter-spacing:-1px;color:#107b89;}.brand span{color:#8b5cf6;}.brand-sub{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#64748b;font-weight:600;}.title{font-size:20px;font-weight:700;color:#0f172a;margin-bottom:15px;}.meta{font-size:13px;color:#475569;background:#f8fafc;padding:12px 16px;border-radius:8px;margin-bottom:25px;border-left:4px solid #107b89;}.meta p{margin:3px 0;}.content p{font-size:14px;color:#334155;margin-bottom:16px;}.signature-block{margin-top:35px;padding-top:20px;border-top:1px solid #e2e8f0;}.sign-name{font-family:'Brush Script MT','cursive',sans-serif;font-size:24px;color:#0f172a;margin-bottom:5px;}.sign-title{font-size:13px;font-weight:600;color:#0f172a;}.sign-contact{font-size:12px;color:#64748b;}</style></head><body><div class="header"><div><div class="brand">ev<span>o</span>lve</div><div class="brand-sub">MARKETING</div></div></div><div class="title">Reference Letter for Ilse Placencia</div><div class="meta"><p><strong>From:</strong> Taylor Chorley</p><p><strong>Position:</strong> Digital Marketing Supervisor, Evolve Marketing</p><p><strong>Date:</strong> October 26th, 2025</p></div><div class="content"><p>To Whom It May Concern,</p><p>I've worked with Ilse Placencia since January 2024, when she joined Evolve Marketing as a Digital Marketing Assistant, and I'm genuinely glad to write this on her behalf.</p><p>What stands out most, honestly, isn't just her skill set, it's how she works. Ilse brings this steady, positive energy to everything, even on the weeks that get hectic. She's the kind of person who checks in on how you're doing before diving into the task list, and that made a real difference on a fully remote team where it's easy to feel disconnected.</p><p>That said, she's also just really good at the job, and not just in one thing either. She's sharp across marketing and AI alike, and she's always finding new tools to make the work faster or better. If a tool she needs doesn't exist yet, she'll just build her own. That kind of resourcefulness isn't something you can teach. She has a genuine feel for what makes people click, and her social content consistently landed on brand, well timed, and built for whatever platform it was going on.</p><p>She's also reliable, something really hard to find nowadays. She meets deadlines, communicates clearly, and shows up prepared to strategy conversations with actual value, not just notes. Her analytics work and customer research made our campaigns improve across the board.</p><p>I'd hire Ilse again without hesitation. She's hardworking, kind, easy to work with, and any team would be lucky to have her.</p><p>Happy to talk more if it's helpful.</p><p>Warmest regards,</p></div><div class="signature-block"><div class="sign-name">Taylor Chorley</div><div class="sign-title">Taylor Chorley</div><div class="sign-contact">Digital Marketing Supervisor, Evolve Marketing</div><div class="sign-contact">taylorchorley@gmail.com | +1 (604) 551-8229</div></div></body></html>`}
          isHtml={true}
          onClose={() => setShowReference(false)}
          company={app?.company ?? meta?.title ?? "Company"}
          role={app?.role ?? meta?.role ?? "Role"}
          docType="ReferenceLetter"
        />
      )}
    </div>
  );
}

function DocModal({
  title, content, onClose, isHtml = false, company, role, docType
}: {
  title: string; content: string; onClose: () => void; isHtml?: boolean; company?: string; role?: string; docType?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleDownloadPdf = async () => {
    setDownloading(true);
    try {
      const html2pdf = (await import("html2pdf.js")).default;
      const dateStr = new Date().toISOString().slice(0, 10);
      const safeCompany = (company || "Company").replace(/[^a-zA-Z0-9]/g, "");
      const safeRole = (role || "Role").replace(/[^a-zA-Z0-9]/g, "");
      const safeType = (docType || "Document").replace(/[^a-zA-Z0-9]/g, "");
      const filename = `Ilse_Placencia_${safeRole}_${safeCompany}_${safeType}_${dateStr}.pdf`;

      const opt = {
        margin: 0,
        filename: filename,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" }
      };

      await html2pdf().set(opt).from(content).save();
    } catch (e) {
      console.error("PDF generation failed:", e);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="relative w-full max-w-3xl rounded-2xl border border-border bg-background p-6 shadow-2xl flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between pb-4 border-b border-border">
          <h3 className="text-lg font-bold text-foreground">{title}</h3>
          <div className="flex items-center gap-2">
            {isHtml && (
              <button
                onClick={handleDownloadPdf}
                disabled={downloading}
                className="inline-flex items-center justify-center rounded-lg bg-brand px-3.5 py-1.5 text-xs font-semibold text-brand-foreground shadow-sm hover:bg-brand-200 transition disabled:opacity-50 max-sm:min-h-[36px]"
              >
                {downloading ? "⏳ Generating..." : "📥 Download PDF"}
              </button>
            )}
            <button
              className="inline-flex items-center justify-center rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-hover transition"
              onClick={() => {
                navigator.clipboard.writeText(content).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? "✓ Copied!" : "Copy"}
            </button>
            <button className="text-2xl hover:opacity-75" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="mt-4 overflow-y-auto flex-1 text-sm text-foreground">
          {isHtml ? (
            <iframe srcDoc={content} className="w-full h-[55vh] border-0 rounded-lg" title={title} />
          ) : (
            <pre className="whitespace-pre-wrap font-mono p-4 bg-surface rounded-xl border border-border leading-relaxed">{content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
