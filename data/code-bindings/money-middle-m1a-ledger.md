# Money-middle M1a verification ledger

Access date: 2026-07-21

Mandate 14 audit for sign-time procedure charge materialization and the practice fee schedule. The five procedure concept keys are ODOS-local identifiers already present in the live glaucoma protocol fixture; this slice does not assert CPT, HCPCS, ICD-10-CM, SNOMED CT, LOINC, RxNorm, NDC, or UCUM values.

| Artifact | Chosen value | Primary source 1 | Primary source 2 | Status |
|---|---|---|---|---|
| FHIR R4 ChargeItem lifecycle and financial-context fields | `status = billable`; Patient `subject`; Encounter `context`; `definitionCanonical`; `occurrenceDateTime`; `quantity`; Money `priceOverride`; `enterer`; `enteredDate`; diagnosis References in `supportingInformation` | [HL7 FHIR R4 ChargeItem narrative](https://hl7.org/fhir/R4/chargeitem.html) | [HL7 FHIR R4 ChargeItem StructureDefinition JSON](https://hl7.org/fhir/R4/chargeitem.profile.json) | verified; both official R4 artifacts agree, and `@medplum/fhirtypes` R4 compilation is machine-checked |
| FHIR R4 ChargeItem status code | `billable` | [HL7 FHIR R4 ChargeItem status ValueSet](https://hl7.org/fhir/R4/valueset-chargeitem-status.html) | [HL7 FHIR R4 ChargeItem status CodeSystem JSON](https://hl7.org/fhir/R4/codesystem-chargeitem-status.json) | verified |
| FHIR R4 ChargeItemDefinition fee-rule shape | practice-scoped canonical `url`; integer `version`; `status = active` or `retired`; local procedure `code`; Money base amount in `propertyGroup.priceComponent` | [HL7 FHIR R4 ChargeItemDefinition narrative](https://hl7.org/fhir/R4/chargeitemdefinition.html) | [HL7 FHIR R4 ChargeItemDefinition StructureDefinition JSON](https://hl7.org/fhir/R4/chargeitemdefinition.profile.json) | verified; both official R4 artifacts agree, and `@medplum/fhirtypes` R4 compilation is machine-checked |
| HL7 terminology code used by the existing ChargeItemDefinition price-component pattern | `http://terminology.hl7.org/CodeSystem/v3-ActCode#CHRG` — Standard Charge | [HL7 Terminology ActCode narrative](https://terminology.hl7.org/CodeSystem-v3-ActCode.html) | [HL7 Terminology ActCode JSON](https://terminology.hl7.org/CodeSystem-v3-ActCode.json) | verified; both official THO publication formats agree |
| ODOS-local unpriced marker | `https://odos2020.com/fhir/StructureDefinition/odos-unpriced-charge`, boolean `true` on a zero-dollar materialized ChargeItem | [HL7 FHIR R4 Extensibility](https://hl7.org/fhir/R4/extensibility.html) | [HL7 FHIR R4 StructureDefinition](https://hl7.org/fhir/R4/structuredefinition.html) | verified; governed local extension is defined in `data/canonical-extensions/odos-unpriced-charge.json` |

## Local procedure concepts

The seeded keys `gonioscopy`, `corneal-pachymetry`, `scodi-optic-nerve`, `visual-field-threshold`, and `fundus-photography` are deliberately not billing codes. They are copied verbatim from `mcp/src/clinical-graph/protocol-fixtures.ts` and live under the ODOS-local `https://odos2020.com/fhir/CodeSystem/procedure-concept` namespace. No external medical-code meaning is projected by this slice.
