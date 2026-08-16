import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config({ path: 'web/.env.local' });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  try {
    const sql = fs.readFileSync('schema-v2.sql', 'utf8');
    await pool.query(sql);
    console.log("Migration successful");
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

run();
