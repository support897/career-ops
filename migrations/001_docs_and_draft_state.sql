-- 001_docs_and_draft_state.sql
--
-- Adds the storage this pipeline needs to work end to end:
--
--   * PDF bytes for the three tailored documents, stored in Postgres so the
--     Vercel dashboard can serve real downloads. Previously /api/documents
--     silently fell back to returning HTML, because the PDFs only ever existed
--     on the VPS filesystem, which Vercel cannot read.
--   * Honest Gmail draft state, so the UI can show whether a draft actually
--     exists in the mailbox rather than assuming it does. `gmail_draft_id`
--     already stores the IMAP uid; these columns record whether that uid was
--     verified to still be present, and when.
--   * applied_at, so the "Applied" button records a real transition time.
--   * source, so we can tell which board a job came from once scanning runs
--     across Seek, LinkedIn and the aggregator APIs.
--
-- Safe to run repeatedly: every statement is IF NOT EXISTS / conditional.

BEGIN;

ALTER TABLE job_inbox
  ADD COLUMN IF NOT EXISTS cv_pdf                  bytea,
  ADD COLUMN IF NOT EXISTS cl_pdf                  bytea,
  ADD COLUMN IF NOT EXISTS rl_pdf                  bytea,
  ADD COLUMN IF NOT EXISTS docs_generated_at       timestamptz,
  ADD COLUMN IF NOT EXISTS gmail_draft_state       text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS gmail_draft_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS applied_at              timestamptz,
  ADD COLUMN IF NOT EXISTS source                  text;

-- Constrain draft state to the four values the UI knows how to render.
--   none     : no draft attempted yet
--   created  : draft was created, not yet re-verified against the mailbox
--   verified : uid confirmed present in Gmail Drafts
--   missing  : uid was expected but is gone (deleted or never landed)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'job_inbox_gmail_draft_state_chk'
  ) THEN
    ALTER TABLE job_inbox
      ADD CONSTRAINT job_inbox_gmail_draft_state_chk
      CHECK (gmail_draft_state IN ('none', 'created', 'verified', 'missing'));
  END IF;
END $$;

-- Backfill: rows that already carry a Gmail uid are at least 'created'.
UPDATE job_inbox
   SET gmail_draft_state = 'created'
 WHERE gmail_draft_id IS NOT NULL
   AND gmail_draft_id <> ''
   AND gmail_draft_state = 'none';

CREATE INDEX IF NOT EXISTS idx_job_inbox_draft_state
  ON job_inbox (user_id, gmail_draft_state);

CREATE INDEX IF NOT EXISTS idx_job_inbox_applied_at
  ON job_inbox (user_id, applied_at DESC NULLS LAST);

COMMIT;
