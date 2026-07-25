import { neon } from '@neondatabase/serverless';

async function migrate() {
  const sql = neon(process.env.DATABASE_URL);
  
  const migrations = [
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS scan_mode TEXT DEFAULT 'interval'`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS preferred_days INTEGER[] DEFAULT '{1,2,3,4,5}'`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS preferred_hours INTEGER[] DEFAULT '{9,13,18}'`,
  ];
  
  for (const m of migrations) {
    try {
      await sql.query(m);
      console.log(`✅ ${m.substring(0, 60)}...`);
    } catch (e) {
      if (e.message?.includes('already exists')) {
        console.log(`⏭️  Column already exists`);
      } else {
        console.error(`❌ ${e.message}`);
      }
    }
  }
  
  // Verify
  const result = await sql`SELECT column_name, data_type, column_default 
    FROM information_schema.columns 
    WHERE table_name = 'user_profiles' 
    ORDER BY ordinal_position`;
  
  console.log('\nuser_profiles columns:');
  for (const r of result) {
    console.log(`  ${r.column_name}: ${r.data_type} = ${r.column_default}`);
  }
}

migrate().catch(console.error);
