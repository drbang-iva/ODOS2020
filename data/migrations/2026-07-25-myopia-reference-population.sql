CREATE TABLE IF NOT EXISTS odos_myopia_patient_settings (
    patient_reference TEXT PRIMARY KEY,
    reference_population TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT odos_myopia_patient_settings_patient_reference_check
      CHECK (patient_reference ~ '^Patient/[^/]+$'),
    CONSTRAINT odos_myopia_patient_settings_reference_population_check
      CHECK (reference_population IN ('ASIAN', 'CAUCASIAN', 'NOT_REPRESENTED'))
);
