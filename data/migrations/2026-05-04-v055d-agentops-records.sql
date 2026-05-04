-- OSOD v0.55d AgentOps audit-record substrate.
-- Extends osod_audit_events with the Q1 AgentOps execution-record fields.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE osod_audit_events
    ADD COLUMN IF NOT EXISTS agent_identity TEXT,
    ADD COLUMN IF NOT EXISTS attempted_action JSONB,
    ADD COLUMN IF NOT EXISTS target_fhir_resource JSONB,
    ADD COLUMN IF NOT EXISTS threshold_class TEXT,
    ADD COLUMN IF NOT EXISTS verdict TEXT,
    ADD COLUMN IF NOT EXISTS rationale JSONB,
    ADD COLUMN IF NOT EXISTS source_identity JSONB,
    ADD COLUMN IF NOT EXISTS section_171_exception_code TEXT,
    ADD COLUMN IF NOT EXISTS aiast_tag_confirmation BOOLEAN,
    ADD COLUMN IF NOT EXISTS initiation_mode TEXT,
    ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS attempted_payload_full JSONB;

-- AMENDED 2026-05-04 (operator-authorized one-time edit per Mandate 8 conflict):
-- The original v0.55d migration backfilled retention_until and initiation_mode
-- on existing osod_audit_events rows via UPDATE. That violates the Mandate 8
-- append-only invariant enforced by the osod_raise_audit_events_append_only()
-- trigger and crashes MCP server startup at LiveOsodAuditRuntime.ensureSchema.
--
-- Resolution: leave both new columns NULL on pre-v0.55d rows. The CHECK
-- constraints below already permit NULL. Application code (audit-emitter +
-- consumers) treats NULL initiation_mode as semantically "user-initiated"
-- (every pre-v0.55d event is by definition user-initiated; autonomous-
-- initiated events only exist v0.55d+). NULL retention_until is treated as
-- the 7-year default at consumption time (no backfill needed).
--
-- New v0.55d+ INSERTs populate both columns at write time (per
-- LiveOsodAuditRuntime.insertRow); only legacy rows carry NULL.

ALTER TABLE osod_audit_events
    DROP CONSTRAINT IF EXISTS osod_audit_events_threshold_class_check,
    DROP CONSTRAINT IF EXISTS osod_audit_events_verdict_check,
    DROP CONSTRAINT IF EXISTS osod_audit_events_section_171_exception_code_check,
    DROP CONSTRAINT IF EXISTS osod_audit_events_initiation_mode_check,
    DROP CONSTRAINT IF EXISTS osod_audit_events_denied_exception_check;

ALTER TABLE osod_audit_events
    ADD CONSTRAINT osod_audit_events_threshold_class_check CHECK (
        threshold_class IS NULL OR threshold_class IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
    ),
    ADD CONSTRAINT osod_audit_events_verdict_check CHECK (
        verdict IS NULL OR verdict IN (
            'allowed', 'blocked', 'confirmation-required', 'confirmed', 'escalated'
        )
    ),
    ADD CONSTRAINT osod_audit_events_section_171_exception_code_check CHECK (
        section_171_exception_code IS NULL OR section_171_exception_code IN (
            'PreventingHarm', 'Privacy', 'Security', 'Infeasibility',
            'HealthITPerformance', 'ProtectingCareAccess',
            'ContentAndManner', 'Fees', 'Licensing', 'TEFCAManner'
        )
    ),
    ADD CONSTRAINT osod_audit_events_initiation_mode_check CHECK (
        initiation_mode IS NULL OR initiation_mode IN ('user-initiated', 'autonomously-initiated')
    ),
    ADD CONSTRAINT osod_audit_events_denied_exception_check CHECK (
        action_outcome = 'granted'
        OR ib_exception IS NOT NULL
        OR section_171_exception_code IS NOT NULL
    );

CREATE INDEX IF NOT EXISTS osod_audit_events_agent_time_idx
    ON osod_audit_events (agent_identity, event_time DESC)
    WHERE agent_identity IS NOT NULL;

CREATE INDEX IF NOT EXISTS osod_audit_events_agentops_verdict_idx
    ON osod_audit_events (verdict, event_time DESC)
    WHERE verdict IS NOT NULL;

CREATE TABLE IF NOT EXISTS osod_agentops_agent_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_identity TEXT NOT NULL,
    key_id TEXT NOT NULL,
    encrypted_private_key BYTEA NOT NULL,
    key_encryption_method TEXT NOT NULL DEFAULT 'pgp_sym_encrypt',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_identity, key_id)
);

COMMENT ON COLUMN osod_agentops_agent_keys.encrypted_private_key IS
    'AgentOps private key material encrypted at rest by pgp_sym_encrypt before storage.';
