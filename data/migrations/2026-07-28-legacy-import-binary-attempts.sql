CREATE TABLE IF NOT EXISTS odos_legacy_import_binary_attempts (
    attempt_id UUID PRIMARY KEY,
    source_filename TEXT NOT NULL,
    patient_reference TEXT NOT NULL CHECK (patient_reference ~ '^Patient/[^/]+$'),
    media_id UUID,
    binary_id UUID,
    status TEXT NOT NULL DEFAULT 'open' CHECK (
        status IN ('open', 'resolved-attached', 'resolved-not-created', 'resolved-disposed')
    ),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_returned_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    resolution_detail TEXT,
    CHECK (
        (status = 'open' AND resolved_at IS NULL)
        OR (status <> 'open' AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS odos_legacy_import_binary_attempts_open_binary_idx
    ON odos_legacy_import_binary_attempts (binary_id)
    WHERE status = 'open';
