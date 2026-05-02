-- OSOD v0.55c CDS Hooks feedback persistence.

CREATE TABLE IF NOT EXISTS osod_cds_feedback (
    feedback_id UUID PRIMARY KEY,
    service_id TEXT NOT NULL,
    card_instance_uuid UUID NOT NULL,
    user_id TEXT NOT NULL,
    patient_id TEXT,
    encounter_id TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'overridden')),
    accepted_suggestion_uuids JSONB NOT NULL DEFAULT '[]'::jsonb,
    override_reason_code TEXT,
    override_reason_system TEXT,
    override_user_comment TEXT,
    outcome_timestamp TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS osod_cds_feedback_service_created_idx
    ON osod_cds_feedback (service_id, created_at DESC);

CREATE INDEX IF NOT EXISTS osod_cds_feedback_patient_created_idx
    ON osod_cds_feedback (patient_id, created_at DESC);
