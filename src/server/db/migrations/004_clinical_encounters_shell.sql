-- 004_clinical_encounters_shell.sql
-- Minimum viable clinical encounters table. SHELL ONLY — no exam field
-- structure. Exam sections (HPI, vitals, refraction, slit lamp, IOP,
-- assessment, plan, etc.) are added in follow-up migrations after Eric
-- red-pens each section.

---------------------------------------
-- CLINICAL ENCOUNTERS (SHELL)
---------------------------------------
CREATE TABLE clinical_encounters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  patient_id UUID NOT NULL REFERENCES patients(id),

  -- nullable: walk-ins may have no appointment
  appointment_id UUID REFERENCES appointments(id),

  provider_id UUID NOT NULL REFERENCES users(id),

  -- Lifecycle: draft = provider started but unsigned; signed = locked & ready
  -- for billing. Amendment handling is deferred until exam fields arrive.
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'signed')),

  -- When the provider opened the chart vs when they signed it
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- protocol_id is nullable placeholder for specialty-workflow attachment
  -- later (Ortho-K fitting protocol, dry eye treatment chain, VT progression,
  -- etc.). No foreign key yet because the protocols table doesn't exist.
  protocol_id UUID,

  signed_by UUID REFERENCES users(id),
  signed_at TIMESTAMPTZ,

  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Internal consistency: if status=signed, completed_at and signed_at must be set
  CHECK (status = 'draft' OR (completed_at IS NOT NULL AND signed_at IS NOT NULL AND signed_by IS NOT NULL))
);

CREATE INDEX idx_clinical_encounters_practice_patient ON clinical_encounters(practice_id, patient_id);
CREATE INDEX idx_clinical_encounters_appointment ON clinical_encounters(appointment_id);
CREATE INDEX idx_clinical_encounters_provider_date ON clinical_encounters(provider_id, started_at);
CREATE INDEX idx_clinical_encounters_status ON clinical_encounters(practice_id, status);
