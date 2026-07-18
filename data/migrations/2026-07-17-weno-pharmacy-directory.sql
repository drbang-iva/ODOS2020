CREATE TABLE IF NOT EXISTS odos_weno_pharmacy_directory (
    directory_key TEXT PRIMARY KEY CHECK (directory_key <> ''),
    created_at_vendor TIMESTAMPTZ,
    modified_at_vendor TIMESTAMPTZ,
    ncpdp_id TEXT,
    mutually_defined_id TEXT,
    npi TEXT,
    business_name TEXT NOT NULL,
    address_line_1 TEXT NOT NULL,
    address_line_2 TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    zip_code TEXT NOT NULL,
    country_code TEXT NOT NULL,
    international BOOLEAN NOT NULL,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    pharmacy_phone TEXT NOT NULL,
    test_pharmacy BOOLEAN NOT NULL,
    state_wide_mail_order BOOLEAN NOT NULL,
    mail_order_states_kind TEXT NOT NULL CHECK (mail_order_states_kind IN ('all', 'list')),
    mail_order_states_codes TEXT[] NOT NULL DEFAULT '{}',
    mail_order_territories_kind TEXT NOT NULL CHECK (mail_order_territories_kind IN ('all', 'list')),
    mail_order_territories_codes TEXT[] NOT NULL DEFAULT '{}',
    on_weno BOOLEAN NOT NULL,
    open_24_hours TEXT NOT NULL CHECK (open_24_hours IN ('yes', 'no', 'unknown')),
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT odos_weno_pharmacy_directory_routing_id CHECK (
        COALESCE(NULLIF(ncpdp_id, ''), NULLIF(mutually_defined_id, '')) IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_weno_pharmacy_directory_location
    ON odos_weno_pharmacy_directory (state, zip_code, city);
CREATE INDEX IF NOT EXISTS idx_weno_pharmacy_directory_name
    ON odos_weno_pharmacy_directory (lower(business_name));
CREATE INDEX IF NOT EXISTS idx_weno_pharmacy_directory_preferred
    ON odos_weno_pharmacy_directory (on_weno DESC, business_name);
CREATE INDEX IF NOT EXISTS idx_weno_pharmacy_directory_mail_order
    ON odos_weno_pharmacy_directory (state_wide_mail_order)
    WHERE state_wide_mail_order = true;
