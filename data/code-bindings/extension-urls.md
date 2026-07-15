# OSOD Extension URLs

| Extension | URL | Cardinality | Status | Verification |
|---|---|---:|---|---|
| Observation attestation UI state | `https://osod.dev/fhir/StructureDefinition/observation-attestation-ui-state` | `0..1` on Observation | Optional, decorative UI state only | v0.5 ledger row 43 |
| Payment tender (CASH/CHECK on Invoice — Slice 3; reused leniently on PaymentReconciliation — v0.6c seam) | `https://osod.dev/fhir/StructureDefinition/osod-payment-tender` | `0..1` on Invoice; `0..1` on PaymentReconciliation | Required on a manually tendered Invoice; stamped on every processor PaymentReconciliation | optical-order-kernel-ledger.md; payment-reconciliation-seam-ledger.md |
| Processor fees | `https://osod.dev/fhir/StructureDefinition/osod-processor-fees` | `0..1` on PaymentReconciliation | valueMoney (USD); v0.7 settlement reconciliation input | payment-reconciliation-seam-ledger.md |
| Payment surface (complex: `surface` valueCode + optional `terminal-id` / `financing-application-id` valueString) | `https://osod.dev/fhir/StructureDefinition/osod-payment-surface` | `0..1` on PaymentReconciliation | Non-secret adapter metadata only | payment-reconciliation-seam-ledger.md |
| ERA import summary (complex: imported timestamp, outcome counters, payer/date, paid total cents) | `https://osod.dev/fhir/StructureDefinition/osod-era-import-summary` | `0..1` on the coded ERA-import Basic | Required on every persisted ERA import record | claimmd-clearinghouse-ledger.md |
| Manual EOB header (complex: payer, payment/deposit dates, total/applied amounts, status, and posting references) | `https://osod.dev/fhir/StructureDefinition/osod-manual-eob-header` | `0..1` on the coded manual-EOB Basic | Required on every persisted manual EOB header | claimmd-clearinghouse-ledger.md |
| Claim ChargeItem provenance | `https://osod.dev/fhir/StructureDefinition/osod-charge-item` | `0..1` on Claim.item or ClaimResponse.item | Required on every newly built professional Claim item; populated on ERA ClaimResponse items only when the clearinghouse echoes a valid local ChargeItem id | claimmd-clearinghouse-ledger.md |
| Patient-responsibility Invoice source Claim | `https://osod.dev/fhir/StructureDefinition/osod-source-claim` | `0..1` on Invoice | Required on each ERA-created patient-responsibility Invoice | claimmd-clearinghouse-ledger.md |

Clinical attestation, amendment routing, audit classification, and Information Blocking logic consume `Observation.status`, not this extension.
