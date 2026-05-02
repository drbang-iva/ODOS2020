-- OSOD v0.55c encrypted CDS service key material storage.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS osod_cds_services_keys (
    key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id TEXT NOT NULL,
    key_use TEXT NOT NULL,
    encrypted_key_material BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS osod_cds_services_keys_service_idx
    ON osod_cds_services_keys (service_id, created_at DESC);

CREATE OR REPLACE FUNCTION osod_store_cds_service_key(
    p_service_id TEXT,
    p_key_use TEXT,
    p_key_material TEXT,
    p_encryption_secret TEXT
) RETURNS UUID AS $$
DECLARE
    stored_id UUID;
BEGIN
    INSERT INTO osod_cds_services_keys (service_id, key_use, encrypted_key_material)
    VALUES (p_service_id, p_key_use, pgp_sym_encrypt(p_key_material, p_encryption_secret))
    RETURNING key_id INTO stored_id;
    RETURN stored_id;
END;
$$ LANGUAGE plpgsql;
