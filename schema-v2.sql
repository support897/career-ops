-- Careerflow Schema Migration v2
-- Run AFTER schema.sql — extends job_inbox with AI pipeline columns
-- Safe to run multiple times (IF NOT EXISTS / DO NOTHING guards).

-- Add AI pipeline columns to job_inbox
ALTER TABLE job_inbox
  ADD COLUMN IF NOT EXISTS score NUMERIC(3,2),           -- career-ops 1.0–5.0
  ADD COLUMN IF NOT EXISTS score_breakdown JSONB,         -- { culture, tech, comp, fit, legit }
  ADD COLUMN IF NOT EXISTS why_match TEXT,                -- 1-3 sentence match reason
  ADD COLUMN IF NOT EXISTS jd_text TEXT,                  -- scraped job description text
  ADD COLUMN IF NOT EXISTS cv_html TEXT,                  -- tailored CV HTML for this job
  ADD COLUMN IF NOT EXISTS cover_letter TEXT,             -- personalized cover letter (plain text)
  ADD COLUMN IF NOT EXISTS email_draft TEXT,              -- outreach email (plain text)
  ADD COLUMN IF NOT EXISTS doc_status TEXT DEFAULT 'pending',  -- pending | generating | ready | failed
  ADD COLUMN IF NOT EXISTS job_status TEXT DEFAULT 'new',      -- new | applied | discarded
  ADD COLUMN IF NOT EXISTS apply_url TEXT,                -- direct application URL
  ADD COLUMN IF NOT EXISTS salary TEXT,                   -- advertised salary if available
  ADD COLUMN IF NOT EXISTS posted_at DATE,                -- when job was posted
  ADD COLUMN IF NOT EXISTS gmail_draft_id TEXT;           -- Gmail draft UID (VIP only)

-- Index for filtering by status
CREATE INDEX IF NOT EXISTS idx_job_inbox_job_status ON job_inbox(user_id, job_status);
CREATE INDEX IF NOT EXISTS idx_job_inbox_score ON job_inbox(user_id, score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_job_inbox_doc_status ON job_inbox(user_id, doc_status);

-- Add score_threshold to user_profiles so users can set minimum score for doc generation
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS score_threshold NUMERIC(3,2) DEFAULT 3.0,  -- min score to generate docs
  ADD COLUMN IF NOT EXISTS is_vip BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS google_account TEXT,          -- gmail address for VIP draft sending
  ADD COLUMN IF NOT EXISTS cv_markdown TEXT;             -- raw CV markdown content

-- Mark VIP user
UPDATE user_profiles SET is_vip = true, google_account = 'placenciailse@gmail.com'
  WHERE email = 'placenciailse@gmail.com';

