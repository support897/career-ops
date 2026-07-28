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

export const VIP_EMAIL = "placenciailse@gmail.com";

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
 * The Gmail credentials for VIP (from env or fallback to hardcoded config).
 * These are loaded at runtime on Lambda/Vercel — never committed to source.
 */
export function getGmailCredentials() {
  return {
    user: process.env.GMAIL_USER ?? VIP_EMAIL,
    password: process.env.GMAIL_APP_PASSWORD ?? "hptfiylhorjaakno",
  };
}
