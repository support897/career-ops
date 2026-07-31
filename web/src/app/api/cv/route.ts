import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/user-context";
import { getUserProfile, upsertUserProfile } from "@/lib/db";

const MAX_CV_BYTES = 200_000;

export async function GET(req: NextRequest) {
  try {
    const userId = getUserId(req);
    const profile = await getUserProfile(userId);
    if (profile && profile.cv_markdown) {
      return NextResponse.json({ content: profile.cv_markdown, exists: true });
    }

    // Local file fallbacks per tenant
    const { careerOpsRoot } = await import("@/lib/career-ops");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = careerOpsRoot();

    const relPath = userId === "support_worker" ? "cv-support.md" : "cv.md";
    const filePath = path.join(root, relPath);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      return NextResponse.json({ content, exists: true });
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
