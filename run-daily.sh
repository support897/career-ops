#!/bin/bash

# career-ops daily automation runner — VIP local mode
#
# Runs the full pipeline locally on your Mac/PC:
#   scan tracked companies + job boards → reverse ATS scan → auto-apply pipeline
#
# This avoids AWS Lambda compute charges for scheduled runs.
# Recommended: schedule via cron (e.g. once per day at 08:00).
#
# Usage:
#   ./run-daily.sh                          # run for default VIP user
#   ./run-daily.sh --userId <clerkId>       # run for another user
#   ./run-daily.sh --dry-run                # preview without sending applications/emails
#   ./run-daily.sh --userId <id> --dry-run  # combine both

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/output/logs"
TODAY=$(date +%Y-%m-%d)

# Default VIP user (override with --userId <clerkId>)
DEFAULT_USER_ID="user_3GfaXsz2WyxzFl0LcD4ktVnNsCS"
USER_ID="$DEFAULT_USER_ID"
DRY_RUN=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --userId)
      USER_ID="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="--dry-run"
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [--userId <clerkId>] [--dry-run]"
      exit 1
      ;;
  esac
done

# DB connection for VIP mode (loads profile, VIP status, encrypted credentials from Neon)
export DATABASE_URL="postgresql://neondb_owner:npg_oN60DfjuHaVl@ep-patient-sound-ausuu589.c-10.us-east-1.aws.neon.tech/neondb?sslmode=require"
export ENCRYPTION_KEY="e6372655010edff3b49a51385cc08e23f3e4126616e11f0963a7711c5a402503"

mkdir -p "$LOG_DIR"

echo "[$TODAY $(date +%H:%M:%S)] Starting auto-apply pipeline for user $USER_ID..."
if [ -n "$DRY_RUN" ]; then
  echo "[$TODAY $(date +%H:%M:%S)] ⚠️  DRY RUN — no applications or emails will be sent"
fi

cd "$SCRIPT_DIR"

# Step 1: Scan tracked companies + job boards
echo "[$TODAY $(date +%H:%M:%S)] Step 1a: Scanning tracked companies and job boards..."
if ! node scan.mjs --userId "$USER_ID" 2>&1 | tee "$LOG_DIR/scan-$TODAY.log"; then
  echo "[$TODAY $(date +%H:%M:%S)] ⚠️  Scan failed but continuing with existing data..."
fi

# Step 2: Reverse ATS scan — walks ALL Greenhouse/Lever/Ashby/Workday directories
echo "[$TODAY $(date +%H:%M:%S)] Step 1b: Scanning all ATS directories (Greenhouse/Lever/Ashby/Workday)..."
if ! node scan-ats-full.mjs --since 3 2>&1 | tee -a "$LOG_DIR/scan-$TODAY.log"; then
  echo "[$TODAY $(date +%H:%M:%S)] ⚠️  ATS scan failed but continuing with existing data..."
fi

# Step 3: Run the pipeline (pre-screen → generate → apply → email → report)
echo "[$TODAY $(date +%H:%M:%S)] Step 2: Running apply pipeline..."
if node auto-apply.mjs --userId "$USER_ID" $DRY_RUN 2>&1 | tee "$LOG_DIR/auto-apply-$TODAY.log"; then
  EXIT_CODE=0
else
  EXIT_CODE=$?
fi

if [ $EXIT_CODE -eq 0 ]; then
    echo "[$TODAY $(date +%H:%M:%S)] Pipeline completed successfully"
else
    echo "[$TODAY $(date +%H:%M:%S)] Pipeline failed with exit code $EXIT_CODE"
fi

# Clean up logs older than 30 days
find "$LOG_DIR" -name "*.log" -mtime +30 -delete 2>/dev/null

exit $EXIT_CODE
