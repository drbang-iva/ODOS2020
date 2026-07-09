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
| `smart-app-registered` | smart-registry-event | SMART app registered through local dynamic client registration. Ledger: v0.55 row 16. |
| `smart-app-jurisdiction-blocked` | smart-registry-event | SMART app install blocked by jurisdiction rule. Ledger: v0.55 row 20. |
| `smart-app-installed` | smart-registry-event | SMART app installed after local admin review. Ledger: v0.55 rows 23 and 25. |
| `smart-app-install-rejected` | smart-registry-event | SMART app install rejected by local manifest policy. Ledger: v0.55 rows 23 and 24. |
| `smart-app-removed` | smart-registry-event | SMART app removed from the local registry. Ledger: v0.55 row 27. |
| `smart-app-review-pending` | smart-registry-event | SMART app install entered pending admin review. Ledger: v0.55 row 24. |
| `smart-app-metadata-updated` | smart-registry-event | SMART app registry metadata updated. Ledger: v0.55 rows 19 and 23. |
| `cds.discovery.served` | cds-event | CDS Hooks discovery document served from the local `/cds-services` endpoint. Ledger: v0.55 rows 28 and 29. |
| `cds.service.registered` | cds-event | External CDS service registered after local admin review. Ledger: v0.55 rows 34 and 38. |
| `cds.service.deactivated` | cds-event | External CDS service deactivated through the local admin workflow. Ledger: v0.55 row 38. |
| `cds.hook.fired` | cds-event | CDS hook fired against matching local or opted-in external services. Ledger: v0.55 rows 28 and 29. |
| `cds.card.rendered` | cds-event | CDS card validated and rendered. Ledger: v0.55 row 35. |
| `cds.card.rejected_validation` | cds-event | CDS card rejected before rendering because schema validation failed. Ledger: v0.55 row 35. |
| `cds.card.suppressed_stale` | cds-event | CDS card suppressed because its TTL expired before display. Ledger: v0.55 rows 34 and 35. |
| `cds.feedback.accepted` | cds-event | CDS feedback recorded for an accepted card. Ledger: v0.55 row 28. |
| `cds.feedback.overridden` | cds-event | CDS feedback recorded for an overridden card. Ledger: v0.55 row 28. |
| `payment.charge.attempted` | payment-event | Payment charge initiated through a processor adapter. Ledger: payment-reconciliation-seam-ledger.md. |
| `payment.charge.completed` | payment-event | Payment charge completed; the payment record is a PaymentReconciliation (processor) or the tendered Invoice (manual). Ledger: payment-reconciliation-seam-ledger.md. |
| `payment.charge.failed` | payment-event | Payment charge declined or failed; audited against the Invoice it attempted to settle — no PaymentReconciliation is created. Ledger: payment-reconciliation-seam-ledger.md. |
| `claim.submit.completed` | claim-event | Claim.MD professional claim submission completed; audited against the created Claim. Ledger: claimmd-clearinghouse-ledger.md. |
| `claim.submit.failed` | claim-event | Claim.MD professional claim submission failed; audited against the Claim when one was created. Ledger: claimmd-clearinghouse-ledger.md. |
| `eligibility.check.completed` | claim-event | Claim.MD 270/271 eligibility check completed; audited against the CoverageEligibilityResponse. Ledger: claimmd-clearinghouse-ledger.md. |
| `eligibility.check.failed` | claim-event | Claim.MD eligibility check failed; audited against the CoverageEligibilityRequest when one was created. Ledger: claimmd-clearinghouse-ledger.md. |
| `era.import.completed` | claim-event | Claim.MD ERA import completed; audited against the created PaymentReconciliation when payment posted. Ledger: claimmd-clearinghouse-ledger.md. |
| `era.import.failed` | claim-event | Claim.MD ERA import failed; audited against the ERA id. Ledger: claimmd-clearinghouse-ledger.md. |
| `era.denial.flagged` | claim-event | A matched zero-pay ERA claim created a claimable denial Task. Ledger: claimmd-clearinghouse-ledger.md. |
| `era.underpayment.flagged` | claim-event | A paid ERA claim with a true allowed-minus-paid-minus-patient-responsibility shortfall created an underpayment Task. Ledger: claimmd-clearinghouse-ledger.md. |
| `era.unmatched.flagged` | claim-event | An ERA claim without a local PCN mapping created a recoverable unmatched Task. Ledger: claimmd-clearinghouse-ledger.md. |
| `claim.status.checked` | claim-event | Claim.MD status polling completed or failed; audited against the ClaimResponse or Claim. Ledger: claimmd-clearinghouse-ledger.md. |
| `payment.refund.attempted` | payment-event | Refund initiated (workflow deferred to v0.7 refund authorization). Ledger: payment-reconciliation-seam-ledger.md. |
| `payment.refund.completed` | payment-event | Refund completed (workflow deferred to v0.7 refund authorization). Ledger: payment-reconciliation-seam-ledger.md. |
| `payment.void.attempted` | payment-event | Transaction void initiated (workflow deferred to v0.7). Ledger: payment-reconciliation-seam-ledger.md. |
| `payment.settle.batch` | payment-event | Processor settlement batch gathered (settlement reconciliation UI deferred to v0.7). Ledger: payment-reconciliation-seam-ledger.md. |
| `payment.financing.preauthorized` | payment-event | Patient financing application pre-authorized by the financing platform. Ledger: payment-reconciliation-seam-ledger.md. |
| `payment.financing.declined` | payment-event | Patient financing application declined by the financing platform. Ledger: payment-reconciliation-seam-ledger.md. |

## Information Blocking Exceptions

Denied rows must populate `ib_exception` with one of:

`preventing-harm`, `privacy`, `security`, `infeasibility`,
`health-IT-performance`, `content-and-manner`, `fees`, `licensing`.
