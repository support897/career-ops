-- Store the styled cover letter, not just its plain text.
--
-- job_inbox has cv_html but only `cover_letter`, which holds the plain-text
-- version used as the email body. /api/documents?type=cl wrote that text into a
-- .html file and rendered a PDF from it, so the dashboard preview and the
-- download were unstyled text while the PDF attached to the Gmail draft was the
-- properly themed pink document. Two different cover letters for one job.
--
-- Idempotent.
ALTER TABLE job_inbox ADD COLUMN IF NOT EXISTS cover_letter_html TEXT;

COMMENT ON COLUMN job_inbox.cover_letter_html IS
  'Themed HTML of the cover letter, mirroring cv_html. cover_letter keeps the plain-text email body.';
