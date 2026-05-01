-- OSOD v0.55a local SMART client state for discovery and sandbox registration.

CREATE TABLE IF NOT EXISTS osod_smart_clients (
    client_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris JSONB NOT NULL,
    client_type TEXT NOT NULL,
    token_endpoint_auth_method TEXT NOT NULL,
    jwks_uri TEXT,
    client_secret_hash TEXT,
    scopes_allowed JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_sandbox BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT osod_smart_clients_client_type_check CHECK (
        client_type IN ('public', 'confidential')
    ),
    CONSTRAINT osod_smart_clients_auth_method_check CHECK (
        token_endpoint_auth_method IN (
            'none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'
        )
    )
);
