# Claim.MD Clearinghouse Integration Verification Ledger (v0.6d)

Access date: 2026-07-09.

This slice adds no hardcoded CPT, HCPCS, ICD-10, SNOMED, LOINC, RxNorm, NDC, or UCUM values. Professional procedure and diagnosis codes are caller-supplied from existing ChargeItem and diagnosis inputs. Test fixtures use synthetic non-medical code systems under `https://osod.test/...`.

| Assertion | Binding / URL | Source 1 | Source 2 | Status |
|---|---|---|---|---|
| FHIR R4 professional claim resource and required fields used by `buildProfessionalClaim` | Claim.status/type/use/patient/created/provider/insurance/item | https://hl7.org/fhir/R4/claim.html | `@medplum/fhirtypes/dist/Claim.d.ts` | verified |
| FHIR R4 claim type code for professional claims | `http://terminology.hl7.org/CodeSystem/claim-type` code `professional` | https://terminology.hl7.org/CodeSystem-claim-type.html | https://hl7.org/fhir/R4/valueset-claim-type.html | verified |
| FHIR R4 ClaimResponse resource and request link back to Claim | ClaimResponse.request -> Claim; outcome queued/complete/error/partial | https://hl7.org/fhir/R4/claimresponse.html | `@medplum/fhirtypes/dist/ClaimResponse.d.ts` | verified |
| FHIR R4 CoverageEligibility request/response resources | CoverageEligibilityRequest; CoverageEligibilityResponse | https://hl7.org/fhir/R4/coverageeligibilityrequest.html | https://hl7.org/fhir/R4/coverageeligibilityresponse.html | verified |
| FHIR R4 PaymentReconciliation insurance allocation row | `PaymentReconciliation.detail.request -> Claim`; `detail.response -> ClaimResponse` | https://hl7.org/fhir/R4/paymentreconciliation-definitions.html#PaymentReconciliation.detail.request | `@medplum/fhirtypes/dist/PaymentReconciliation.d.ts` (`request?: Reference<Resource>`, `response?: Reference<Resource>`) | verified |
| Claim.MD claim upload endpoint and acceptable JSON/837P upload path | `POST https://svc.claim.md/services/upload/`, `AccountKey`, file upload, Accept JSON | https://api.claim.md/ | https://www.claim.md/ClaimMD_Professional_Claims_Example.json | verified |
| Claim.MD eligibility endpoint | `POST /services/eligdata/`; real-time 270/271-style eligibility data; JSON/XML via Accept | https://api.claim.md/ | https://docs.claim.md/docs/test-account-quickstart-guide#check-benefitseligibility | verified |
| Claim.MD claim status polling endpoint | `POST /services/response/`; poll with `ResponseID`, optionally `ClaimID` | https://api.claim.md/ | https://docs.claim.md/docs/test-account-quickstart-guide#claim-status | verified |
| Claim.MD ERA delivery mechanism | ERA is polling, not webhook; list via `/services/eralist/`, details via `/services/eradata/` | https://api.claim.md/ | https://docs.claim.md/docs/does-the-claimmd-webhook-deliver-era-notifications | verified |
| Claim.MD ERA payment method field | `payment_method` available in ERA API response | https://docs.claim.md/docs/how-can-i-identify-the-era-payment-method-using-the-claimmd-api | https://api.claim.md/#/paths/~1services~1eradata~1/post | verified |
| ODOS business action for claims endpoint gate | `claims.manage` granted to `practice-admin`, `front-desk` only | `mcp/src/authz/roles.ts` | `mcp/tests/claimHandlers.test.ts` | verified (local) |
| ODOS audit event types for claims/eligibility/ERA/status | `claim.submit.*`, `eligibility.check.*`, `era.import.*`, `claim.status.checked` | `mcp/src/authz/osodAudit.ts` | `mcp/src/claims/claim-audit.ts`; `mcp/tests/claimHandlers.test.ts` | verified (local) |
| ODOS Claim.MD ERA identifier namespace | `https://osod.dev/fhir/NamingSystem/claimmd-era` | `mcp/src/payments/payment-reconciliation.ts` | this ledger | verified (local) |
| ODOS Claim patient-account identifier namespace | `https://osod.dev/fhir/NamingSystem/osod-claim-pcn` | `mcp/src/claims/claimmd-fhir.ts` | this ledger | verified (local) |

Live-account gate: no Claim.MD AccountKey is committed. The adapter stays disabled until an operator supplies `CLAIMMD_ACCOUNT_KEY`; fixture-backed unit tests cover request/response shapes without live calls.
