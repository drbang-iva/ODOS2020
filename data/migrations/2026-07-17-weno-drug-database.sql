CREATE TABLE IF NOT EXISTS odos_weno_drug_database (
    drug_db_code TEXT PRIMARY KEY CHECK (drug_db_code <> ''),
    drug_db_code_qualifier TEXT NOT NULL CHECK (drug_db_code_qualifier <> ''),
    quantity_unit_of_measure_code TEXT NOT NULL CHECK (quantity_unit_of_measure_code <> ''),
    quantity_unit_of_measure_display TEXT NOT NULL CHECK (quantity_unit_of_measure_display <> ''),
    dea_schedule_code TEXT NOT NULL CHECK (dea_schedule_code = 'C38046'),
    psn_description TEXT NOT NULL CHECK (psn_description <> ''),
    name_source TEXT NOT NULL CHECK (name_source IN ('psn', 'displayName', 'fullName')),
    route TEXT NOT NULL,
    strength TEXT NOT NULL,
    shelf_tag TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_weno_drug_database_description
    ON odos_weno_drug_database (lower(psn_description));
