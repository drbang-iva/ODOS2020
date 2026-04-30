# OSOD Provenance Signature Format

Verified in `data/code-bindings/v0.5-verification-ledger.md` row 41.

v0.5c pins clinician attestation and amendment signatures to:

| Field | Value |
|---|---|
| `Signature.type.system` | `urn:iso-astm:E1762-95:2013` |
| `Signature.type.code` | `1.2.840.10065.1.12.1.1` |
| `Signature.type.display` | `Author's Signature` |
| `Signature.sigFormat` | `application/jose` |

`Signature.data` is supplied as a base64-encoded detached signature envelope by the caller or signing layer. v0.5c validates the FHIR envelope shape and preserves the signing-key integration as an external precondition rather than minting a local key-management workflow inside this slice.
