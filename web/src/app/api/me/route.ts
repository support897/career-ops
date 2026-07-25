import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sql = neon(process.env.DATABASE_URL!);
  const users = await sql`SELECT id, email FROM users ORDER BY created_at ASC LIMIT 1`;
  if (users.length === 0) {
    return NextResponse.json({ userId: "default", email: null });
  }
  return NextResponse.json({ userId: users[0].id, email: users[0].email });
}
