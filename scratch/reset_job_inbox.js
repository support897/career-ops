import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: 'web/.env.local' });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  try {
    const res = await pool.query("UPDATE job_inbox SET job_status = 'evaluated', doc_status = 'pending' WHERE job_status = 'applied'");
    console.log(`Updated ${res.rowCount} rows in job_inbox.`);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

run();
