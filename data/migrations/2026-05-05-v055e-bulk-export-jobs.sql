-- OSOD v0.55e local-only Bulk Data async export job table.
-- The table is source-of-truth state; output_dir points to practice-controlled local storage only.

CREATE TABLE IF NOT EXISTS osod_bulk_export_jobs (
    id TEXT PRIMARY KEY,
    kickoff_endpoint TEXT NOT NULL,
    requesting_client_id TEXT NOT NULL REFERENCES osod_smart_clients(client_id),
    requesting_token_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    transaction_time TIMESTAMPTZ NOT NULL,
    requested_types JSONB,
    requested_since TIMESTAMPTZ,
    manifest_jsonb JSONB,
    output_dir TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    retention_until TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
    requires_access_token BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT osod_bulk_export_jobs_id_shape_check CHECK (id ~ '^[A-Za-z0-9_-]{16,}$'),
    CONSTRAINT osod_bulk_export_jobs_status_check CHECK (
        status IN ('accepted', 'in-progress', 'completed', 'cancelled', 'errored')
    ),
    CONSTRAINT osod_bulk_export_jobs_endpoint_check CHECK (
        kickoff_endpoint = '$export' OR
        kickoff_endpoint = 'Patient/$export' OR
        kickoff_endpoint ~ '^Group/[A-Za-z0-9_.-]+/\\$export$'
    ),
    CONSTRAINT osod_bulk_export_jobs_retention_check CHECK (
        retention_until <= created_at + interval '90 days'
    ),
    CONSTRAINT osod_bulk_export_jobs_local_output_check CHECK (
        output_dir !~* '^(s3|gs|az|https?)://'
    )
);

ALTER TABLE osod_smart_clients
    ADD COLUMN IF NOT EXISTS vendor_baa_eligible BOOLEAN,
    ADD COLUMN IF NOT EXISTS practice_baa_or_contract_attested_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS osod_oauth_grants (
    grant_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES osod_smart_clients(client_id),
    patient_reference TEXT,
    scope TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS osod_oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id TEXT REFERENCES osod_oauth_grants(grant_id),
    client_id TEXT NOT NULL REFERENCES osod_smart_clients(client_id),
    token_kind TEXT NOT NULL CHECK (token_kind IN ('access_token', 'refresh_token')),
    expires_at TIMESTAMPTZ NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);
