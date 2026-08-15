import { NextResponse } from "next/server";
import { getUserProfile, upsertUserProfile } from "@/lib/db";

// GET /api/scan-settings — Return scan settings for a user
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId") || "default";

  try {
    const profile = await getUserProfile(userId);

    if (!profile) {
      return NextResponse.json({
        scanning_enabled: true,
        scan_mode: "interval",
        scan_frequency_hours: 6,
        preferred_days: [1, 2, 3, 4, 5],
        preferred_hours: [9, 13, 18],
        timezone: "UTC",
        platforms: [],
        keywords: [],
        location_filter: [],
        last_scan_at: null,
      });
    }

    return NextResponse.json({
      scanning_enabled: profile.scanning_enabled,
      scan_mode: profile.scan_mode,
      scan_frequency_hours: profile.scan_frequency_hours,
      preferred_days: profile.preferred_days,
      preferred_hours: profile.preferred_hours,
      timezone: profile.timezone,
      platforms: profile.platforms,
      keywords: profile.keywords,
      location_filter: profile.location_filter,
      last_scan_at: profile.last_scan_at,
      profile_config: profile.profile_config || {},
    });
  } catch (error) {
    console.error("[Scan Settings] GET error:", error);
    return NextResponse.json(
      { error: "Failed to load scan settings" },
      { status: 500 }
    );
  }
}

// POST /api/scan-settings — Save scan settings for a user
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { userId = "default", ...settings } = body;

    // Validate scan_mode
    if (settings.scan_mode && !["schedule", "interval", "disabled"].includes(settings.scan_mode)) {
      return NextResponse.json(
        { error: "Invalid scan_mode. Must be: schedule, interval, or disabled" },
        { status: 400 }
      );
    }

    // Validate preferred_days (0-6)
    if (settings.preferred_days) {
      if (!Array.isArray(settings.preferred_days) || settings.preferred_days.some((d: number) => d < 0 || d > 6)) {
        return NextResponse.json(
          { error: "preferred_days must be an array of integers 0-6 (Sun-Sat)" },
          { status: 400 }
        );
      }
    }

    // Validate preferred_hours (0-23)
    if (settings.preferred_hours) {
      if (!Array.isArray(settings.preferred_hours) || settings.preferred_hours.some((h: number) => h < 0 || h > 23)) {
        return NextResponse.json(
          { error: "preferred_hours must be an array of integers 0-23" },
          { status: 400 }
        );
      }
    }

    // Validate scan_frequency_hours
    if (settings.scan_frequency_hours !== undefined) {
      const freq = Number(settings.scan_frequency_hours);
      if (freq < 1 || freq > 168) {
        return NextResponse.json(
          { error: "scan_frequency_hours must be between 1 and 168" },
          { status: 400 }
        );
      }
    }

    const profile = await getUserProfile(userId);
    const existingConfig = profile?.profile_config || {};
    const newConfig = { ...existingConfig, ...(settings.profile_config || {}) };

    const updatedProfile = await upsertUserProfile(userId, {
      scanning_enabled: settings.scanning_enabled,
      scan_mode: settings.scan_mode,
      scan_frequency_hours: settings.scan_frequency_hours,
      preferred_days: settings.preferred_days,
      preferred_hours: settings.preferred_hours,
      timezone: settings.timezone,
      platforms: settings.platforms,
      keywords: settings.keywords,
      location_filter: settings.location_filter,
      profile_config: newConfig,
    });

    return NextResponse.json({ success: true, profile: updatedProfile });
  } catch (error) {
    console.error("[Scan Settings] POST error:", error);
    return NextResponse.json(
      { error: "Failed to save scan settings" },
      { status: 500 }
    );
  }
}
