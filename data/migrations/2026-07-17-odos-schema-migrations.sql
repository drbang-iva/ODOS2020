BEGIN;

SELECT pg_advisory_xact_lock(hashtext('odos_schema_migrations'));

CREATE TABLE IF NOT EXISTS odos_schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
