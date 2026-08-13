import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";

interface CookieConfig {
  exportedAt?: string;
  status?: string;
}

export function checkBoardsStatus() {
  const root = careerOpsRoot();
  const boards = ["seek", "linkedin", "indeed"];
  
  return boards.map((board) => {
    const file = path.join(root, "config", `${board}.yml`);
    if (!fs.existsSync(file)) {
      return { name: board, configured: false, status: "missing", days: -1, detail: "Configuration file config/" + board + ".yml is missing" };
    }
    
    try {
      const raw = fs.readFileSync(file, "utf8");
      const data = (yaml.load(raw) as Record<string, any>) || {};
      const config = data[board] as CookieConfig || {};
      const exportedAt = config.exportedAt ? new Date(config.exportedAt) : null;
      
      if (!exportedAt) {
        return { name: board, configured: false, status: "missing", days: -1, detail: "No session cookies detected in config/" + board + ".yml" };
      }
      
      const age = Date.now() - exportedAt.getTime();
      const days = Math.round(age / (24 * 60 * 60 * 1000));
      const isValid = days < 30;
      
      return {
        name: board === "seek" ? "SEEK" : board === "linkedin" ? "LinkedIn" : "Indeed",
        configured: true,
        status: isValid ? "live" : "broken",
        days,
        detail: isValid 
          ? `Cookies configured (exported ${days} days ago)`
          : `Cookies expired (exported ${days} days ago) — please re-export`,
      };
    } catch (e: any) {
      return { name: board, configured: false, status: "broken", days: -1, detail: "Failed to parse cookie config: " + e.message };
    }
  });
}
