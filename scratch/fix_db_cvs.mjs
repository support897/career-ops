import { Pool } from 'pg';

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_oN60DfjuHaVl@ep-patient-sound-ausuu589.c-10.us-east-1.aws.neon.tech/neondb?sslmode=require',
});

async function run() {
  const { rows } = await pool.query(`SELECT id, cv_html FROM job_inbox WHERE cv_html IS NOT NULL`);
  console.log(`Found ${rows.length} records with cv_html`);
  
  let updated = 0;
  for (const app of rows) {
    let html = app.cv_html;
    if (html && !html.includes('--accent-color: #ff8bb1')) {
      html = html.replace('</head>', '<style>:root { --accent-color: #ff8bb1; }</style></head>');
      await pool.query(`UPDATE job_inbox SET cv_html = $1 WHERE id = $2`, [html, app.id]);
      updated++;
    }
  }
  console.log(`Updated ${updated} records.`);
  process.exit(0);
}

run();
