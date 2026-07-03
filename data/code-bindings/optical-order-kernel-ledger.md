# Optical Cash Order Kernel Verification Ledger (Slice 3)

Access date: 2026-07-03

Mandate 14 audit for the optical cash-order kernel builders (`mcp/src/fhir/opticalOrder.ts`, `opticalOrderStatus.ts`, `opticalCharge.ts`, `osodPaymentTender.ts`, `opticalInvoice.ts`, `opticalOrderComposite.ts`). The FHIR R4 composite model was dual-source verified 2026-07-03 during spec authoring (performance-od `decisions/2026-07-03-odos-slice3-optical-cash-order-kernel-spec.md` §7) against `hl7.org/fhir/R4` and `build.fhir.org`. Element names are additionally machine-checked at build time: `tsc --noEmit` compiles every builder against `@medplum/fhirtypes` R4 (generated from the official HL7 R4 StructureDefinitions).

**Billing codes: the builders hardcode no billing codes.** Every HCPCS/CPT code is caller-supplied (`hcpcsCode` / `code` inputs). The only code asserted anywhere in shipped optical-kernel code paths is `V2020` via reuse of the v0.6a frame builders — already verified in `v0.6-verification-ledger.md`; not re-asserted here. Codes appearing in test fixtures only (`V2100`, `92015`) are not shipped bindings.

## FHIR R4 resources and elements

| Artifact | Chosen value | Source 1 URL | Source 2 URL | Access date | Status |
|---|---|---|---|---|---|
| FHIR R4 resource | DeviceRequest | https://hl7.org/fhir/R4/devicerequest.html | https://build.fhir.org/devicerequest.html | 2026-07-03 | verified |
| FHIR R4 element (R4 name trap: `code[x]`, NOT R5 `product[x]`) | DeviceRequest.codeCodeableConcept | https://hl7.org/fhir/R4/devicerequest-definitions.html#DeviceRequest.code_x_ | https://build.fhir.org/devicerequest-definitions.html | 2026-07-03 | verified |
| FHIR R4 element (targets = Any; Device↔Vision link constrained via ODOS profile, not core) | DeviceRequest.basedOn → VisionPrescription | https://hl7.org/fhir/R4/devicerequest-definitions.html#DeviceRequest.basedOn | https://build.fhir.org/devicerequest-definitions.html | 2026-07-03 | provisional (legal per R4 Reference(Any); ODOS profile to formally constrain) |
| FHIR R4 resource | Task | https://hl7.org/fhir/R4/task.html | https://build.fhir.org/task.html | 2026-07-03 | verified |
| FHIR R4 element (carries the 17-value optical lifecycle) | Task.businessStatus | https://hl7.org/fhir/R4/task-definitions.html#Task.businessStatus | https://build.fhir.org/task-definitions.html | 2026-07-03 | verified |
| FHIR R4 elements | Task.focus → DeviceRequest; Task.for → Patient | https://hl7.org/fhir/R4/task-definitions.html#Task.focus | https://build.fhir.org/task-definitions.html | 2026-07-03 | verified |
| FHIR R4 required ValueSet (12 codes; optical statuses do NOT go here) | Task.status | https://hl7.org/fhir/R4/valueset-task-status.html | https://build.fhir.org/valueset-task-status.html | 2026-07-03 | verified |
| FHIR R4 resource (live core in R4, not R6-only) | ChargeItem | https://hl7.org/fhir/R4/chargeitem.html | https://build.fhir.org/chargeitem.html | 2026-07-03 | verified |
| FHIR R4 element (trap #1: `.service` cannot target DeviceRequest → order link here) | ChargeItem.supportingInformation | https://hl7.org/fhir/R4/chargeitem-definitions.html#ChargeItem.supportingInformation | https://build.fhir.org/chargeitem-definitions.html | 2026-07-03 | verified |
| FHIR R4 element (trap #3: no unit-price/line-total pair in R4 → fee here as Money) | ChargeItem.priceOverride | https://hl7.org/fhir/R4/chargeitem-definitions.html#ChargeItem.priceOverride | https://build.fhir.org/chargeitem-definitions.html | 2026-07-03 | verified |
| FHIR R4 element (R4 name trap: `context`, NOT R5 `encounter`) | ChargeItem.context | https://hl7.org/fhir/R4/chargeitem-definitions.html#ChargeItem.context | https://build.fhir.org/chargeitem-definitions.html | 2026-07-03 | verified |
| FHIR R4 elements (audit diff: engine rule + override reason beside priceOverride) | ChargeItem.definitionCanonical; ChargeItem.overrideReason | https://hl7.org/fhir/R4/chargeitem-definitions.html#ChargeItem.definitionCanonical | https://build.fhir.org/chargeitem-definitions.html | 2026-07-03 | verified (element names also machine-checked via @medplum/fhirtypes R4 compile) |
| FHIR R4 resource (trap #2: PaymentReconciliation is payer-scoped → cash payment here) | Invoice | https://hl7.org/fhir/R4/invoice.html | https://build.fhir.org/invoice.html | 2026-07-03 | verified |
| FHIR R4 element | Invoice.lineItem.chargeItemReference → ChargeItem | https://hl7.org/fhir/R4/invoice-definitions.html#Invoice.lineItem.chargeItem_x_ | https://build.fhir.org/invoice-definitions.html | 2026-07-03 | verified |
| FHIR R4 element (base + discount components; itemized tax/discount live here, not on ChargeItem) | Invoice.lineItem.priceComponent | https://hl7.org/fhir/R4/invoice-definitions.html#Invoice.lineItem.priceComponent | https://build.fhir.org/invoice-definitions.html | 2026-07-03 | verified |
| FHIR R4 elements | Invoice.totalGross; Invoice.totalNet | https://hl7.org/fhir/R4/invoice-definitions.html#Invoice.totalGross | https://build.fhir.org/invoice-definitions.html | 2026-07-03 | verified |
| FHIR R4 transaction semantics (urn:uuid fullUrl intra-bundle resolution) | Bundle type=transaction | https://hl7.org/fhir/R4/bundle.html#transaction | https://hl7.org/fhir/R4/http.html#transaction | 2026-07-03 | verified |

## ODOS-local CodeSystems and extensions (internal vocabularies — corpus-sourced, not external medical codes)

| Artifact | Chosen value | Source 1 | Source 2 | Access date | Status |
|---|---|---|---|---|---|
| ODOS CodeSystem (17 values, corpus-verbatim) | https://osod.dev/fhir/CodeSystem/optical-order-status | performance-od `reference/domain/.../foxfire-reverse-engineering/orders-optical-cl.md:171` | performance-od `decisions/2026-07-03-odos-slice3-optical-cash-order-kernel-spec.md` §4 | 2026-07-03 | verified (corpus-verbatim) |
| ODOS extension (trap #5: R4 has no coded tender field) | https://osod.dev/fhir/StructureDefinition/osod-payment-tender | orders-optical-cl.md:85 (Transactions-screen Codes: CASH · CHECK) | spec §7 item 5 | 2026-07-03 | verified (corpus-verbatim) |
| ODOS CodeSystem (payment tender) | https://osod.dev/fhir/CodeSystem/payment-tender — CASH, CHECK | orders-optical-cl.md:85 | spec §7 item 5 | 2026-07-03 | verified (corpus-verbatim) |
| ODOS CodeSystem (self-pay adjustments) | https://osod.dev/fhir/CodeSystem/optical-adjustment — PPAY, FAMILY | orders-optical-cl.md:82 | spec §5 | 2026-07-03 | provisional — full adjustment-code list is [MINE]; unknown codes carried verbatim until harvested from live Foxfire |

## Billing codes

| Artifact | Chosen value | Source 1 | Source 2 | Access date | Status |
|---|---|---|---|---|---|
| HCPCS frame code (reused, NOT re-asserted) | V2020 | `v0.6-verification-ledger.md` (v0.6a Frames Data) | performance-od `research/2026-05-08-v0.6a-verification-ledger-public-items.md` | 2026-05-08 | verified (v0.6a) |
| HCPCS system URI (reused from v0.6a `frame-types.ts`) | https://bluebutton.cms.gov/resources/codesystem/hcpcs | `v0.6-verification-ledger.md` | `mcp/src/catalog/frame-types.ts:5` | 2026-05-08 | verified (v0.6a) |
| Test-fixture codes (NOT shipped bindings) | V2100, 92015 | test files only (`opticalOrderComposite.test.ts`, `opticalChargeItem.test.ts`) | — | 2026-07-03 | provisional — fixture-only; verify before any shipped use |

## Deferred / [MINE] items (gate §8.2 log)

| Item | Status |
|---|---|
| Full adjustment-code list | [MINE] — harvest from live Foxfire (operator, ~5 min in-system) |
| Legal order-status transition matrix | [MINE] — v1 ships free-transition-within-the-17 (spec §4); `Cancelled` terminal + Order-Type immutability enforced at the service layer (UI/expansion phase), not in the builders |
| Lab cascade dropdowns | deferred with sub-segment 3.6 |
