-- OSOD v0.55b local SMART app install-review records.

CREATE TABLE IF NOT EXISTS osod_smart_app_installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_resource_type TEXT NOT NULL,
    canonical_resource_id TEXT NOT NULL,
    client_id TEXT,
    install_state TEXT NOT NULL,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    block_reason TEXT,
    compatibility_gap_attested BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT osod_smart_app_installations_resource_type_check CHECK (
        canonical_resource_type IN ('Endpoint', 'Device')
    ),
    CONSTRAINT osod_smart_app_installations_state_check CHECK (
        install_state IN ('pending-review', 'installed', 'rejected', 'removed', 'blocked')
    )
);

CREATE INDEX IF NOT EXISTS osod_smart_app_installations_resource_idx
    ON osod_smart_app_installations (canonical_resource_type, canonical_resource_id);

CREATE INDEX IF NOT EXISTS osod_smart_app_installations_state_time_idx
    ON osod_smart_app_installations (install_state, updated_at DESC);
