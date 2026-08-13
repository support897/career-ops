import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { checkBoardsStatus } from "@/lib/cookie-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const STATUS: Record<string, "live" | "empty" | "broken" | "skipped"> = {
  "✅": "live",
  "🟡": "empty",
  "❌": "broken",
  "➖": "skipped",
};

export async function GET() {
  const root = careerOpsRoot();
  const verifyPortals = rootScript("verify-portals");
  if (!fs.existsSync(verifyPortals)) {
    return Response.json({ available: false, configured: false, companies: [] });
  }
  if (!fs.existsSync(path.join(root, "portals.yml"))) {
    return Response.json({ available: true, configured: false, companies: [] });
  }

  // Check major board cookies first
  const boards = checkBoardsStatus();
  const boardCompanies = boards.map((b) => ({
    name: b.name,
    status: b.status === "missing" ? "skipped" : b.status,
    detail: b.detail,
  }));

  const stdout = await new Promise<string>((resolve) => {
    execFile(
      "node",
      [verifyPortals],
      { cwd: root, timeout: 110_000, maxBuffer: 4 * 1024 * 1024 },
      (_e, out, err) => resolve((out || "") + (err || "")),
    );
  });

  const companies: { name: string; status: string; detail: string }[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(✅|🟡|❌|➖)\s+(.+?)\s+—\s+(.*)$/);
    if (m) companies.push({ name: m[2].trim(), status: STATUS[m[1]] ?? "unknown", detail: m[3].trim() });
  }
  
  // Combine major boards at the top
  const combined = [...boardCompanies, ...companies];
  
  return Response.json({ available: true, configured: true, companies: combined });
}

