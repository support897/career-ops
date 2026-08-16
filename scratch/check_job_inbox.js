import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: 'web/.env.local' });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    const res = await pool.query("SELECT COUNT(*) FROM job_inbox");
    console.log(`job_inbox has ${res.rows[0].count} rows.`);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

run();
