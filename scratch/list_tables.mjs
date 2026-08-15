import { Pool } from 'pg';

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_oN60DfjuHaVl@ep-patient-sound-ausuu589.c-10.us-east-1.aws.neon.tech/neondb?sslmode=require',
});

async function run() {
  const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  console.log(rows);
  process.exit(0);
}

run();
