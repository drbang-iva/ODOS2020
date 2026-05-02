# OSOD CDS Hooks v0.55c

## Overview

OSOD v0.55c adds a local CDS Hooks 2.0.1 client and local OSOD specialty hook services. Decision support runs in the practice-owned OSOD Node runtime unless a practice admin explicitly activates an external CDS service. The shipped external-services catalog is empty by default.

Local CDS guidance - your registry, your call.

## OSOD-Default Hook Services

The v0.55c default services are deterministic specialty workflow checks, not AI agents:

| Service ID | Hook | Trigger substrate |
|---|---|---|
| `osod-contact-lens-finalize` | `order-sign` | ServiceRequest code matches SNOMED CT `2488002` or `6213004` |
| `osod-myopia-control-plan` | `order-sign` | ServiceRequest code matches SNOMED CT `57190000` |
| `osod-dry-eye-escalation` | `encounter-discharge` | Assessment Observation code matches SNOMED CT `302896008` |

All three services emit rules-based cards with HTI-1 DSI source attributes and intervention risk-management fields. They do not analyze images, raw media, patient-portal render hooks, SMS, email, Twilio, or SendGrid.

## Discovery Endpoint

`GET /cds-services` is unauthenticated and returns:

```json
{
  "services": []
}
```

In a running v0.55c stack, the response includes the three OSOD-default services plus any locally approved external CDS service. The `.well-known/smart-configuration` document also advertises:

```json
{
  "cds_hooks_endpoint": "http://localhost:.../cds-services",
  "cds_capabilities": [
    "osod-contact-lens-finalize",
    "osod-myopia-control-plan",
    "osod-dry-eye-escalation"
  ]
}
```

The existing SMART `registration_endpoint` remains `/oauth2/register`.

## External CDS Service Registration

Practice admins register an external CDS service with `POST /cds-services/register`. The endpoint is local to the OSOD runtime and is distinct from SMART app registration.

Registration does not auto-activate. The request must include `admin_review_approved: true` after staged local admin review before OSOD creates the canonical FHIR `Endpoint` record.

Required metadata:

```json
{
  "service_id": "external-local-cds",
  "title": "External local CDS",
  "description": "Practice-reviewed external CDS service.",
  "endpoint_url": "https://example.invalid/cds",
  "cds_risk_class": "LOW",
  "phi_boundary": "read-only",
  "launch_mode": "cds-service",
  "network_egress": "none",
  "external_services_required": false,
  "baa_required": false,
  "image_analysis_prohibited": true,
  "allowedJurisdictions": [],
  "prohibitedStates": [],
  "scope_request_canonical": "system/Observation.rs",
  "hook_subscriptions": ["order-sign"],
  "card_ttl_minutes": 60,
  "request_timeout_seconds": 10,
  "admin_review_approved": true
}
```

The canonical record is a FHIR R4 `Endpoint` with the OSOD extension URL:

`https://osod.dev/fhir/StructureDefinition/cds-service`

Registration writes a `Provenance` record with top-level `Provenance.policy` set to:

`https://osod.dev/fhir/Policy/cds-service-registry`

Removal uses `POST /cds-services/{service-id}/deactivate` and records `nullify` or `amend` activity.

## Registration Blocks

OSOD hard-blocks registration when:

- `image_analysis_prohibited` is not `true`.
- The service declares an image-analysis payload.
- `baa_required` is `true` without local admin BAA confirmation.
- `prohibitedStates` collides with the practice jurisdiction.
- Metadata or hook context marks the service as patient-engagement-vendor profile.

The geographic-fencing check inherits the South Carolina ECCPL pattern from the v0.55b SMART app registry.

## Card Rendering Schema

Every returned card must pass the v0.55c card schema before rendering. Required fields:

- Standard CDS Hooks card fields: `uuid`, `summary`, `indicator`, and `source.label`.
- `dsi_type`: `predictive`, `evidence-based`, or `rules-based`.
- `intervention_risk_management.risk_identification`.
- `intervention_risk_management.risk_mitigation`.
- `intervention_risk_management.continual_monitoring`.
- `source_attributes.developer_identity`.
- `source_attributes.funding_source`.
- `source_attributes.evidence_basis_citation`.

Predictive cards additionally require `training_data_demographics` and `algorithmic_validity_bounds`. The v0.55c OSOD-default services are all `rules-based`.

Cards failing schema validation are rejected before rendering and emit `cds.card.rejected_validation`. Cards carrying executable content are rejected.

## Stale Guidance

Rendered cards carry `card_ttl_minutes`, defaulting to 60. Expired cards are suppressed at display time and emit `cds.card.suppressed_stale`. OSOD does not auto-refresh stale cards; the user action that caused the hook must run again.

## Feedback Endpoint

`POST /cds-services/{service-id}/feedback` accepts CDS Hooks feedback:

- `accepted` outcomes may include accepted suggestion UUIDs.
- `overridden` outcomes may include a CodeableConcept reason and user comment.

Feedback persists to `osod_cds_feedback` and emits `cds.feedback.accepted` or `cds.feedback.overridden`.

## Why This Is Not A Marketplace

OSOD v0.55c ships infrastructure, not a ranked service catalog. The default external services file is:

`data/seed-catalogs/cds-services.json`

with:

```json
{ "services": [] }
```

An informational discovery-aid file may exist at:

`data/seed-catalogs/cds-services-recommended-INFORMATIONAL.json`

It is empty in v0.55c and does not enable anything. External CDS services are opt-in only.

## HTI-5 Status

HTI-5 was re-verified as a Proposed Rule on 2026-05-02 before v0.55c code landed. v0.55c keeps the HTI-1 DSI card schema independent of HTI-5 and logs per-commit re-verification before any v0.55c commit.
