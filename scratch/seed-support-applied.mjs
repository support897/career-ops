import pg from "pg";
import { readFileSync } from "fs";

const envFile = readFileSync("./web/.env.local", "utf8");
const match = envFile.match(/DATABASE_URL=(.+)/);
const dbUrl = match[1].trim().replace(/^["']/g, "");

const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function main() {
  const sampleJobs = [
    { company: "Kinsela Care", role: "Support Coordinator", score: 4.8, url: "https://au.jora.com/job/Specialist-Support-Coordinator-1" },
    { company: "Aspect Disability Services", role: "NDIS Support Coordinator", score: 4.6, url: "https://au.jora.com/job/NDIS-Support-Coordinator-2" },
    { company: "Hireup Australia", role: "Senior Support Coordinator", score: 4.5, url: "https://au.jora.com/job/Support-Coordinator-3" },
    { company: "Mind Australia", role: "Mental Health Support Coordinator", score: 4.2, url: "https://au.jora.com/job/Mental-Health-Coordinator-4" },
    { company: "Uniting Care", role: "Case Coordinator — Disability", score: 4.0, url: "https://au.jora.com/job/Case-Coordinator-5" },
    { company: "Ability First Australia", role: "Support Worker & Coordinator", score: 3.9, url: "https://au.jora.com/job/Support-Worker-6" },
  ];

  for (const j of sampleJobs) {
    await pool.query(
      `INSERT INTO job_inbox (user_id, url, company, role, location, score, job_status, doc_status, why_match, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       ON CONFLICT (user_id, url) DO UPDATE SET score = EXCLUDED.score, job_status = 'applied', doc_status = 'ready'`,
      ['support_worker', j.url, j.company, j.role, 'Remote, Australia', j.score, 'applied', 'ready', 'High match for NDIS Support Coordinator skills']
    );
  }

  console.log("Successfully inserted/updated 6 Support Coordinator jobs to APPLIED status!");
  await pool.end();
}

main().catch(console.error);
