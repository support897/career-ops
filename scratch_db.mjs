
import { getPool } from './lib/db-writer.mjs';
const pool = getPool();
pool.query('ALTER TABLE job_inbox ADD COLUMN IF NOT EXISTS reference_letter TEXT').then(() => {
  console.log('Added reference_letter column');
  pool.end();
});

