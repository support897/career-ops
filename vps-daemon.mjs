#!/usr/bin/env node
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runLoop() {
  console.log('🚀 [24/7 VPS Daemon] Starting Career-Ops Auto-Apply Service...');

  while (true) {
    const startTime = new Date().toISOString();
    console.log(`\n⏰ [${startTime}] Launching automated job scan & application cycle...`);

    try {
      execSync('node auto-apply.mjs --userId default --local-vip --min-score 4.0 --max-age 14', {
        cwd: __dirname,
        stdio: 'inherit',
        env: { ...process.env },
      });
      console.log(`✅ [${new Date().toISOString()}] Cycle completed successfully.`);
    } catch (err) {
      console.error(`⚠️ [${new Date().toISOString()}] Cycle encountered error: ${err.message}`);
    }

    const nextRunMin = 60;
    console.log(`💤 Sleeping for ${nextRunMin} minutes until next cycle...\n`);
    await new Promise(resolve => setTimeout(resolve, nextRunMin * 60 * 1000));
  }
}

runLoop().catch(err => {
  console.error('Fatal daemon crash:', err);
  process.exit(1);
});
