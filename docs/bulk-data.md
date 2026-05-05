# v0.55e Bulk Data and Patient Access

Population-level export and Patient Access run on the practice's own OSOD server. Bulk export jobs are local async jobs; NDJSON files stay on the practice-controlled filesystem unless an authorized user or app retrieves them.

## What Ships

v0.55e adds five integration-spine primitives:

- FHIR Bulk Data export for `Group/{id}/$export`, optional `Patient/$export`, and optional admin-only `$export`.
- Patient Access API consent and grant-revocation surfaces for SMART App Launch flows.
- SMART Backend Services authorization for Bulk Data clients using the existing SMART app registry.
- A truthful CapabilityStatement synthesized from integration-test-backed structured claims.
- Information Blocking Safety Valve composition for Bulk Data refusals.

## Export Endpoints

`GET [base]/Group/{id}/$export` is the required population export path. The group must be a concrete materialized FHIR `Group` resource discoverable through normal FHIR read/search.

`GET [base]/Patient/$export` is all-patients-compartment Bulk Data export. v0.55e leaves it disabled by default; single-patient access stays on ordinary US Core REST read/search through patient or user scopes.

`GET [base]/$export` is system-level export. v0.55e leaves it disabled by default and treats agent-driven use as CRITICAL.

Kickoff requires `Accept: application/fhir+json` and `Prefer: respond-async`. Polling uses `Accept: application/json`, returns `Retry-After` while in progress, and returns the manifest after completion. Cancellation uses `DELETE` on the polling URL.

## Local Job Storage

`osod_bulk_export_jobs` is the source-of-truth job table. Job IDs and file URLs are high-entropy URL-safe nonces with no patient names, MRNs, dates of birth, SSNs, or sequential counters. Files are serialized under the configured local output root, with default 7-day retention and a 90-day maximum.

## Authorization

Manifest files advertise `requiresAccessToken: true`, and OSOD enforces that at file retrieval. Download tokens are validated as OSOD-issued or OSOD-introspected access tokens. The download middleware does not validate Bearer tokens against a client's JWKS, because client JWKS only authenticates client assertions at `/oauth2/token`.

SMART Backend Services clients register through the existing local SMART app registry with `private_key_jwt` and a local `jwks_uri`. v0.55e does not add a parallel Bulk Data client registry.

## Patient Access

The `/oauth2/authorize` consent surface renders requested scopes, app identity, patient identity, and Approve/Deny controls. The backend remains the authority for redirect URI validation, PKCE, state handling, authorization-code issuance, and audit emission.

Patients can revoke app access through `/oauth2/grants`. Revocation invalidates refresh tokens immediately and makes token introspection return inactive for revoked grant tokens.

## Data Classes

The Patient Access certification target is pinned to USCDI v3 and US Core 6.1.0. Later USCDI and US Core lines remain forward gates for a later slice.

Patient Access coverage includes Provenance, DocumentReference, and DiagnosticReport for clinical notes. DocumentReference, DiagnosticReport, and Binary references may appear in NDJSON; raw image bytes are not loaded into any LLM context.

## NDJSON Security Labels

The Bulk Data serializer preserves `meta.security` end to end. AIAST, DICTAST, and CPLYCUI codings keep their canonical HL7 CodeSystem URI through database read, async job handling, and NDJSON write.

## Public Documentation

The public documentation surface includes base URLs, endpoint schemas, `/metadata`, and `/.well-known/smart-configuration`. These paths are unauthenticated, heavily cached, rate-limited, and sanitized before JSON emission so internal LAN addresses, filesystem paths, secrets, and internal AgentOps Device references do not leak.

## Refusals

Bulk Data refusals consume the v0.55d Safety Valve and exception mapper unchanged. Geographic fencing fires at kickoff before job creation or NDJSON generation. Long-lived downloads re-check policy before streaming bytes.

## Why This Is Not a Marketplace

OSOD does not ship a hosted export gateway, hosted app catalog, remote PHI job table, or vendor-managed Patient Access directory. Practices run the endpoint on their hardware and decide which apps can connect.

## Forward Gates

HTI-5 remains Proposed at v0.55e session-open verification, so v0.55a-d audit logging, AIAST, Provenance, and CDS transparency stay intact.

HL7 AI Transparency on FHIR remains Tier-B-PROVISIONAL for IG-specific shape reconciliation. v0.55e preserves AIAST through Provenance R4 plus ActCode security labels; IG-specific reconciliation is deferred.
