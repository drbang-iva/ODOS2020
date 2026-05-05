-- OSOD v0.55e Bulk Data, Patient Access, and truthful CapabilityStatement audit events.
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
            'smart-app-metadata-updated',
            'cds.discovery.served',
            'cds.service.registered', 'cds.service.deactivated',
            'cds.hook.fired',
            'cds.card.rendered', 'cds.card.rejected_validation', 'cds.card.suppressed_stale',
            'cds.feedback.accepted', 'cds.feedback.overridden',
            'agentops.action.attempted',
            'agentops.action.allowed',
            'agentops.action.blocked',
            'agentops.action.confirmed',
            'agentops.action.escalated',
            'agentops.action.rolled-back',
            'agentops.policy.loaded',
            'agentops.policy.collision',
            'bulk_export.kickoff.group',
            'bulk_export.kickoff.patient',
            'bulk_export.kickoff.system',
            'bulk_export.complete',
            'bulk_export.cancelled',
            'bulk_export.rejected',
            'patient_access.token.issued',
            'patient_access.token.revoked',
            'capability_statement.served'
        )
    );
