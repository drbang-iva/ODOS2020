-- 002_schema_v2.sql
-- Applies decisions from performance-od/decisions/2026-04-07-osod-treatment-library-schema-decisions.md

---------------------------------------
-- PATIENT SCHEMA ADDITIONS (Decision 2)
---------------------------------------
ALTER TABLE patients ADD COLUMN middle_name TEXT;
ALTER TABLE patients ADD COLUMN ssn_encrypted TEXT;
ALTER TABLE patients ADD COLUMN employer TEXT;
ALTER TABLE patients ADD COLUMN occupation TEXT;
ALTER TABLE patients ADD COLUMN hobbies TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE patients ADD COLUMN referring_provider TEXT;
ALTER TABLE patients ADD COLUMN referring_provider_npi TEXT;
ALTER TABLE patients ADD COLUMN preferred_pharmacy_npi TEXT;
ALTER TABLE patients ADD COLUMN race TEXT;
ALTER TABLE patients ADD COLUMN ethnicity TEXT;

---------------------------------------
-- RESPONSIBLE PARTIES (Decision 3)
---------------------------------------
CREATE TABLE responsible_parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  responsible_party_patient_id UUID REFERENCES patients(id),
  relationship TEXT NOT NULL
    CHECK (relationship IN ('parent', 'legal_guardian', 'spouse', 'self', 'other')),
  is_financial_responsible BOOLEAN NOT NULL DEFAULT false,
  is_consent_authority BOOLEAN NOT NULL DEFAULT false,
  is_insurance_subscriber BOOLEAN NOT NULL DEFAULT false,
  insurance_subscriber_id TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  court_order_notes TEXT,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_responsible_parties_patient ON responsible_parties(patient_id);
CREATE INDEX idx_responsible_parties_responsible ON responsible_parties(responsible_party_patient_id);

---------------------------------------
-- PERMISSION MODEL (Decision 4)
---------------------------------------

CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  permission_set TEXT[] NOT NULL DEFAULT '{}',
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (practice_id, name)
);

CREATE INDEX idx_user_roles_practice ON user_roles(practice_id);

CREATE TABLE user_role_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES user_roles(id) ON DELETE CASCADE,
  service_line_id UUID REFERENCES service_lines(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, role_id, service_line_id)
);

CREATE INDEX idx_user_role_assignments_user ON user_role_assignments(user_id);
CREATE INDEX idx_user_role_assignments_role ON user_role_assignments(role_id);

-- Prevent duplicate role assignments when service_line_id is NULL
CREATE UNIQUE INDEX idx_unique_role_assignment_no_sl
  ON user_role_assignments (user_id, role_id)
  WHERE service_line_id IS NULL;

-- Keep legacy role column but relax constraints for migration path
ALTER TABLE users ALTER COLUMN role DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

---------------------------------------
-- TREATMENT LIBRARY (Decision 1)
---------------------------------------

CREATE TABLE treatment_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  standard_name TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT,
  typical_duration_minutes INT NOT NULL,
  cpt_codes TEXT[] NOT NULL DEFAULT '{}',
  equipment_tags TEXT[] NOT NULL DEFAULT '{}',
  provider_scope TEXT[] NOT NULL DEFAULT '{}',
  service_lines TEXT[] NOT NULL DEFAULT '{}',
  body_area_modifiers_available BOOLEAN NOT NULL DEFAULT false,
  consent_required BOOLEAN NOT NULL DEFAULT false,
  is_billable BOOLEAN NOT NULL DEFAULT true,
  default_color TEXT NOT NULL DEFAULT '#3B82F6',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_treatment_library_category ON treatment_library(category);
CREATE INDEX idx_treatment_library_service_lines ON treatment_library USING GIN(service_lines);

CREATE TABLE body_area_modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID REFERENCES practices(id),
  name TEXT NOT NULL,
  short_code TEXT NOT NULL,
  duration_adjustment_minutes INT NOT NULL DEFAULT 0,
  additional_equipment_tags TEXT[] NOT NULL DEFAULT '{}',
  additional_consent BOOLEAN NOT NULL DEFAULT false,
  is_system BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Refactor appointment_types
ALTER TABLE appointment_types ADD COLUMN library_id UUID REFERENCES treatment_library(id);
ALTER TABLE appointment_types ADD COLUMN display_name TEXT;
ALTER TABLE appointment_types ADD COLUMN service_line_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE appointment_types ADD COLUMN body_area_modifier_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE appointment_types ADD COLUMN equipment_tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE appointment_types ADD COLUMN provider_scope TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE appointment_types ADD COLUMN is_custom BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE appointment_types ADD COLUMN price_cents INT;
ALTER TABLE appointment_types ADD COLUMN cpt_codes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE appointment_types ADD COLUMN requires_consultation BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE appointment_types ADD COLUMN series_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE appointment_types ADD COLUMN series_count INT;
ALTER TABLE appointment_types ADD COLUMN online_bookable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE appointment_types ADD COLUMN photo_required BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing rows
UPDATE appointment_types SET display_name = name WHERE display_name IS NULL;
UPDATE appointment_types SET service_line_ids = ARRAY[service_line_id] WHERE service_line_ids = '{}';
