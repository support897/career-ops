import { neon } from '@neondatabase/serverless';

const sql = neon('postgresql://neondb_owner:npg_oN60DfjuHaVl@ep-patient-sound-ausuu589.c-10.us-east-1.aws.neon.tech/neondb?sslmode=require');

async function check() {
  const inboxUsers = await sql`SELECT DISTINCT user_id, COUNT(*) FROM job_inbox GROUP BY user_id;`;
  console.log('JOB INBOX USER_ID COUNTS:', inboxUsers);

  const appUsers = await sql`SELECT DISTINCT user_id, COUNT(*) FROM applications GROUP BY user_id;`.catch(e => console.log('applications table:', e.message));
  console.log('APPLICATIONS USER_ID COUNTS:', appUsers);
}

check().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
