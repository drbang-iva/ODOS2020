# ODOS Extension URL Convention

ODOS-minted FHIR extension URLs use:

`https://odos2020.com/fhir/StructureDefinition/{kebab-case-name}`

Each extension URL must be added to the active verification ledger before code references it. v0.5c adds the optional UI-only attestation review extension:

`https://odos2020.com/fhir/StructureDefinition/observation-attestation-ui-state`

FHIR `Observation.status` remains the clinical/legal source of truth. This extension is only for client review workflow state.
