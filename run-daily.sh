#!/bin/bash

# career-ops daily automation runner
# Runs the full pipeline: scan all sources → pre-screen → generate → send → report

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/output/logs"
TODAY=$(date +%Y-%m-%d)

# DB connection for VIP mode (loads profile, VIP status, encrypted credentials)
export DATABASE_URL="postgresql://neondb_owner:npg_oN60DfjuHaVl@ep-patient-sound-ausuu589.c-10.us-east-1.aws.neon.tech/neondb?sslmode=require"
export ENCRYPTION_KEY="e6372655010edff3b49a51385cc08e23f3e4126616e11f0963a7711c5a402503"

mkdir -p "$LOG_DIR"

echo "[$TODAY $(date +%H:%M:%S)] Starting auto-apply pipeline..."

cd "$SCRIPT_DIR"

# Step 0: Check cookie expiration for LinkedIn/Indeed/SEEK
echo "[$TODAY $(date +%H:%M:%S)] Step 0: Checking cookie status..."
node -e "
const fs = require('fs');
const platforms = [
  { name: 'LinkedIn', file: 'config/linkedin.yml' },
  { name: 'Indeed', file: 'config/indeed.yml' },
  { name: 'SEEK', file: 'config/seek.yml' },
];
for (const p of platforms) {
  if (!fs.existsSync(p.file)) { console.log(p.name + ': ❌ No cookies'); continue; }
  const yaml = fs.readFileSync(p.file, 'utf8');
  const match = yaml.match(/exportedAt:\s*\"([^\"]+)\"/);
  if (!match) { console.log(p.name + ': ❌ No date'); continue; }
  const days = Math.round((Date.now() - new Date(match[1]).getTime()) / 86400000);
  const remaining = 30 - days;
  if (remaining <= 0) console.log(p.name + ': ❌ EXPIRED (' + days + ' days)');
  else if (remaining <= 5) console.log(p.name + ': ⚠️  Expiring in ' + remaining + ' days');
  else console.log(p.name + ': ✅ Valid (' + remaining + ' days)');
}
" 2>&1 | tee "$LOG_DIR/cookies-$TODAY.log"

# Step 1: Scan tracked companies + job boards
echo "[$TODAY $(date +%H:%M:%S)] Step 1a: Scanning tracked companies and job boards..."
node scan.mjs --userId user_3GfaXsz2WyxzFl0LcD4ktVnNsCS 2>&1 | tee "$LOG_DIR/scan-$TODAY.log"

# Step 2: Reverse ATS scan — walks ALL Greenhouse/Lever/Ashby/Workday directories
echo "[$TODAY $(date +%H:%M:%S)] Step 1b: Scanning all ATS directories (Greenhouse/Lever/Ashby/Workday)..."
node scan-ats-full.mjs --since 3 2>&1 | tee -a "$LOG_DIR/scan-$TODAY.log"

# Step 3: Run the pipeline (pre-screen → generate → apply → email → report)
echo "[$TODAY $(date +%H:%M:%S)] Step 2: Running apply pipeline..."
node auto-apply.mjs --userId user_3GfaXsz2WyxzFl0LcD4ktVnNsCS 2>&1 | tee "$LOG_DIR/auto-apply-$TODAY.log"

EXIT_CODE=${PIPESTATUS[0]}

if [ $EXIT_CODE -eq 0 ]; then
    echo "[$TODAY $(date +%H:%M:%S)] Pipeline completed successfully"
else
    echo "[$TODAY $(date +%H:%M:%S)] Pipeline failed with exit code $EXIT_CODE"
fi

# Clean up logs older than 30 days
find "$LOG_DIR" -name "*.log" -mtime +30 -delete 2>/dev/null

exit $EXIT_CODE
