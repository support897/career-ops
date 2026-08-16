import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function setupDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('❌ DATABASE_URL not set in .env');
    process.exit(1);
  }

  console.log('📦 Setting up Neon database schema...');
  
  const { Pool } = pg;
  const pool = new Pool({ connectionString: dbUrl });
  const sql = async (strings, ...values) => {
    const query = strings.reduce((prev, curr, i) => prev + '$' + i + curr);
    const res = await pool.query(query, values);
    return res.rows;
  };
  sql.query = (query, values) => pool.query(query, values);
  
  const statements = [
    `CREATE TABLE IF NOT EXISTS user_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT UNIQUE NOT NULL,
      email TEXT,
      full_name TEXT,
      location TEXT,
      timezone TEXT DEFAULT 'UTC',
      scanning_enabled BOOLEAN DEFAULT true,
      scan_frequency_hours INTEGER DEFAULT 6,
      platforms TEXT[],
      keywords TEXT[],
      location_filter TEXT[],
      cv_data JSONB,
      profile_config JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      last_scan_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS applications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      num TEXT NOT NULL,
      date DATE,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      score TEXT,
      status TEXT NOT NULL DEFAULT 'Evaluated',
      pdf_generated BOOLEAN DEFAULT false,
      report_path TEXT,
      notes TEXT,
      via TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, num)
    )`,
    `CREATE TABLE IF NOT EXISTS job_inbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      location TEXT,
      compensation TEXT,
      done BOOLEAN DEFAULT false,
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, url)
    )`,
    `CREATE TABLE IF NOT EXISTS scan_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      company TEXT,
      title TEXT,
      location TEXT,
      ats_source TEXT,
      first_seen DATE NOT NULL,
      last_seen DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, url)
    )`,
    `CREATE TABLE IF NOT EXISTS scan_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      users_scanned INTEGER DEFAULT 0,
      new_offers INTEGER DEFAULT 0,
      total_offers INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      report_num TEXT NOT NULL,
      company_slug TEXT NOT NULL,
      report_date DATE NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, report_num)
    )`,
    `CREATE TABLE IF NOT EXISTS portals_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT UNIQUE NOT NULL,
      title_filter JSONB,
      location_filter JSONB,
      tracked_companies JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_applications_user_id ON applications(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status)`,
    `CREATE INDEX IF NOT EXISTS idx_job_inbox_user_id ON job_inbox(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_scan_history_user_id ON scan_history(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_scan_runs_started_at ON scan_runs(started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports(user_id)`,
  ];
  
  let success = 0;
  let errors = 0;
  
  for (const stmt of statements) {
    try {
      await sql.query(stmt);
      success++;
    } catch (error) {
      if (error.message?.includes('already exists')) {
        success++;
      } else {
        console.error(`⚠️ Error: ${error.message?.substring(0, 80)}`);
        errors++;
      }
    }
  }
  
  console.log(`\n✅ Schema setup complete: ${success} statements executed, ${errors} errors`);
  
  // Verify tables
  const result = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
  
  console.log('\n📋 Tables in database:');
  for (const t of result) {
    console.log(`   - ${t.table_name}`);
  }
}

setupDatabase().catch(console.error);
