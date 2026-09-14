CREATE TABLE IF NOT EXISTS odos_encounter_diagnosis_newness_overrides (
    encounter_id TEXT NOT NULL,
    condition_reference TEXT NOT NULL,
    value TEXT NOT NULL CHECK (value IN ('new', 'established')),
    set_by TEXT NOT NULL,
    set_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (encounter_id, condition_reference)
);

INSERT INTO odos_encounter_diagnosis_newness_overrides (encounter_id, condition_reference, value, set_by, set_at)
SELECT encounter_id, condition_reference, 'new', set_by, set_at
FROM odos_encounter_diagnosis_statuses WHERE status = 'new'
ON CONFLICT (encounter_id, condition_reference) DO NOTHING;
