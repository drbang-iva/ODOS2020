---
title: OSOD Audit Event Type ValueSet
date: 2026-04-29
status: verified
ledger: data/code-bindings/v0.5-verification-ledger.md
---

# OSOD Audit Event Type ValueSet

The DB table `osod_audit_events` is the source of truth for the local HIPAA
security log. FHIR `AuditEvent` resources are projections for interoperability.

## Event Types

| Code | Class | Description |
|---|---|---|
| `read` | read-class | Direct read of a PHI-bearing FHIR resource. |
| `search` | read-class | Search over PHI-bearing FHIR resources. |
| `history` | read-class | Version history read. |
| `vread` | read-class | Version-specific read. |
| `create` | write-class | Resource create. |
| `update` | write-class | Resource update. |
| `patch` | write-class | JSON Patch or equivalent partial update. |
| `transaction` | write-class | FHIR transaction bundle. |
| `nullify-attempt` | write-class | Attempt to nullify / entered-in-error a durable clinical resource. |
| `delete-attempt` | write-class | Attempted delete of a durable clinical resource or audit row. |
| `denied` | denial-class | Access denied by AccessPolicy, Mandate 8 boundary, or equivalent policy. |
| `break-glass-invoked` | emergency-access | Human-attested emergency access invocation. |
| `break-glass-expired` | emergency-access | Automatic emergency access expiry. |
| `login` | security-event | Successful login. |
| `logout` | security-event | Logout. |
| `login-failed` | security-event | Failed login. |
| `role-change` | identity-event | Role assignment or role binding change. |
| `policy-change` | identity-event | AccessPolicy change. |
| `projectmembership-lifecycle` | identity-event | Invite / activate / deactivate / terminate / role-review lifecycle event. |
| `backup-started` | contingency-event | Backup process started. |
| `backup-completed` | contingency-event | Backup process completed. |
| `restore-started` | contingency-event | Restore process started. |
| `restore-completed` | contingency-event | Restore process completed. |
| `external-api-call` | integration-event | Outbound call touching another system on behalf of a user. |
| `preflight-block` | local-readiness-event | Local preflight hard-block, currently reserved for env-var PHI leakage. |
| `noop` | setup-event | Idempotent setup rerun where no FHIR resource write occurred. |
| `smart-token-issue` | smart-authz-event | Token successfully issued to a SMART client. Ledger: v0.55 row 7. |
| `smart-token-refresh` | smart-authz-event | Refresh token redeemed for a new SMART access token. Ledger: v0.55 row 7. |
| `smart-token-revoke` | smart-authz-event | SMART token revoked by client request, reuse detection, or admin action. Ledger: v0.55 row 12. |
| `smart-introspection` | smart-authz-event | SMART token introspection endpoint called. Ledger: v0.55 row 6. |
| `smart-discovery-fetch` | smart-authz-event | SMART discovery document fetched from `.well-known/smart-configuration`. Ledger: v0.55 row 5. |
| `smart-scope-staged-review` | smart-authz-event | SMART scope request entered staged admin review. Ledger: v0.55 rows 9 and 11. |
| `smart-scope-approved` | smart-authz-event | SMART scope decision approved automatically or by admin review. Ledger: v0.55 rows 9 and 11. |
| `smart-scope-rejected` | smart-authz-event | SMART scope request rejected automatically or by admin review. Ledger: v0.55 rows 9 and 11. |
| `smart-sandbox-register` | smart-authz-event | Sandbox SMART app registered through the local developer endpoint. Ledger: v0.55 rows 4 and 5. |

## Information Blocking Exceptions

Denied rows must populate `ib_exception` with one of:

`preventing-harm`, `privacy`, `security`, `infeasibility`,
`health-IT-performance`, `content-and-manner`, `fees`, `licensing`.
