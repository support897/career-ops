import { getUserId } from "@/lib/user-context";
import { getInboxJobs, getApplications } from "@/lib/db";
import { headers } from "next/headers";
import { TodayDashboard } from "@/components/home/today-dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const hdrs = await headers();
  const userId = getUserId({ headers: { get: (k: string) => hdrs.get(k) } });

  // Cloud-mode: read from Neon DB (not local filesystem)
  const [inboxJobs, applications] = await Promise.all([
    getInboxJobs(userId).catch(() => []),
    getApplications(userId).catch(() => []),
  ]);

  // Map DB types to what TodayDashboard expects
  const inbox = inboxJobs.map((j) => ({
    url: j.url,
    company: j.company,
    role: j.role,
    location: j.location ?? undefined,
    compensation: j.compensation ?? undefined,
    done: j.done,
    postedAt: j.posted_at ?? undefined,
  }));

  // Determine if user is new (no data)
  const hasData = applications.length > 0 || inbox.some((j) => !j.done);

  if (!hasData) {
    // Show onboarding / empty state inline
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 text-center px-4">
        <div className="text-4xl">🚀</div>
        <h1 className="text-2xl font-bold">Welcome to Career-Ops</h1>
        <p className="text-muted max-w-md">
          Your AI-powered job search pipeline. Set up your profile and preferences,
          then let the scanner find and score opportunities for you.
        </p>
        <div className="flex gap-3 flex-wrap justify-center">
          <a
            href="/config"
            className="px-5 py-2.5 rounded-lg bg-accent text-white font-medium hover:opacity-90 transition"
          >
            Set Up Profile →
          </a>
          <a
            href="/jobs"
            className="px-5 py-2.5 rounded-lg border border-border font-medium hover:bg-surface transition"
          >
            View Jobs
          </a>
        </div>
      </div>
    );
  }

  return (
    <TodayDashboard
      applications={applications.map((a) => ({
        n: a.num,
        date: a.date || "",
        company: a.company,
        via: a.via || "",
        role: a.role,
        score: a.score || "",
        status: a.status,
        pdf: a.pdf_generated ? "✅" : "❌",
        report: a.report_path || "",
        notes: a.notes || "",
      }))}
      inbox={inbox}
      inBetween={false}
    />
  );
}
