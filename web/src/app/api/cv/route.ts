import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/user-context";
import { getUserProfile, upsertUserProfile } from "@/lib/db";

const MAX_CV_BYTES = 200_000;

export async function GET(req: NextRequest) {
  try {
    const userId = getUserId(req);

    // DB is the source of truth (the web editor writes to it), so return it
    // first — the local file is only a fallback when a profile row is missing.
    const profile = await getUserProfile(userId).catch(() => null);
    if (profile) {
      const cvText = (profile as Record<string, unknown>).cv_markdown || (profile as Record<string, unknown>).cv_text;
      if (typeof cvText === "string" && cvText.trim().length > 10) {
        return NextResponse.json({ content: cvText, exists: true });
      }
    }

    // Fast local file read
    const { careerOpsRoot } = await import("@/lib/career-ops");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = careerOpsRoot();

    const relPath = userId === "support_worker" ? "config/cv-support-worker.md" : "cv.md";
    const filePath = path.join(root, relPath);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      if (content.trim().length > 10) {
        return NextResponse.json({ content, exists: true });
      }
    }

    return NextResponse.json({ content: "", exists: false });
  } catch (e) {
    console.error("[GET /api/cv]", e);
    return NextResponse.json({ error: "failed to read CV" }, { status: 500 });
  }
}



export async function POST(req: NextRequest) {
  try {
    const userId = getUserId(req);
    let body: { content?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "bad json" }, { status: 400 });
    }
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content required" }, { status: 400 });
    }
    if (Buffer.byteLength(body.content, "utf8") > MAX_CV_BYTES) {
      return NextResponse.json({ error: "CV is too large (over 200KB)" }, { status: 413 });
    }

    await upsertUserProfile(userId, { cv_markdown: body.content });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/cv]", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
