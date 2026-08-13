import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { careerOpsRoot } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const root = careerOpsRoot();
  const scriptPath = path.join(root, "hourly-scan.mjs");

  if (!fs.existsSync(scriptPath)) {
    return NextResponse.json(
      { error: "hourly-scan.mjs not found at " + scriptPath },
      { status: 500 }
    );
  }

  console.log("[Cron Scan] Triggering local hourly-scan.mjs in background...");

  try {
    // Spawn script in background so the request returns immediately and doesn't time out
    const child = spawn(process.execPath, [scriptPath], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();

    return NextResponse.json({
      ok: true,
      message: "Scan started in background",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[Cron Scan] Local spawn failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "unknown" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}

