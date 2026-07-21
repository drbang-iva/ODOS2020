CREATE TABLE IF NOT EXISTS odos_encounter_diagnosis_statuses (
    condition_reference TEXT PRIMARY KEY,
    encounter_id TEXT NOT NULL,
    status TEXT NOT NULL,
    set_by TEXT NOT NULL,
    set_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_encounter_diagnosis_statuses_encounter
    ON odos_encounter_diagnosis_statuses (encounter_id);
