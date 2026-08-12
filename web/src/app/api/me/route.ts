import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { PRINCIPAL_USER_ID } from "@/lib/user-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sql = getSql();
    const users = await sql`SELECT id, email FROM users ORDER BY created_at ASC LIMIT 1`;
    if (users.length === 0) {
      return NextResponse.json({ userId: PRINCIPAL_USER_ID, email: null });
    }
    return NextResponse.json({ userId: users[0].id, email: users[0].email });
  } catch (e) {
    console.error("[GET /api/me]", e);
    // Never 500 the shell on a DB hiccup — fall back to the principal id so
    // the rest of the app still resolves to the owner's data.
    return NextResponse.json({ userId: PRINCIPAL_USER_ID, email: null });
  }
}
