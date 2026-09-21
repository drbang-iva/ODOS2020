# Email unsubscribe E1c-1 verification ledger

Access date for the sources below: 2026-09-20.

| Binding | Classification | Primary evidence | Agreement / implementation |
| --- | --- | --- | --- |
| Basic.identifier, Basic.subject, Basic.created, extension | FHIR R4 structure | https://hl7.org/fhir/R4/basic.html ; https://www.medplum.com/docs/api/fhir/resources/basic | Both document identifiers, subject references, date-valued created, and extension-based custom data. Issuance/revocation instants live in the extension, not Basic.created. |
| email-unsubscribe-token, email-marketing-suppression-address, email-address-suppression, odos-email-unsubscribe | Locally authored ODOS identifiers and resource kind; not medical terminology or externally assigned FHIR artifacts | mcp/src/comms/email-unsubscribe.ts ; data/canonical-extensions/registry.json | Defined here under the existing ODOS namespaces. No external clinical coding claim. |

This Markdown ledger is documentary: this list is not enforced. It is not loaded by diagnosis-code-ledgers.ts and is not a runtime allowlist. The canonical-extension registry is enforced by tests/preflight/preflight-lint.test.ts. Conditional creation and version-conditional updates are exercised against local Medplum by the E1c-1 live tests; this ledger makes no legal compliance or commercial-sending readiness claim.
