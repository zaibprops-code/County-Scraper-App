-- ============================================================
-- Hillsborough County Lead Generator — Initial Schema
-- Run this in your Supabase SQL Editor to create all tables.
-- ============================================================

-- Track which source files have been processed (prevents re-download)
CREATE TABLE IF NOT EXISTS processed_files (
  id            BIGSERIAL PRIMARY KEY,
  filename      TEXT NOT NULL UNIQUE,
  source_type   TEXT NOT NULL CHECK (source_type IN ('probate', 'civil')),
  file_date     DATE,
  row_count     INTEGER DEFAULT 0,
  processed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Probate leads table
CREATE TABLE IF NOT EXISTS probate_leads (
  id              BIGSERIAL PRIMARY KEY,
  case_number     TEXT NOT NULL,
  filing_date     DATE,
  deceased_name   TEXT,
  petitioner      TEXT,
  attorney        TEXT,
  address         TEXT,
  city            TEXT,
  state           TEXT DEFAULT 'FL',
  zip             TEXT,
  county          TEXT DEFAULT 'Hillsborough',
  case_type       TEXT,
  source_file     TEXT,
  raw_data        JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(case_number, source_file)
);

-- Foreclosure / civil leads table
CREATE TABLE IF NOT EXISTS foreclosure_leads (
  id              BIGSERIAL PRIMARY KEY,
  case_number     TEXT NOT NULL,
  filing_date     DATE,
  plaintiff       TEXT,
  defendant       TEXT,
  attorney        TEXT,
  address         TEXT,
  city            TEXT,
  state           TEXT DEFAULT 'FL',
  zip             TEXT,
  county          TEXT DEFAULT 'Hillsborough',
  case_type       TEXT,
  source_file     TEXT,
  raw_data        JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(case_number, source_file)
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_probate_filing_date    ON probate_leads(filing_date DESC);
CREATE INDEX IF NOT EXISTS idx_probate_case_number    ON probate_leads(case_number);
CREATE INDEX IF NOT EXISTS idx_probate_deceased       ON probate_leads(deceased_name);
CREATE INDEX IF NOT EXISTS idx_probate_case_type      ON probate_leads(case_type);

CREATE INDEX IF NOT EXISTS idx_foreclosure_filing_date ON foreclosure_leads(filing_date DESC);
CREATE INDEX IF NOT EXISTS idx_foreclosure_case_number ON foreclosure_leads(case_number);
CREATE INDEX IF NOT EXISTS idx_foreclosure_defendant   ON foreclosure_leads(defendant);
CREATE INDEX IF NOT EXISTS idx_foreclosure_case_type   ON foreclosure_leads(case_type);

CREATE INDEX IF NOT EXISTS idx_processed_files_date   ON processed_files(file_date DESC);
