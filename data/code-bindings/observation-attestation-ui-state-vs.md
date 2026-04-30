# Observation Attestation UI State ValueSet

URL: `https://osod.dev/fhir/ValueSet/observation-attestation-ui-state`

| Code | Display | Meaning |
|---|---|---|
| `pending-clinician-review` | Pending clinician review | Scribe submitted the draft; clinician has not opened the review view. |
| `clinician-reviewing` | Clinician reviewing | Clinician opened the review view but has not attested. |
| `attestation-in-flight` | Attestation in flight | Clinician initiated the attestation transaction and the client is awaiting completion. |

Final, amended, corrected, and entered-in-error states map directly to `Observation.status`; no UI extension value is used for those states.
