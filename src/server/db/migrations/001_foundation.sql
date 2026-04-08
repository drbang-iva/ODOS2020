-- OSOD Foundation Schema
-- All Phase 1 tables: practices, users, patients, scheduling, equipment, audit

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

---------------------------------------
-- PRACTICES
---------------------------------------
CREATE TABLE practices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  schedule_block_minutes INT NOT NULL DEFAULT 15
    CHECK (schedule_block_minutes IN (10, 15, 20, 30)),
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

---------------------------------------
-- SERVICE LINES
---------------------------------------
CREATE TABLE service_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3B82F6',
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_service_lines_practice ON service_lines(practice_id);

---------------------------------------
-- USERS
---------------------------------------
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  email TEXT NOT NULL,
  password_hash TEXT,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'provider', 'staff', 'agent')),
  is_provider BOOLEAN NOT NULL DEFAULT false,
  service_line_ids UUID[] NOT NULL DEFAULT '{}',
  permissions JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (practice_id, email)
);

CREATE INDEX idx_users_practice ON users(practice_id);

---------------------------------------
-- AGENT KEYS
---------------------------------------
CREATE TABLE agent_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  user_id UUID NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  model_type TEXT NOT NULL CHECK (model_type IN ('local', 'cloud')),
  scopes TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_keys_practice ON agent_keys(practice_id);

---------------------------------------
-- PATIENTS
---------------------------------------
CREATE TABLE patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  date_of_birth DATE NOT NULL,
  sex TEXT NOT NULL CHECK (sex IN ('M', 'F', 'X')),
  email TEXT,
  phone_primary TEXT NOT NULL,
  phone_secondary TEXT,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  preferred_pharmacy TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'en',
  communication_pref TEXT NOT NULL DEFAULT 'phone'
    CHECK (communication_pref IN ('email', 'phone', 'text', 'mail')),
  balance_cents INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patients_practice_name ON patients(practice_id, last_name, first_name);
CREATE INDEX idx_patients_practice_dob ON patients(practice_id, date_of_birth);

---------------------------------------
-- PATIENT INSURANCE
---------------------------------------
CREATE TABLE patient_insurance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  priority INT NOT NULL CHECK (priority BETWEEN 1 AND 3),
  plan_type TEXT NOT NULL CHECK (plan_type IN ('medical', 'vision')),
  payer_name TEXT NOT NULL,
  payer_id TEXT,
  member_id TEXT NOT NULL,
  group_number TEXT,
  subscriber_name TEXT,
  subscriber_dob DATE,
  subscriber_relationship TEXT NOT NULL DEFAULT 'self'
    CHECK (subscriber_relationship IN ('self', 'spouse', 'child', 'other')),
  effective_date DATE NOT NULL,
  termination_date DATE,
  copay_cents INT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patient_insurance_patient ON patient_insurance(patient_id);

---------------------------------------
-- PATIENT CONTACTS
---------------------------------------
CREATE TABLE patient_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL
    CHECK (contact_type IN ('emergency', 'responsible_party', 'guardian')),
  full_name TEXT NOT NULL,
  relationship TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patient_contacts_patient ON patient_contacts(patient_id);

---------------------------------------
-- PATIENT ALERTS
---------------------------------------
CREATE TABLE patient_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL
    CHECK (alert_type IN ('allergy', 'balance', 'clinical', 'scheduling', 'custom')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message TEXT NOT NULL,
  is_resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patient_alerts_patient ON patient_alerts(patient_id);

---------------------------------------
-- APPOINTMENT TYPES
---------------------------------------
CREATE TABLE appointment_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  service_line_id UUID NOT NULL REFERENCES service_lines(id),
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3B82F6',
  duration_blocks INT NOT NULL CHECK (duration_blocks > 0),
  default_reason TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_appointment_types_practice ON appointment_types(practice_id);

---------------------------------------
-- PROVIDER SCHEDULES
---------------------------------------
CREATE TABLE provider_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES users(id),
  day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  service_line_id UUID NOT NULL REFERENCES service_lines(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (start_time < end_time)
);

CREATE INDEX idx_provider_schedules_provider ON provider_schedules(provider_id);

---------------------------------------
-- SCHEDULE OVERRIDES
---------------------------------------
CREATE TABLE schedule_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES users(id),
  override_date DATE NOT NULL,
  override_type TEXT NOT NULL CHECK (override_type IN ('blocked', 'modified')),
  start_time TIME,
  end_time TIME,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_schedule_overrides_provider_date ON schedule_overrides(provider_id, override_date);

---------------------------------------
-- APPOINTMENTS
---------------------------------------
CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  patient_id UUID NOT NULL REFERENCES patients(id),
  provider_id UUID NOT NULL REFERENCES users(id),
  appointment_type_id UUID NOT NULL REFERENCES appointment_types(id),
  service_line_id UUID NOT NULL REFERENCES service_lines(id),
  start_time TIMESTAMPTZ NOT NULL,
  duration_blocks INT NOT NULL CHECK (duration_blocks > 0),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show')),
  chief_complaint TEXT,
  notes TEXT,
  cancelled_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  checked_in_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_appointments_provider_time ON appointments(provider_id, start_time);
CREATE INDEX idx_appointments_patient_time ON appointments(patient_id, start_time);
CREATE INDEX idx_appointments_practice_time_status ON appointments(practice_id, start_time, status);

---------------------------------------
-- EQUIPMENT REGISTRY
---------------------------------------
CREATE TABLE equipment_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  device_category TEXT NOT NULL
    CHECK (device_category IN ('oct', 'visual_field', 'autorefractor', 'phoropter', 'tonometer', 'retinal_camera', 'topographer', 'lensometer', 'meibographer', 'specialty', 'aesthetics')),
  integration_type TEXT NOT NULL
    CHECK (integration_type IN ('dicom', 'folder_watch', 'serial', 'manual')),
  connection_config JSONB NOT NULL DEFAULT '{}',
  location TEXT,
  data_types TEXT[] NOT NULL DEFAULT '{}',
  parser_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_equipment_registry_practice ON equipment_registry(practice_id);

---------------------------------------
-- DEVICE READINGS
---------------------------------------
CREATE TABLE device_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  equipment_id UUID NOT NULL REFERENCES equipment_registry(id),
  patient_id UUID REFERENCES patients(id),
  matched_by TEXT CHECK (matched_by IN ('mwl', 'room_assignment', 'manual', 'ai_match')),
  reading_type TEXT NOT NULL,
  structured_data JSONB NOT NULL DEFAULT '{}',
  raw_data_ref TEXT,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('dicom', 'folder_watch', 'serial', 'manual', 'ai_extraction')),
  confidence DECIMAL,
  needs_review BOOLEAN NOT NULL DEFAULT false,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_device_readings_patient ON device_readings(patient_id);
CREATE INDEX idx_device_readings_equipment ON device_readings(equipment_id);

---------------------------------------
-- AUDIT EVENTS (append-only)
---------------------------------------
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'access')),
  actor_id UUID NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'local_agent', 'cloud_agent')),
  model_name TEXT,
  confidence DECIMAL,
  ip_address TEXT,
  previous_state JSONB,
  new_state JSONB,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_events(actor_id, created_at);
CREATE INDEX idx_audit_time ON audit_events(created_at);

-- Prevent UPDATE and DELETE on audit_events
CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % operations are not allowed', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE TRIGGER audit_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
