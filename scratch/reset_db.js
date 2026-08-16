import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: 'web/.env.local' });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  try {
    const res1 = await pool.query("UPDATE jobs SET status = 'pending' WHERE status IN ('applied', 'evaluated', 'processing')");
    console.log(`Reset ${res1.rowCount} jobs to pending in jobs table.`);

    const res2 = await pool.query("DELETE FROM job_inbox");
    console.log(`Cleared ${res2.rowCount} rows from job_inbox.`);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

run();
