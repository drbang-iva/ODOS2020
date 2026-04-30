# OSOD Extension URLs

| Extension | URL | Cardinality | Status | Verification |
|---|---|---:|---|---|
| Observation attestation UI state | `https://osod.dev/fhir/StructureDefinition/observation-attestation-ui-state` | `0..1` on Observation | Optional, decorative UI state only | v0.5 ledger row 43 |

Clinical attestation, amendment routing, audit classification, and Information Blocking logic consume `Observation.status`, not this extension.
