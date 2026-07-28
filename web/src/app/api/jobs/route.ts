/**
 * /api/jobs — List jobs from DB with AI pipeline data.
 * GET /api/jobs?status=new|applied|discarded&sort=score|date
 * PATCH /api/jobs  body: { id, status: 'new'|'applied'|'discarded' }
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/user-context";
import { getInboxJobsByStatus, updateInboxJobStatus } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const userId = getUserId(request);
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") as "new" | "applied" | "discarded" | null;

  try {
    const jobs = await getInboxJobsByStatus(userId, status ?? undefined);
    return NextResponse.json({ jobs });
  } catch (e) {
    console.error("[GET /api/jobs]", e);
    return NextResponse.json({ error: "Failed to fetch jobs" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const userId = getUserId(request);

  let body: { id?: string; status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { id, status } = body;
  if (!id || !status || !["new", "applied", "discarded"].includes(status)) {
    return NextResponse.json({ error: "id and valid status required" }, { status: 400 });
  }

  try {
    const ok = await updateInboxJobStatus(userId, id, status as "new" | "applied" | "discarded");
    if (!ok) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[PATCH /api/jobs]", e);
    return NextResponse.json({ error: "Failed to update job" }, { status: 500 });
  }
}
