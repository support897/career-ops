/**
 * user-context.ts — Single source of truth for the current user's identity.
 *
 * Resolution order:
 *  1. X-User-Id header (set by auth middleware / future Clerk/NextAuth)
 *  2. NEXT_PUBLIC_USER_ID env var (set in Vercel for single-user deployments)
 *  3. VIP_USER_ID env var (hardcoded for the owner's account)
 *  4. "default" fallback (safe — DB returns empty for unknown users)
 *
 * This runs server-side only.
 */

import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

export const VIP_EMAIL = "placenciailse@gmail.com";

/**
 * The single canonical database owner for this deployment. All data in the
 * shared Neon DB is keyed to this row (`users.id`); every query resolves any
 * tenant-ish alias (e.g. "default") back to this owner so no one else's rows
 * ever leak into a user's view.
 */
export const PRINCIPAL_USER_ID = "user_3GfaXsz2WyxzFl0LcD4ktVnNsCS";

/** The care-worker profile (NDIS/Disability/Aged Care) is a real tenant. */
export const SUPPORT_WORKER_USER_ID = "support_worker";

/**
 * Map any incoming userId to the actual data owner. Aliases that are not real
 * tenants ("default", "anonymous", empty) collapse to the principal user so
 * every query hits exactly ONE owner — never an OR across owners.
 */
export function resolveDataOwner(userId: string): string {
  if (!userId || userId === "default" || userId === "anonymous") return PRINCIPAL_USER_ID;
  return userId;
}

/**
 * Get userId from a Next.js request (server component, API route, or middleware).
 * Safe to call in any server context.
 */
export function getUserId(request?: Request | { headers: { get(name: string): string | null } }): string {
  if (request) {
    const header = request.headers.get?.("x-user-id");
    if (header) return header;
  }

  // Single-user / owner deployments: set NEXT_PUBLIC_USER_ID in Vercel
  const envUser = process.env.NEXT_PUBLIC_USER_ID ?? process.env.VIP_USER_ID;
  if (envUser) return envUser;

  return "default";
}

/**
 * Whether this user is the VIP (gets Gmail draft creation, LinkedIn/Indeed scans).
 */
export function isVipUser(userId: string): boolean {
  return (
    userId === VIP_EMAIL ||
    userId === "vip" ||
    userId === (process.env.VIP_USER_ID ?? VIP_EMAIL)
  );
}

/**
 * The Gmail credentials for VIP — env first, then the gitignored
 * config/email.yml (kept on-disk on the server; never committed).
 */
export function getGmailCredentials(): { user: string; password: string } {
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return { user: process.env.GMAIL_USER, password: process.env.GMAIL_APP_PASSWORD };
  }
  try {
    const raw = fs.readFileSync(path.join(careerOpsRoot(), "config", "email.yml"), "utf8");
    const user = /^\s*user:\s*["']?([^"'\s@]+@[^"'\s]+)["']?\s*$/m.exec(raw)?.[1] ?? process.env.GMAIL_USER ?? VIP_EMAIL;
    const password = /^\s*app_password:\s*["']?([^"'\s]+)["']?\s*$/m.exec(raw)?.[1] ?? "";
    if (user && password) return { user, password };
  } catch {
    // fall through — file missing is fine, callers handle empty creds
  }
  return { user: process.env.GMAIL_USER ?? VIP_EMAIL, password: "" };
}
