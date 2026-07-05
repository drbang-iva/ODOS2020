# Invoice ↔ PaymentReconciliation Seam Verification Ledger (v0.6c tranche 1)

Access date: 2026-07-05

Mandate 14 audit for the payments-slice seam builders (`mcp/src/payments/payment-processor-adapter.ts`, `payment-reconciliation.ts`, `payment-audit.ts`, `adapters/manual-cash-adapter.ts`; edits to `mcp/src/fhir/osodPaymentTender.ts`, `opticalInvoice.ts`, `opticalOrderComposite.ts`, `opticalFinancialSummary.ts`). The seam model (Invoice = the bill; PaymentReconciliation = the settling processor payment; link = `PaymentReconciliation.detail.request → Invoice`) is specified in performance-od `decisions/2026-07-05-odos-payment-reconciliation-seam-spec.md`. Element names are additionally machine-checked two ways: against the installed `@medplum/fhirtypes` R4 declarations (`PaymentReconciliation.d.ts` read during spec authoring 2026-07-05) and at build time via `tsc --noEmit`.

**Billing codes: this tranche asserts no billing codes.** No HCPCS/CPT appears in any payments-module code path; charge lines remain caller-supplied through the Slice-3 builders. Card data: no PAN/CVV/track-data or processor token is ever persisted — the only instrument detail carried is brand + last-4 as a display label (not PCI-scoped).

## FHIR R4 resources and elements

| Artifact | Chosen value | Source 1 URL | Source 2 URL | Access date | Status |
|---|---|---|---|---|---|
| FHIR R4 resource (used ONLY for processor settlements; the manual cash record stays on Invoice per Slice-3 trap #2) | PaymentReconciliation | https://hl7.org/fhir/R4/paymentreconciliation.html | https://build.fhir.org/paymentreconciliation.html | 2026-07-05 | verified |
| FHIR R4 element (THE LINK — `Reference(Any)`, so Invoice is a legal target; ODOS profile to formally constrain, same posture as DeviceRequest.basedOn in Slice 3) | PaymentReconciliation.detail.request → Invoice | https://hl7.org/fhir/R4/paymentreconciliation-definitions.html#PaymentReconciliation.detail.request | `@medplum/fhirtypes/dist/PaymentReconciliation.d.ts` (`request?: Reference<Resource>`) | 2026-07-05 | provisional (legal per R4 Reference(Any); ODOS profile to formally constrain) |
| FHIR R4 required VS (active · cancelled · draft · entered-in-error) | PaymentReconciliation.status | https://hl7.org/fhir/R4/valueset-fm-status.html | `@medplum/fhirtypes/dist/PaymentReconciliation.d.ts` | 2026-07-05 | verified |
| FHIR R4 VS (queued · complete · error · partial; success→complete, pending→queued) | PaymentReconciliation.outcome | https://hl7.org/fhir/R4/valueset-remittance-outcome.html | `@medplum/fhirtypes/dist/PaymentReconciliation.d.ts` | 2026-07-05 | verified |
| FHIR R4 required elements (created = dateTime; paymentDate = date, builder enforces YYYY-MM-DD; paymentAmount = Money USD) | PaymentReconciliation.created; .paymentDate; .paymentAmount | https://hl7.org/fhir/R4/paymentreconciliation-definitions.html#PaymentReconciliation.created | https://build.fhir.org/paymentreconciliation-definitions.html | 2026-07-05 | verified |
| FHIR R4 element (the processor's transaction id + adapter namespace) | PaymentReconciliation.paymentIdentifier | https://hl7.org/fhir/R4/paymentreconciliation-definitions.html#PaymentReconciliation.paymentIdentifier | https://build.fhir.org/paymentreconciliation-definitions.html | 2026-07-05 | verified |
| FHIR R4 element (`Reference<Task>` — the order's 17-status lifecycle Task) | PaymentReconciliation.request → Task | https://hl7.org/fhir/R4/paymentreconciliation-definitions.html#PaymentReconciliation.request | `@medplum/fhirtypes/dist/PaymentReconciliation.d.ts` (`request?: Reference<Task>`) | 2026-07-05 | verified |
| FHIR R4 elements (staff attribution; practice merchant org) | PaymentReconciliation.requestor; .paymentIssuer | https://hl7.org/fhir/R4/paymentreconciliation-definitions.html#PaymentReconciliation.requestor | https://build.fhir.org/paymentreconciliation-definitions.html | 2026-07-05 | verified |
| FHIR R4 element + bound CodeSystem (payment · adjustment · advance; charge = `payment`) | PaymentReconciliation.detail.type ← http://terminology.hl7.org/CodeSystem/payment-type | https://hl7.org/fhir/R4/codesystem-payment-type.html | https://terminology.hl7.org/CodeSystem-payment-type.html | 2026-07-05 | verified |
| FHIR R4 required VS value (manual adapter sets `balanced` when a payment covers totalNet) | Invoice.status = balanced | https://hl7.org/fhir/R4/valueset-invoice-status.html | https://build.fhir.org/valueset-invoice-status.html | 2026-07-05 | verified |

## ODOS-local extensions and vocabularies (internal — corpus-sourced, not external medical codes)

| Artifact | Chosen value | Source 1 | Source 2 | Access date | Status |
|---|---|---|---|---|---|
| ODOS extension (R4 PaymentReconciliation has no fee field; v0.7 settlement recon input) | https://osod.dev/fhir/StructureDefinition/osod-processor-fees (valueMoney USD) | seam spec §5 | `mcp/src/payments/payment-reconciliation.ts` | 2026-07-05 | verified (local) |
| ODOS complex extension (sub-ext `surface` valueCode; optional `terminal-id`, `financing-application-id` valueString — non-secret refs only) | https://osod.dev/fhir/StructureDefinition/osod-payment-surface | seam spec §5 | 2026-05-05 payment-processor-architecture (three-surface model) | 2026-07-05 | verified (local) |
| ODOS extension REUSED on PaymentReconciliation (same URL/CodeSystem as the Slice-3 Invoice tender; lenient builder for the PR path — strict CASH/CHECK assertion still guards the Invoice path) | https://osod.dev/fhir/StructureDefinition/osod-payment-tender | optical-order-kernel-ledger.md (Slice-3 rows) | seam spec §3/§7 | 2026-07-05 | verified (reuse) |
| ODOS CodeSystem payment-tender EXTENDED (non-cash rows): CCP "Credit Card Payment", CLOVER "Clover Processing", CARE "Care Credit", SP_CARD "Credit Card", SP_ACH "ACH Check", SP_ACF "Alternative Financing" — Foxfire transaction-code verbatim; CARD "Card" = ODOS-generic addition | https://osod.dev/fhir/CodeSystem/payment-tender | performance-od `foxfire-reverse-engineering/orders-optical-cl.md` transaction-code table (harvest 2026-07-03) | `mcp/src/fhir/osodPaymentTender.ts` `PROCESSOR_PAYMENT_TENDERS` | 2026-07-05 | verified (corpus-verbatim; CARD flagged ODOS-native; vocabulary practice-extensible → unknown codes carried verbatim) |
| ODOS audit event types (9; count-vs-list lockstep with `OSOD_AUDIT_EVENT_TYPES` enforced by test + `satisfies` type check) | payment.charge.attempted/.completed/.failed · payment.refund.attempted/.completed · payment.void.attempted · payment.settle.batch · payment.financing.preauthorized/.declined | 2026-05-05 payment-processor-architecture (audit pattern section) | `mcp/src/payments/payment-audit.ts` + `tests/paymentAudit.test.ts` | 2026-07-05 | verified (local) |

## Billing codes

| Artifact | Chosen value | Source 1 | Source 2 | Access date | Status |
|---|---|---|---|---|---|
| (none asserted this tranche) | — | — | — | 2026-07-05 | n/a — charge lines remain caller-supplied via Slice-3 builders |

**Seam invariants under test:** the exactly-one-payment-source rule (§3) and the receipt-consistency guard (§8 — identical Totals/AMOUNT DUE NOW across cash vs processor paths) are locked by `tests/paymentSeamConsistency.test.ts` (mutation-proven) and the double-tender rejection in `manual-cash-adapter.ts`.

## Clover REST Pay Display adapter (tranche 2 — vendor API shapes, doc-verified)

Access date: 2026-07-05. Sources are Clover's current primary documentation; the make-a-sale response sample is carried verbatim as the unit-test fixture in `tests/cloverAdapter.test.ts`.

| Artifact | Chosen value | Source 1 | Source 2 | Access date | Status |
|---|---|---|---|---|---|
| Charge endpoint (cloud) | `POST {base}/connect/v1/payments` — body `{amount (cents), externalPaymentId, final}`; response `payment.{id, result, amount, createdTime, cardTransaction.{cardType,last4,authCode}}`; `result === "SUCCESS"` = captured sale | https://docs.clover.com/dev/docs/making-a-sale | https://docs.clover.com/dev/docs/rest-pay-overview | 2026-07-05 | verified |
| Required headers | `Authorization: Bearer {OAuth expiring token}` (explicitly NOT a static merchant token) · `X-Clover-Device-Id` (device serial) · `X-POS-Id` · `Idempotency-Key` (required on payment/charge/refund/capture) | https://docs.clover.com/dev/docs/rest-pay-development-basics | https://docs.clover.com/dev/docs/rest-pay-overview | 2026-07-05 | verified |
| Sandbox base URL | `https://apisandbox.dev.clover.com` (endpoints under `/connect/v1/`) | https://docs.clover.com/dev/docs/rest-pay-development-basics | docs.clover.com search corroboration (`/connect/v1/device/ping` example) | 2026-07-05 | verified |
| Refund endpoint (v0.7-fenced; recorded for the deferral message) | `POST {base}/connect/v1/payments/{paymentId}/refunds` — `{fullRefund: true}` or `{amount}` | https://docs.clover.com/dev/docs/refunding-a-charge | https://docs.clover.com/dev/docs/api-tutorials | 2026-07-05 | verified (workflow deferred) |
| Device constraint (drives the operator setup doc) | Cloud Pay Display cannot run in an emulator; production devices cannot join sandbox → Dev Kit required for sandbox E2E | https://docs.clover.com/dev/docs/devices-and-dev-kits-faqs | https://docs.clover.com/dev/docs/cloud-sdk-v3 | 2026-07-05 | verified |
| ODOS NamingSystem (local — Clover payment ids on PaymentReconciliation.paymentIdentifier) | https://osod.dev/fhir/NamingSystem/clover-payment | `mcp/src/payments/adapters/clover-adapter.ts` | seam ledger (this file) §5 paymentIdentifier row | 2026-07-05 | verified (local) |

No card data fields are parsed beyond `cardType` + `last4` (receipt label — not PCI-scoped); the OAuth token is used for the Authorization header only and unit-test-asserted absent from the persisted PaymentReconciliation.

## Checkout charge boundary (tranche 3 — no new FHIR codes)

Access date: 2026-07-05. `POST /payments/charge` on osod-core (unified dispatch: `payment-config.ts` → adapters; handler `payment-charge-handler.ts`; wiring `index.ts`). No new medical codes, FHIR elements, or extensions — the endpoint composes the already-ledgered seam artifacts. New internal authz vocabulary only:

| Artifact | Chosen value | Source 1 | Source 2 | Access date | Status |
|---|---|---|---|---|---|
| OSOD business action (RBAC gate on the charge route, same pattern as audit.read) | `payment.charge` — granted to `front-desk`, `practice-admin`; denied to `clinician`, `auditor`, `aesthetics-provider` | `mcp/src/authz/roles.ts` (v0.5a RBAC substrate) | `mcp/tests/paymentEndpoint.test.ts` | 2026-07-05 | verified (local) |
| Authn for the forwarded UI token | Medplum `GET /auth/me` → staff Practitioner/PractitionerRole profile; non-staff profiles (Patient) rejected | Medplum auth API (`/auth/me`, token-introspection pattern already used by the stack) | `mcp/src/payments/payment-endpoint.ts` + tests | 2026-07-05 | verified |
| Attribution invariant | The charge's requestor/audit actor is ALWAYS the verified token identity; a body-supplied `staffReference` is ignored | seam spec §5 (staff attribution) | `mcp/tests/paymentChargeHandler.test.ts` (impostor test) | 2026-07-05 | verified |

`payment.charge.attempted` (device-attempt granularity) is registered but not yet emitted — the endpoint audits `completed`/`failed`; attempt-level emission lands with the UI tranche if operationally wanted.
