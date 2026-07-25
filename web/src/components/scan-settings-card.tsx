"use client";

import { useEffect, useState } from "react";
import { Clock, Calendar, ToggleLeft, ToggleRight, Loader2, Check } from "lucide-react";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const HOUR_OPTIONS = [
  { value: 0, label: "12 AM" },
  { value: 1, label: "1 AM" },
  { value: 2, label: "2 AM" },
  { value: 3, label: "3 AM" },
  { value: 4, label: "4 AM" },
  { value: 5, label: "5 AM" },
  { value: 6, label: "6 AM" },
  { value: 7, label: "7 AM" },
  { value: 8, label: "8 AM" },
  { value: 9, label: "9 AM" },
  { value: 10, label: "10 AM" },
  { value: 11, label: "11 AM" },
  { value: 12, label: "12 PM" },
  { value: 13, label: "1 PM" },
  { value: 14, label: "2 PM" },
  { value: 15, label: "3 PM" },
  { value: 16, label: "4 PM" },
  { value: 17, label: "5 PM" },
  { value: 18, label: "6 PM" },
  { value: 19, label: "7 PM" },
  { value: 20, label: "8 PM" },
  { value: 21, label: "9 PM" },
  { value: 22, label: "10 PM" },
  { value: 23, label: "11 PM" },
];

const FREQUENCY_OPTIONS = [
  { value: 1, label: "Every hour" },
  { value: 2, label: "Every 2 hours" },
  { value: 4, label: "Every 4 hours" },
  { value: 6, label: "Every 6 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Once a day" },
];

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Brisbane",
  "Australia/Sydney",
];

type ScanSettings = {
  scanning_enabled: boolean;
  scan_mode: "schedule" | "interval" | "disabled";
  scan_frequency_hours: number;
  preferred_days: number[];
  preferred_hours: number[];
  timezone: string;
  last_scan_at: string | null;
};

export function ScanSettingsCard() {
  const [settings, setSettings] = useState<ScanSettings>({
    scanning_enabled: true,
    scan_mode: "interval",
    scan_frequency_hours: 6,
    preferred_days: [1, 2, 3, 4, 5],
    preferred_hours: [9, 13, 18],
    timezone: "UTC",
    last_scan_at: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => {
        const id = d.userId || "default";
        setUserId(id);
        return fetch(`/api/scan-settings?userId=${encodeURIComponent(id)}`);
      })
      .then((r) => r.json())
      .then((d) => {
        setSettings({
          scanning_enabled: d.scanning_enabled ?? true,
          scan_mode: d.scan_mode ?? "interval",
          scan_frequency_hours: d.scan_frequency_hours ?? 6,
          preferred_days: d.preferred_days ?? [1, 2, 3, 4, 5],
          preferred_hours: d.preferred_hours ?? [9, 13, 18],
          timezone: d.timezone ?? "UTC",
          last_scan_at: d.last_scan_at,
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      await fetch("/api/scan-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: userId || "default", ...settings }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  function toggleDay(day: number) {
    setSettings((s) => ({
      ...s,
      preferred_days: s.preferred_days.includes(day)
        ? s.preferred_days.filter((d) => d !== day)
        : [...s.preferred_days, day].sort(),
    }));
  }

  function toggleHour(hour: number) {
    setSettings((s) => ({
      ...s,
      preferred_hours: s.preferred_hours.includes(hour)
        ? s.preferred_hours.filter((h) => h !== hour)
        : [...s.preferred_hours, hour].sort((a, b) => a - b),
    }));
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-border bg-surface/40 p-6">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Loading scan settings...
        </div>
      </div>
    );
  }

  const lastScan = settings.last_scan_at
    ? new Date(settings.last_scan_at).toLocaleString()
    : "Never";

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-brand" />
          <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">Scan Schedule</h3>
        </div>
        <button
          onClick={() => setSettings((s) => ({ ...s, scanning_enabled: !s.scanning_enabled }))}
          className="flex items-center gap-1.5 text-sm text-muted transition hover:text-foreground"
        >
          {settings.scanning_enabled ? (
            <ToggleRight className="size-6 text-brand" />
          ) : (
            <ToggleLeft className="size-6 text-faint" />
          )}
          {settings.scanning_enabled ? "On" : "Off"}
        </button>
      </div>

      <p className="mt-1 text-xs text-faint">Last scan: {lastScan}</p>

      {settings.scanning_enabled && (
        <div className="mt-4 space-y-4">
          {/* Mode selector */}
          <div className="flex gap-2">
            <button
              onClick={() => setSettings((s) => ({ ...s, scan_mode: "schedule" }))}
              className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium transition ${
                settings.scan_mode === "schedule"
                  ? "bg-brand text-brand-foreground"
                  : "border border-border text-muted hover:border-brand/40"
              }`}
            >
              <Calendar className="size-3" /> Days + Hours
            </button>
            <button
              onClick={() => setSettings((s) => ({ ...s, scan_mode: "interval" }))}
              className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium transition ${
                settings.scan_mode === "interval"
                  ? "bg-brand text-brand-foreground"
                  : "border border-border text-muted hover:border-brand/40"
              }`}
            >
              <Clock className="size-3" /> Every N Hours
            </button>
          </div>

          {/* Schedule mode */}
          {settings.scan_mode === "schedule" && (
            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Days of week</label>
                <div className="flex flex-wrap gap-1.5">
                  {DAY_NAMES.map((name, i) => (
                    <button
                      key={i}
                      onClick={() => toggleDay(i)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                        settings.preferred_days.includes(i)
                          ? "bg-brand text-brand-foreground"
                          : "border border-border text-faint hover:border-brand/40"
                      }`}
                      title={DAY_LABELS[i]}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Scan at these hours</label>
                <div className="flex flex-wrap gap-1.5">
                  {HOUR_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => toggleHour(value)}
                      className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                        settings.preferred_hours.includes(value)
                          ? "bg-brand text-brand-foreground"
                          : "border border-border text-faint hover:border-brand/40"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Interval mode */}
          {settings.scan_mode === "interval" && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">Frequency</label>
              <div className="flex flex-wrap gap-1.5">
                {FREQUENCY_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => setSettings((s) => ({ ...s, scan_frequency_hours: value }))}
                    className={`rounded-lg px-4 py-2 text-xs font-medium transition ${
                      settings.scan_frequency_hours === value
                        ? "bg-brand text-brand-foreground"
                        : "border border-border text-faint hover:border-brand/40"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Timezone */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Timezone</label>
            <select
              value={settings.timezone}
              onChange={(e) => setSettings((s) => ({ ...s, timezone: e.target.value }))}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-brand focus:outline-none"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Save button */}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-brand-foreground transition hover:bg-brand-200 disabled:opacity-50"
        >
          {saving ? "Saving..." : saved ? "Saved!" : "Save settings"}
        </button>
        {saved && <Check className="size-4 text-green-500" />}
      </div>
    </div>
  );
}
