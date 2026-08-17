-- 002_scan_runs_detail.sql
--
-- scan_runs could only say "N new offers", never why. A run that found 16,023
-- jobs and added 0 looked identical to a run that found nothing at all — and
-- that is exactly the state this system sat in. These columns record the funnel
-- so the dashboard can show an honest scan status.
--
-- Safe to run repeatedly.

BEGIN;

ALTER TABLE scan_runs
  ADD COLUMN IF NOT EXISTS status             text NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS companies_scanned  integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS boards_scanned     integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS filtered_title     integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS filtered_location  integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS filtered_other     integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dupes              integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duration_ms        integer,
  ADD COLUMN IF NOT EXISTS host               text,
  ADD COLUMN IF NOT EXISTS note               text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scan_runs_status_chk') THEN
    ALTER TABLE scan_runs
      ADD CONSTRAINT scan_runs_status_chk
      CHECK (status IN ('completed', 'failed', 'partial', 'running'));
  END IF;
END $$;

COMMIT;
