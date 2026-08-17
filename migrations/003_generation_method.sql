-- 003_generation_method.sql — add the column syncToInbox has always written.
--
-- lib/db-writer.mjs syncToInbox() lists generation_method in both its INSERT
-- column list and its ON CONFLICT DO UPDATE clause, but no migration ever
-- created it. Postgres rejects the whole statement, so EVERY evaluated job
-- failed with:
--   Sync to dashboard inbox failed: column "generation_method" of relation
--   "job_inbox" does not exist
-- The pipeline swallowed that error per job and carried on, which is why a
-- cycle could score 210 jobs while job_inbox stayed at its original 12 rows and
-- the dashboard showed nothing new.
--
-- Idempotent: safe to re-run.

ALTER TABLE job_inbox
  ADD COLUMN IF NOT EXISTS generation_method TEXT;

COMMENT ON COLUMN job_inbox.generation_method IS
  'How the documents were produced: llm (Gemini/Ollama) or template (deterministic fallback). Written by syncToInbox().';

-- Backfill the existing rows so the column is never ambiguously NULL for jobs
-- that already carry generated documents.
UPDATE job_inbox
   SET generation_method = 'unknown'
 WHERE generation_method IS NULL
   AND cv_html IS NOT NULL;
