# OSOD Clinical Attestation Policy URLs

Verified in `data/code-bindings/v0.5-verification-ledger.md` row 42.

| Policy | URL | v0.5c use |
|---|---|---|
| Clinical attestation | `https://osod.dev/fhir/Policy/clinical-attestation` | Preliminary scribe draft becomes `Observation.status = final`; Provenance activity `CREATE`. |
| Clinical amendment | `https://osod.dev/fhir/Policy/clinical-amendment` | Post-final amendment, correction, nullification, or append; Provenance activity `UPDATE`, `REVISE`, `NULLIFY`, or `APPEND`. |

FHIR R4 places policy URIs on top-level `Provenance.policy`. The FHIR AuditEvent projection surfaces the same URL in `AuditEvent.agent.policy` through the v0.5b audit row `policy_url` column.
