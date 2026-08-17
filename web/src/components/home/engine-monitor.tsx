"use client";

/**
 * EngineMonitor — the scanning engine's real state, from /api/engine-status.
 *
 * Replaces a hardcoded panel that showed a stale PID, "Neon PostgreSQL" after
 * the migration to self-hosted Postgres, an "Active (Playwright)" form engine
 * that no longer exists, and a permanently green "ONLINE 24/7" badge. It read
 * healthy through weeks in which the pipeline produced nothing at all.
 *
 * Every value here is measured. Where something genuinely cannot be known from
 * the dashboard's side — whether a process on the VPS is alive right now — this
 * says so instead of guessing.
 */

import { useEffect, useState } from "react";

type EngineStatus = {
  engine: {
    state: "online" | "stale" | "idle" | "unknown";
    lastScanAt: string | null;
    minutesSinceLastScan: number | null;
    host: string | null;
    note: string;
  };
  lastScan: null | {
    status: string;
    found: number;
    added: number;
    filteredByTitle: number;
    filteredByLocation: number;
    duplicates: number;
    errors: number;
    note: string | null;
  };
  last24h: { scanRuns: number; jobsAdded: number };
  pipeline: {
    total: number;
    scored: number;
    readyToApply: number;
    withDocuments: number;
    withGmailDraft: number;
    applied: number;
  };
  database: { kind: string; connected: boolean };
  error?: string;
};

const STATE_STYLES: Record<string, { dot: string; badge: string; label: string }> = {
  online: {
    dot: "bg-emerald-500",
    badge: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
    label: "SCANNING",
  },
  stale: {
    dot: "bg-amber-500",
    badge: "bg-amber-500/10 border-amber-500/30 text-amber-500",
    label: "NO RECENT SCAN",
  },
  idle: {
    dot: "bg-slate-400",
    badge: "bg-slate-500/10 border-slate-500/30 text-slate-400",
    label: "NEVER RUN",
  },
  unknown: {
    dot: "bg-rose-500",
    badge: "bg-rose-500/10 border-rose-500/30 text-rose-400",
    label: "STATUS UNAVAILABLE",
  },
};

function relative(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function EngineMonitor() {
  const [data, setData] = useState<EngineStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/engine-status", { cache: "no-store" });
        const json = (await res.json()) as EngineStatus;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    // The runner scans hourly; refreshing every 60s keeps the panel honest
    // without polling hard.
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (loading) {
    return (
      <section className="mt-6 rounded-2xl border border-border/60 bg-surface/60 p-6">
        <p className="text-xs text-muted">Checking engine status…</p>
      </section>
    );
  }

  if (!data || data.error) {
    return (
      <section className="mt-6 rounded-2xl border border-rose-500/30 bg-surface/60 p-6">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">
          Scanning Engine
        </h3>
        <p className="mt-2 text-xs text-rose-400">
          {data?.error ? `Status unavailable: ${data.error}` : "Could not reach /api/engine-status."}
        </p>
      </section>
    );
  }

  const style = STATE_STYLES[data.engine.state] ?? STATE_STYLES.unknown;
  const { lastScan, pipeline, last24h } = data;

  return (
    <section className="mt-6 rounded-2xl border border-brand/30 bg-surface/60 p-6 backdrop-blur-md shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/60 pb-4">
        <div className="flex items-center gap-3">
          <div className="relative flex size-3">
            {data.engine.state === "online" && (
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${style.dot} opacity-75`} />
            )}
            <span className={`relative inline-flex size-3 rounded-full ${style.dot}`} />
          </div>
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">
              Scanning Engine
            </h3>
            <p className="text-xs text-muted">{data.engine.note}</p>
          </div>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${style.badge}`}>
          {style.label}
        </span>
      </div>

      <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <Cell label="Last scan" value={relative(data.engine.lastScanAt)}
              sub={lastScan ? `${lastScan.found.toLocaleString()} found · ${lastScan.added} added` : undefined} />
        <Cell label="Last 24 hours" value={`${last24h.scanRuns} scan${last24h.scanRuns === 1 ? "" : "s"}`}
              sub={`${last24h.jobsAdded} job${last24h.jobsAdded === 1 ? "" : "s"} added`} />
        <Cell label="Ready to apply (4.0+)" value={String(pipeline.readyToApply)}
              sub={`${pipeline.withDocuments} with documents`} accent />
        <Cell label="Gmail drafts" value={String(pipeline.withGmailDraft)}
              sub={`${pipeline.applied} marked applied`} />
      </div>

      <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <Cell label="Jobs in pipeline" value={String(pipeline.total)} sub={`${pipeline.scored} scored`} />
        <Cell label="Database" value={data.database.kind} sub="shared with the runner" />
        <Cell label="Runner host" value={data.engine.host ?? "unknown"} sub="writes every scan" />
        <Cell
          label="Last scan outcome"
          value={lastScan ? lastScan.status : "—"}
          sub={
            lastScan
              ? `${lastScan.filteredByTitle.toLocaleString()} filtered by title · ${lastScan.errors} error${lastScan.errors === 1 ? "" : "s"}`
              : undefined
          }
        />
      </div>

      {lastScan?.note && (
        <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-500">
          {lastScan.note}
        </p>
      )}
    </section>
  );
}

function Cell({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/40 bg-background/50 p-3">
      <span className="block text-muted">{label}</span>
      <span className={`text-sm font-semibold ${accent ? "text-brand" : "text-foreground"}`}>{value}</span>
      {sub && <span className="mt-0.5 block text-[11px] text-muted">{sub}</span>}
    </div>
  );
}
