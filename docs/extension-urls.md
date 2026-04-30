# OSOD Extension URL Convention

OSOD-minted FHIR extension URLs use:

`https://osod.dev/fhir/StructureDefinition/{kebab-case-name}`

Each extension URL must be added to the active verification ledger before code references it. v0.5c adds the optional UI-only attestation review extension:

`https://osod.dev/fhir/StructureDefinition/observation-attestation-ui-state`

FHIR `Observation.status` remains the clinical/legal source of truth. This extension is only for client review workflow state.
