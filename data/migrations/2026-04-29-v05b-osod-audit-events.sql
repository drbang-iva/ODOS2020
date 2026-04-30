-- OSOD v0.5b append-only audit substrate.
-- The DB table is the source-of-truth HIPAA security log; FHIR AuditEvent is a projection.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS osod_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_time TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type TEXT NOT NULL,
    actor_id TEXT,
    actor_role TEXT,
    patient_id TEXT,
    resource_type TEXT,
    resource_id TEXT,
    action_outcome TEXT NOT NULL,
    action_reason TEXT,
    policy_url TEXT,
    session_id TEXT,
    ip_address INET,
    user_agent TEXT,
    break_glass BOOLEAN NOT NULL DEFAULT false,
    break_glass_reason TEXT,
    ib_actor_classification TEXT NOT NULL DEFAULT 'health-care-provider',
    ib_exception TEXT,
    provenance_id TEXT,
    audit_event_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT osod_audit_events_event_type_check CHECK (
        event_type IN (
            'read', 'search', 'history', 'vread',
            'create', 'update', 'patch', 'transaction', 'nullify-attempt', 'delete-attempt',
            'denied',
            'break-glass-invoked', 'break-glass-expired',
            'login', 'logout', 'login-failed',
            'role-change', 'policy-change', 'projectmembership-lifecycle',
            'backup-started', 'backup-completed', 'restore-started', 'restore-completed',
            'external-api-call'
        )
    ),
    CONSTRAINT osod_audit_events_action_outcome_check CHECK (
        action_outcome IN ('granted', 'denied')
    ),
    CONSTRAINT osod_audit_events_ib_actor_classification_check CHECK (
        ib_actor_classification IN ('health-care-provider')
    ),
    CONSTRAINT osod_audit_events_ib_exception_check CHECK (
        ib_exception IS NULL OR ib_exception IN (
            'preventing-harm', 'privacy', 'security', 'infeasibility',
            'health-IT-performance', 'content-and-manner', 'fees', 'licensing'
        )
    ),
    CONSTRAINT osod_audit_events_denied_exception_check CHECK (
        action_outcome = 'granted' OR ib_exception IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS osod_audit_events_patient_time_idx
    ON osod_audit_events (patient_id, event_time DESC);

CREATE INDEX IF NOT EXISTS osod_audit_events_actor_time_idx
    ON osod_audit_events (actor_id, event_time DESC);

CREATE INDEX IF NOT EXISTS osod_audit_events_time_idx
    ON osod_audit_events (event_time DESC);

CREATE INDEX IF NOT EXISTS osod_audit_events_type_time_idx
    ON osod_audit_events (event_type, event_time DESC);

CREATE OR REPLACE FUNCTION osod_raise_audit_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'osod_audit_events is append-only; UPDATE, DELETE, and TRUNCATE are forbidden'
        USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS osod_audit_events_append_only_update_delete ON osod_audit_events;
CREATE TRIGGER osod_audit_events_append_only_update_delete
    BEFORE UPDATE OR DELETE ON osod_audit_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION osod_raise_audit_events_append_only();

DROP TRIGGER IF EXISTS osod_audit_events_append_only_truncate ON osod_audit_events;
CREATE TRIGGER osod_audit_events_append_only_truncate
    BEFORE TRUNCATE ON osod_audit_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION osod_raise_audit_events_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE osod_audit_events FROM PUBLIC;

DO $$
DECLARE
    role_record RECORD;
BEGIN
    FOR role_record IN
        SELECT rolname
        FROM pg_roles
        WHERE NOT rolsuper
    LOOP
        EXECUTE format(
            'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE osod_audit_events FROM %I',
            role_record.rolname
        );
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'osod_app') THEN
        GRANT INSERT, SELECT ON TABLE osod_audit_events TO osod_app;
        REVOKE UPDATE, DELETE, TRUNCATE ON TABLE osod_audit_events FROM osod_app;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'osod_backup') THEN
        GRANT SELECT ON TABLE osod_audit_events TO osod_backup;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE osod_audit_events FROM osod_backup;
    END IF;
END $$;
