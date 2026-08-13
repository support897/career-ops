"use client";

import { useEffect, useState } from "react";
import { Play, Pause, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export function ScanToggleButton() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const res = await fetch("/api/scan-settings?userId=default");
        if (res.ok) {
          const data = await res.json();
          setEnabled(data.scanning_enabled !== false && data.scan_mode !== "disabled");
        }
      } catch (err) {
        console.error("Failed to fetch scan status:", err);
      }
    }
    fetchStatus();
  }, []);

  async function toggleScan() {
    if (loading || enabled === null) return;
    setLoading(true);
    const nextState = !enabled;
    try {
      const res = await fetch("/api/scan-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "default",
          scanning_enabled: nextState,
          scan_mode: nextState ? "interval" : "disabled",
        }),
      });
      if (res.ok) {
        setEnabled(nextState);
      }
    } catch (err) {
      console.error("Failed to update scan status:", err);
    } finally {
      setLoading(false);
    }
  }

  if (enabled === null) return null;

  return (
    <button
      onClick={toggleScan}
      disabled={loading}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs font-semibold shadow-sm transition-all duration-150",
        enabled
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400"
          : "border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
      )}
      title={enabled ? "Auto-Apply is running 24/7 on VPS. Click to pause." : "Auto-Apply is paused. Click to resume."}
    >
      <div className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full", enabled ? "bg-emerald-500 animate-pulse" : "bg-amber-500")} />
        <span className="truncate">{enabled ? "Auto-Apply Active" : "Auto-Apply Paused"}</span>
      </div>

      {loading ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : enabled ? (
        <Pause className="size-3.5 fill-current" />
      ) : (
        <Play className="size-3.5 fill-current" />
      )}
    </button>
  );
}
