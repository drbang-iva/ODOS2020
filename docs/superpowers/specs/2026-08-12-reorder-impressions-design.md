# Reorder Impressions Design

**Date:** 2026-08-12
**Status:** Approved with operator amendments
**Branch:** `drbang-iva/reorder-impressions`
**Base:** `main` at `c47a90c7`

## Goal

Let a clinician reorder all Encounter impressions at the end of an exam, including promoting a confirmed diagnosis to principal, while keeping ranks valid, showing the existing procedures attached to each diagnosis, and preserving a one-click Make Principal action.

## Server contract

`PUT /clinical-graph/encounters/:encounterId/diagnosis-order` accepts the complete desired ordering as an array of local `Condition/<id>` references. The endpoint requires `chart.write`, reads the current Encounter and all referenced Conditions, and rejects unless the request is an exact permutation of the Encounter diagnosis references.

The first requested Condition must be confirmed. Provisional diagnoses may appear elsewhere in the ordering and receive ordinary positive ranks, but may never receive rank 1. This rule is enforced by the endpoint so every caller shares it.

The endpoint constructs a complete Encounter copy in memory, assigning ranks `1..n`, and submits that one resource through one conditional FHIR update with the Encounter's current `meta.versionId`. No sequence of partial rank patches is permitted. A failed conditional update therefore leaves the prior Encounter unchanged.

The shared conflict classifier is `isFhirConflict`, extracted from `diagnosis-carry-forward-endpoint.ts` without changing its 409/412 semantics. Any conditional-write conflict returns HTTP 409 with the existing reload-and-retry posture. The endpoint does not retry because an Encounter version bump may include changes beyond diagnosis ranks, including intended coverage.

## UI contract

A shared `ReorderImpressionsModal` is available from both `AssessmentSection` and `DiagnosisWorkspace`. Opening the modal copies the Encounter's current rank ordering into local component state. Dragging or keyboard Move Up/Move Down changes only that local array. Cancel closes the modal and performs zero writes. Save sends the complete order in one endpoint call and refreshes the chart only after success.

The modal uses the exact title `Reorder Impressions` and instruction `Drag impression to desired position.` Each row shows the diagnosis display as its title and the active attached procedure displays as its subtitle. Attachments are grouped read-only from the existing procedure-charge response using each proposal's current `dxPointers`; this introduces no new association and no charge mutation.

Each row has a right-edge drag handle. Keyboard users can focus a row and use explicit Move Up and Move Down buttons. A provisional row is visibly identified and cannot be moved into position 1; Save is also protected by the server rule.

## Inline promotion

Both existing Make Principal entry points remain. Their handlers compute a complete permutation by placing the selected confirmed Condition first and preserving the relative order of every other impression, then call the same diagnosis-order client used by the modal. The legacy direct Encounter rank PATCH helpers are removed only after `ui/tests/diagnosisRankSafety.test.tsx` is migrated to prove the new endpoint payload and guards.

There is one authoritative server write path but two interaction paths: one-click promotion for the frequent action and the modal for arbitrary ordering. The former move-up/move-down secondary controls are replaced by the modal so there is no second arbitrary-ordering implementation.

## Provisional behavior

Provisional diagnoses remain visible because they are part of the clinical Encounter and must retain a stable place if later confirmed. They participate in the gap-free rank sequence but cannot occupy rank 1. Claim assembly remains unchanged and continues to exclude provisional Conditions.

## Scope fences

- Do not modify `mcp/src/claims/claim-draft.ts`.
- Do not modify charge-to-diagnosis linkage, `supportingInformation`, or `dxPointers` semantics.
- Do not add moving procedures between diagnoses.
- Do not touch fee-schedule or import-lane code.
- Do not change Claim assembly, ChargeItem shape, diagnosis seeds, or medical codes.
- No Mandate 14 ledger change is required because no terminology value or clinical code is added or changed.

## Verification

Server tests exercise the real endpoint with an in-memory FHIR client and prove exact permutation validation, confirmed-only principal, one conditional Encounter update, unique positive contiguous ranks, no diagnosis loss, and conflict rejection without a second update.

UI tests render the real modal and prove local drag/keyboard changes, diagnosis and attached-procedure display, zero-write Cancel, one-operation Save, and both Make Principal entry points calling the same client contract. Claim-draft is invoked unchanged after a reorder fixture and its resulting diagnosis order is asserted explicitly.

Required mutation proofs:

1. Mutate the server reorder so duplicate ranks can persist; the uniqueness/atomic-order test must fail, then pass after restoration.
2. Mutate Cancel so it saves local order; the zero-write Cancel test must fail, then pass after restoration.

Final gates run from the exact branch head without pipelines that mask exit codes: `scripts/gates.sh`, root `npm run preflight`, MCP build/test, and UI build/test. The PR is non-draft and requires independent Fable/Opus evaluation at the exact head before merge because Codex authored the code.
