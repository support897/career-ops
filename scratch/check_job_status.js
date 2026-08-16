import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: 'web/.env.local' });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    const res = await pool.query("SELECT company, role, job_status FROM job_inbox WHERE doc_status = 'ready'");
    console.table(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

run();
