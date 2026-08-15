import db from '../lib/db-client.mjs';

async function run() {
  const pool = db.getPool();
  const res = await pool.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'job_inbox'
  `);
  console.log(res.rows.map(r => r.column_name));
  await pool.end();
}
run();
