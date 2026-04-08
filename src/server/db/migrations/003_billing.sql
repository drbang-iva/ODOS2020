-- 003_billing.sql
-- Phase 1 billing data model: fee schedules, charges, payments, adjustments, patient ledger.
-- Designed to plug into Claim.MD (clearinghouse) in a future phase without schema changes.

---------------------------------------
-- FEE SCHEDULES
---------------------------------------
-- A practice can have multiple fee schedules (Medicare, Medicaid, custom, vision plan S-codes, cash).
-- Each schedule is a named collection of CPT/HCPCS codes with prices.
CREATE TABLE fee_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  description TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (practice_id, name)
);

CREATE INDEX idx_fee_schedules_practice ON fee_schedules(practice_id);

---------------------------------------
-- FEE SCHEDULE ITEMS
---------------------------------------
-- Each row is a CPT/HCPCS code → price mapping.
-- modifier is optional (e.g., "26" for professional component, "RT"/"LT" for laterality).
CREATE TABLE fee_schedule_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_schedule_id UUID NOT NULL REFERENCES fee_schedules(id) ON DELETE CASCADE,
  cpt_code TEXT NOT NULL,
  modifier TEXT,
  description TEXT,
  amount_cents INT NOT NULL CHECK (amount_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fee_schedule_id, cpt_code, modifier)
);

CREATE INDEX idx_fee_schedule_items_schedule ON fee_schedule_items(fee_schedule_id);
CREATE INDEX idx_fee_schedule_items_cpt ON fee_schedule_items(cpt_code);

-- Partial unique index: prevent duplicate CPT when modifier is NULL
-- (Postgres treats NULLs as distinct in unique constraints, so the table
-- UNIQUE clause doesn't catch this case.)
CREATE UNIQUE INDEX idx_fee_schedule_items_no_modifier
  ON fee_schedule_items (fee_schedule_id, cpt_code)
  WHERE modifier IS NULL;

---------------------------------------
-- CHARGES
---------------------------------------
-- A charge is a billable line item posted against a patient and (optionally) an appointment.
-- One service rendered = one charge. A visit produces multiple charges.
CREATE TABLE charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  patient_id UUID NOT NULL REFERENCES patients(id),
  appointment_id UUID REFERENCES appointments(id),
  provider_id UUID NOT NULL REFERENCES users(id),
  service_date DATE NOT NULL,
  cpt_code TEXT NOT NULL,
  modifier TEXT,
  icd10_codes TEXT[] NOT NULL DEFAULT '{}',
  description TEXT,
  units INT NOT NULL DEFAULT 1 CHECK (units > 0),
  unit_amount_cents INT NOT NULL CHECK (unit_amount_cents >= 0),
  total_amount_cents INT NOT NULL CHECK (total_amount_cents >= 0),
  insurance_responsibility_cents INT NOT NULL DEFAULT 0,
  patient_responsibility_cents INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'paid', 'denied', 'voided', 'partial')),
  fee_schedule_id UUID REFERENCES fee_schedules(id),
  notes TEXT,
  voided_reason TEXT,
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_charges_practice_patient ON charges(practice_id, patient_id);
CREATE INDEX idx_charges_practice_service_date ON charges(practice_id, service_date);
CREATE INDEX idx_charges_appointment ON charges(appointment_id);
CREATE INDEX idx_charges_status ON charges(practice_id, status);

---------------------------------------
-- PAYMENTS
---------------------------------------
-- A payment is money received. Either from a patient (cash/card/check) or from a payer (EOB).
-- A single payment may be applied across multiple charges (one row per application in payment_applications).
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  patient_id UUID REFERENCES patients(id),
  payment_type TEXT NOT NULL CHECK (payment_type IN ('patient', 'carrier')),
  payment_method TEXT NOT NULL
    CHECK (payment_method IN ('cash', 'check', 'credit_card', 'debit_card', 'eft', 'ach', 'era', 'other')),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  unapplied_cents INT NOT NULL CHECK (unapplied_cents >= 0),
  payer_name TEXT,
  reference_number TEXT,
  payment_date DATE NOT NULL,
  notes TEXT,
  voided_reason TEXT,
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_practice_patient ON payments(practice_id, patient_id);
CREATE INDEX idx_payments_practice_date ON payments(practice_id, payment_date);

---------------------------------------
-- PAYMENT APPLICATIONS
---------------------------------------
-- Junction table: how much of a payment was applied to which charge.
-- Allows split payments (one $500 check across 3 charges) and partial applications.
CREATE TABLE payment_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  charge_id UUID NOT NULL REFERENCES charges(id),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by UUID NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_payment_applications_payment ON payment_applications(payment_id);
CREATE INDEX idx_payment_applications_charge ON payment_applications(charge_id);

---------------------------------------
-- ADJUSTMENTS
---------------------------------------
-- Write-offs, contractual adjustments, refunds, sliding scale, etc.
-- Always linked to a specific charge.
CREATE TABLE adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  charge_id UUID NOT NULL REFERENCES charges(id),
  adjustment_type TEXT NOT NULL
    CHECK (adjustment_type IN ('contractual', 'writeoff', 'refund', 'discount', 'sliding_scale', 'courtesy', 'other')),
  amount_cents INT NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_adjustments_charge ON adjustments(charge_id);
CREATE INDEX idx_adjustments_practice ON adjustments(practice_id);

---------------------------------------
-- PATIENT LEDGER VIEW
---------------------------------------
-- A computed view that gives the running balance per patient.
-- Charges add to balance, payments and adjustments subtract.
CREATE VIEW patient_ledger AS
SELECT
  p.id AS patient_id,
  p.practice_id,
  COALESCE(charges.total, 0) AS total_charged_cents,
  COALESCE(patient_pmts.total, 0) AS total_patient_paid_cents,
  COALESCE(carrier_pmts.total, 0) AS total_carrier_paid_cents,
  COALESCE(adj.total, 0) AS total_adjustments_cents,
  COALESCE(charges.total, 0)
    - COALESCE(patient_pmts.total, 0)
    - COALESCE(carrier_pmts.total, 0)
    - COALESCE(adj.total, 0) AS balance_cents
FROM patients p
LEFT JOIN (
  SELECT patient_id, SUM(total_amount_cents) AS total
  FROM charges WHERE status != 'voided'
  GROUP BY patient_id
) charges ON charges.patient_id = p.id
LEFT JOIN (
  SELECT pa.charge_id, c.patient_id, SUM(pa.amount_cents) AS total
  FROM payment_applications pa
  JOIN charges c ON c.id = pa.charge_id
  JOIN payments pmt ON pmt.id = pa.payment_id
  WHERE pmt.payment_type = 'patient' AND pmt.voided_at IS NULL
  GROUP BY pa.charge_id, c.patient_id
) patient_pmts ON patient_pmts.patient_id = p.id
LEFT JOIN (
  SELECT pa.charge_id, c.patient_id, SUM(pa.amount_cents) AS total
  FROM payment_applications pa
  JOIN charges c ON c.id = pa.charge_id
  JOIN payments pmt ON pmt.id = pa.payment_id
  WHERE pmt.payment_type = 'carrier' AND pmt.voided_at IS NULL
  GROUP BY pa.charge_id, c.patient_id
) carrier_pmts ON carrier_pmts.patient_id = p.id
LEFT JOIN (
  SELECT c.patient_id, SUM(a.amount_cents) AS total
  FROM adjustments a
  JOIN charges c ON c.id = a.charge_id
  GROUP BY c.patient_id
) adj ON adj.patient_id = p.id;
