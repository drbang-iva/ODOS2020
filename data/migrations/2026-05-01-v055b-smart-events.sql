-- OSOD v0.55b SMART app registry audit event extension.
-- Extending osod_audit_events.event_type requires drop-and-re-add per v0.5d Lesson 10.

ALTER TABLE osod_audit_events
    DROP CONSTRAINT IF EXISTS osod_audit_events_event_type_check;

ALTER TABLE osod_audit_events
    ADD CONSTRAINT osod_audit_events_event_type_check CHECK (
        event_type IN (
            'read', 'search', 'history', 'vread',
            'create', 'update', 'patch', 'transaction', 'nullify-attempt', 'delete-attempt',
            'denied',
            'break-glass-invoked', 'break-glass-expired',
            'login', 'logout', 'login-failed',
            'role-change', 'policy-change', 'projectmembership-lifecycle',
            'backup-started', 'backup-completed', 'restore-started', 'restore-completed',
            'external-api-call',
            'preflight-block', 'noop',
            'smart-token-issue', 'smart-token-refresh', 'smart-token-revoke',
            'smart-introspection', 'smart-discovery-fetch',
            'smart-scope-staged-review', 'smart-scope-approved', 'smart-scope-rejected',
            'smart-sandbox-register',
            'smart-app-registered', 'smart-app-jurisdiction-blocked',
            'smart-app-installed', 'smart-app-install-rejected',
            'smart-app-removed', 'smart-app-review-pending',
            'smart-app-metadata-updated'
        )
    );
