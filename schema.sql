-- Careerflow Database Schema
-- Run this in Neon SQL Editor or via psql

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- User profiles and scanning configuration
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT UNIQUE NOT NULL,
  email TEXT,
  full_name TEXT,
  location TEXT,
  timezone TEXT DEFAULT 'UTC',
  
  -- Scanning configuration
  scanning_enabled BOOLEAN DEFAULT true,
  scan_mode TEXT DEFAULT 'interval',  -- 'schedule' | 'interval' | 'disabled'
  scan_frequency_hours INTEGER DEFAULT 6,  -- Used when scan_mode = 'interval'
  preferred_days INTEGER[] DEFAULT '{1,2,3,4,5}',  -- 0=Sun..6=Sat, used when scan_mode = 'schedule'
  preferred_hours INTEGER[] DEFAULT '{9,13,18}',   -- 0-23, used when scan_mode = 'schedule'
  platforms TEXT[], -- Array of platform names: ['greenhouse', 'ashby', 'lever', etc.]
  keywords TEXT[], -- Array of search keywords
  location_filter TEXT[], -- Array of location filters
  
  -- CV and profile data
  cv_data JSONB, -- Parsed CV data
  profile_config JSONB, -- Profile configuration from config/profile.yml
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_scan_at TIMESTAMPTZ
);

-- Applications tracker (replaces data/applications.md)
CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT NOT NULL,
  
  -- Application data
  num TEXT NOT NULL,
  date DATE,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  score TEXT, -- Format: "4.2/5" or "N/A"
  status TEXT NOT NULL DEFAULT 'Evaluated',
  pdf_generated BOOLEAN DEFAULT false,
  report_path TEXT,
  notes TEXT,
  via TEXT, -- Agency/recruiter if applicable
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Unique constraint: same user can't have duplicate company+role+num
  UNIQUE(user_id, num)
);

-- Job inbox/pipeline (replaces data/pipeline.md)
CREATE TABLE IF NOT EXISTS job_inbox (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT NOT NULL,
  
  -- Job data
  url TEXT NOT NULL,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  location TEXT,
  compensation TEXT,
  
  -- Status
  done BOOLEAN DEFAULT false,
  processed_at TIMESTAMPTZ,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Unique constraint: same user can't have duplicate URLs
  UNIQUE(user_id, url)
);

-- Scan history (replaces data/scan-history.tsv)
CREATE TABLE IF NOT EXISTS scan_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT NOT NULL,
  
  -- Job data
  url TEXT NOT NULL,
  company TEXT,
  title TEXT,
  location TEXT,
  ats_source TEXT, -- Which ATS it came from
  
  -- Timestamps
  first_seen DATE NOT NULL,
  last_seen DATE NOT NULL,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Unique constraint: same user can't have duplicate URLs
  UNIQUE(user_id, url)
);

-- Scan runs log (for tracking scan activity)
CREATE TABLE IF NOT EXISTS scan_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT NOT NULL,
  
  -- Run data
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  
  -- Results
  users_scanned INTEGER DEFAULT 0,
  new_offers INTEGER DEFAULT 0,
  total_offers INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reports (replaces reports/ directory)
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT NOT NULL,
  
  -- Report data
  report_num TEXT NOT NULL,
  company_slug TEXT NOT NULL,
  report_date DATE NOT NULL,
  content TEXT NOT NULL,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Unique constraint: same user can't have duplicate report numbers
  UNIQUE(user_id, report_num)
);

-- Portals configuration (replaces portals.yml for cloud users)
CREATE TABLE IF NOT EXISTS portals_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT UNIQUE NOT NULL,
  
  -- Configuration
  title_filter JSONB, -- { positive: [...], negative: [...] }
  location_filter JSONB, -- { allow: [...], block: [...], always_allow: [...] }
  tracked_companies JSONB, -- Array of company configurations
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_applications_user_id ON applications(user_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_job_inbox_user_id ON job_inbox(user_id);
CREATE INDEX IF NOT EXISTS idx_job_inbox_done ON job_inbox(done);
CREATE INDEX IF NOT EXISTS idx_scan_history_user_id ON scan_history(user_id);
CREATE INDEX IF NOT EXISTS idx_scan_history_first_seen ON scan_history(first_seen);
CREATE INDEX IF NOT EXISTS idx_scan_runs_user_id ON scan_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_scan_runs_started_at ON scan_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_num ON reports(report_num);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers
CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_applications_updated_at
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_job_inbox_updated_at
  BEFORE UPDATE ON job_inbox
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_portals_config_updated_at
  BEFORE UPDATE ON portals_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
