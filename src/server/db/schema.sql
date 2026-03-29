-- OSOD Database Schema — Phase 1: Patients + Scheduling
-- PostgreSQL 17

-- Practices (multi-practice support from day one)
CREATE TABLE IF NOT EXISTS practices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Providers (doctors)
CREATE TABLE IF NOT EXISTS providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID REFERENCES practices(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  title TEXT DEFAULT 'O.D.',
  npi TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Patients
CREATE TABLE IF NOT EXISTS patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID REFERENCES practices(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  date_of_birth DATE NOT NULL,
  phone TEXT,
  email TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  
  -- Insurance
  primary_insurance TEXT,
  primary_insurance_id TEXT,
  vision_insurance TEXT,
  vision_insurance_id TEXT,
  
  -- Pharmacy (for WENO integration)
  pharmacy_name TEXT,
  pharmacy_ncpdp TEXT,
  
  -- Clinical (populated from EHR later)
  glasses_rx JSONB,
  contact_lens_rx JSONB,
  
  -- Financial
  balance NUMERIC(10,2) DEFAULT 0,
  
  -- Metadata
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Appointment types (configurable per provider)
CREATE TABLE IF NOT EXISTS appointment_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID REFERENCES practices(id),
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  color TEXT DEFAULT '#3b82f6',
  provider_id UUID REFERENCES providers(id), -- NULL = all providers
  active BOOLEAN DEFAULT true
);

-- Appointments
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID REFERENCES practices(id),
  patient_id UUID REFERENCES patients(id),
  provider_id UUID REFERENCES providers(id),
  appointment_type_id UUID REFERENCES appointment_types(id),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'scheduled', -- scheduled, checked_in, in_exam, checked_out, no_show, cancelled
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_patients_practice ON patients(practice_id);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_patients_dob ON patients(date_of_birth);
CREATE INDEX IF NOT EXISTS idx_appointments_provider_time ON appointments(provider_id, start_time);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
