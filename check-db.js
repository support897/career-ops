const { Client } = require('pg');
require('dotenv').config({ path: 'web/.env.local' });

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  console.log("--- USER PROFILES ---");
  const usersRes = await client.query("SELECT id, email, is_vip, google_account FROM user_profiles");
  console.log(usersRes.rows);

  console.log("\n--- JOB INBOX COUNT BY USER ---");
  const countsRes = await client.query("SELECT user_id, COUNT(*) FROM job_inbox GROUP BY user_id");
  console.log(countsRes.rows);

  console.log("\n--- LATEST 5 JOBS ---");
  const latestRes = await client.query("SELECT id, user_id, company, role, score, gmail_draft_id, doc_status FROM job_inbox ORDER BY created_at DESC LIMIT 5");
  console.log(latestRes.rows);

  await client.end();
}

main().catch(console.error);
