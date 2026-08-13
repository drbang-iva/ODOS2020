# Reorder Impressions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add atomic, accessible Encounter impression reordering while retaining one-click principal promotion through the same server endpoint.

**Architecture:** A new clinical-graph endpoint validates a complete Condition-reference permutation, rejects provisional rank 1, assigns ranks in memory, and conditionally replaces the Encounter once. A shared React modal edits a local ordering until Save and groups existing procedure proposals by `dxPointer`; both Make Principal buttons compute a permutation and call the same typed client.

**Tech Stack:** TypeScript, FHIR R4 `Encounter` and `Condition`, Express, Zod, React, native drag events, Node test runner, react-test-renderer, Vite.

**Spec:** `docs/superpowers/specs/2026-08-12-reorder-impressions-design.md`

## Global Constraints

- Base is `main` at `c47a90c7`; work only on `drbang-iva/reorder-impressions`.
- A provisional diagnosis may participate in ordering but must never receive rank 1.
- Save performs one conditional Encounter update; Cancel performs zero writes.
- Any 409/412 conditional-write conflict is rejected with reload-and-retry guidance; there is no retry.
- Preserve Make Principal in both charting surfaces and route both through the new endpoint.
- Replace legacy secondary move controls with the shared modal; do not leave two arbitrary-ordering mechanisms.
- Procedure attachments are read-only and derived only from existing `dxPointers`.
- Do not modify claim-draft, ChargeItem shape, dxPointer semantics, fee schedule/import code, diagnosis seeds, or terminology ledgers.
- Every production behavior starts with a focused failing test and observed expected failure.
- Codex authors but does not evaluate; exact-head Fable/Opus evaluation is required before merge.

---

## File Map

### Create

- `mcp/src/clinical-graph/fhir-conflict.ts` — shared `isFhirConflict(error)` classifier extracted from carry-forward.
- `mcp/src/clinical-graph/diagnosis-order-endpoint.ts` — request validation, Condition verification, one conditional Encounter update, and conflict response.
- `mcp/tests/diagnosisOrder.test.ts` — endpoint, claim-order acceptance, conflict, and atomicity coverage.
- `ui/src/components/charting/ReorderImpressionsModal.tsx` — local ordering, drag and keyboard controls, attachment grouping, Cancel/Save.
- `ui/tests/reorderImpressions.test.tsx` — rendered modal, Cancel/Save, drag, keyboard, attachments, and mutation target.

### Modify

- `mcp/src/clinical-graph/diagnosis-carry-forward-endpoint.ts` — import the shared unchanged conflict classifier.
- `mcp/src/index.ts` — register the new PUT route with `chart.write`.
- `ui/src/lib/clinical-graph-client.ts` — add typed `updateDiagnosisOrder` client.
- `ui/src/lib/clinical-actions.ts` — replace direct rank PATCH helpers with pure permutation builders if still shared by both surfaces.
- `ui/src/components/charting/AssessmentSection.tsx` — keep Make Principal, add modal entry, remove legacy secondary moves, provide procedure attachments.
- `ui/src/components/charting/DiagnosisWorkspace.tsx` — same authoritative actions and shared modal.
- `ui/tests/diagnosisRankSafety.test.tsx` — migrate principal-promotion safety tests to the endpoint permutation contract.
- `ui/tests/diagnosisWorkspace.test.tsx` — verify the workspace Make Principal and modal integration.

---

### Task 1: Atomic Diagnosis-Order Endpoint

**Interfaces:**

- Consumes: `{ authHeader, params: { encounterId }, body: { conditionReferences: string[] } }`.
- Produces: `handleDiagnosisOrderRequest(deps, request) -> { status, body }` and HTTP PUT route.
- Produces: shared `isFhirConflict(error: unknown): boolean` with the existing carry-forward semantics.

- [ ] Add `mcp/tests/diagnosisOrder.test.ts` with focused failing tests that invoke the real handler against an in-memory FHIR client. Literal fixtures must cover order `[confirmed-b, confirmed-a, provisional-c]`, expected ranks `[2, 1, 3]` in Encounter storage order, exactly one update call, `If-Match: W/"7"`, and no lost references.
- [ ] Add failing rejection cases for missing/duplicate/foreign references and for `[provisional-c, confirmed-a, confirmed-b]`; assert zero update calls and a 422 response for each invalid request.
- [ ] Add a failing conflict case whose update throws status 412; assert HTTP 409, reload-and-retry message, exactly one update attempt, and the original Encounter ranks still `[1,2,3]`.
- [ ] Run `cd mcp && node --import tsx --test --test-concurrency=1 tests/diagnosisOrder.test.ts`; record the expected module-not-found red output.
- [ ] Extract `isFhirConflict` unchanged into `mcp/src/clinical-graph/fhir-conflict.ts`, import it into carry-forward, implement the Zod-strict endpoint, read the exact referenced Conditions, require confirmed first, normalize ranks to `1..n`, and call one conditional `fhir.update`.
- [ ] Register `PUT /clinical-graph/encounters/:encounterId/diagnosis-order` with `chart.write` in `mcp/src/index.ts`.
- [ ] Rerun the focused command and require all endpoint tests green.

### Task 2: Claim-Order Behavioral Acceptance

**Interfaces:**

- Consumes: the Encounter returned by the real diagnosis-order handler and the unchanged `buildClaimDraft` path.
- Produces: explicit resulting Claim diagnosis order after promotion.

- [ ] Add a failing test to `mcp/tests/diagnosisOrder.test.ts` that first calls the handler, then stores its updated Encounter and invokes the real claim-draft assembler with confirmed Condition fixtures and one existing charge pointer. Assert the exact diagnosis code order matches new ranks and the charge pointer resolves to the newly computed sequence.
- [ ] Run the focused MCP test and observe failure before adding only the fixture plumbing required to feed the updated Encounter into the unchanged claim path.
- [ ] Make the test green without editing `mcp/src/claims/claim-draft.ts`.

### Task 3: Typed Client and Shared Modal

**Interfaces:**

- Produces: `updateDiagnosisOrder(encounterId, conditionReferences, fetchImpl?)` returning the updated Encounter and dispatching the existing encounter-diagnosis refresh event.
- Produces: `ReorderImpressionsModal` receiving ordered rows, `open`, `busy`, `onCancel`, and async `onSave(conditionReferences)`.
- Each row contains `conditionReference`, `diagnosisDisplay`, `provisional`, and literal `procedureDisplays` derived from existing procedure proposals.

- [ ] Add `ui/tests/reorderImpressions.test.tsx` with a real rendered modal. Before implementation, name the break each case catches: Cancel accidentally persists, Save issues more than one operation, drag order is ignored, keyboard movement is absent, or dxPointer-grouped procedure labels disappear.
- [ ] Assert opening and moving locally followed by Cancel calls `onSave` zero times; Save calls it once with the complete literal permutation; a keyboard Move Up moves a confirmed row; a provisional row cannot move into first; drag-drop changes the same local array; row titles and attached procedure subtitles render.
- [ ] Run `cd ui && node --import tsx --test tests/reorderImpressions.test.tsx`; record the expected module-not-found red output.
- [ ] Implement the typed client and modal with local state reset on open, explicit buttons, native drag handlers, right-edge handle, and no persistence from Cancel.
- [ ] Rerun the focused UI test until all cases pass.

### Task 4: Integrate Both Charting Surfaces

**Interfaces:**

- Consumes: the shared modal, procedure-charge read response, and `updateDiagnosisOrder`.
- Produces: one-click Make Principal permutations and modal access in `AssessmentSection` and `DiagnosisWorkspace`.

- [ ] Migrate `ui/tests/diagnosisRankSafety.test.tsx` before production edits. Replace assertions on direct JSON Patch operations with assertions that promotion of secondary B yields `[B, principal, secondary A]`, preserves every reference once, rejects provisional promotion locally, and makes exactly one diagnosis-order request.
- [ ] Add focused failing integration tests proving both surfaces retain visible Make Principal and invoke the same client contract; prove legacy Move up/Move down controls are absent and Reorder Impressions is present.
- [ ] Run the focused rank/workspace tests and record expected failures against the legacy direct-PATCH implementation.
- [ ] Add a pure permutation builder, route both Make Principal handlers through `updateDiagnosisOrder`, add shared modal launch state, and remove only the legacy arbitrary secondary move handlers/controls.
- [ ] Read procedure charges without mutation, group accepted proposals by their existing first `dxPointer`, and pass displays to the modal. Loading failures must not block diagnosis ordering; render a truthful no-attachments state.
- [ ] Rerun `diagnosisRankSafety`, `diagnosisWorkspace`, and `reorderImpressions` focused tests green.

### Task 5: Mutation Proofs and Rendered Evidence

- [ ] Mutation A: change the endpoint rank assignment so two reordered diagnoses receive rank 1. Run the focused uniqueness test, capture literal TAP red output, restore the correct implementation, rerun, and capture literal TAP green output.
- [ ] Mutation B: change the modal Cancel handler to call Save with the local order. Run the focused Cancel test, capture literal TAP red output, restore, rerun, and capture literal TAP green output.
- [ ] For each load-bearing test, record the concrete production break that makes it red: duplicate assignment, provisional principal acceptance, multiple Encounter updates/retry, Cancel persistence, attachment grouping loss, or missing keyboard operation.
- [ ] Run the local synthetic chart, open the modal with multiple diagnoses and attached procedures, exercise keyboard ordering, and save a screenshot under the existing PR evidence convention without exposing credentials or PHI.

### Task 6: Exact-Head Gates and Publication

- [ ] Run `scripts/gates.sh` from the repository root with output redirected to an evidence file and separately capture its exit code.
- [ ] Run `npm run preflight` from root; `cd mcp && npm run build && npm test`; and `cd ui && npm run build && npm test`, each without a masking pipeline. Record total, passed, failed, and skipped counts from the complete logs.
- [ ] Confirm hard scope fences with `git diff --name-only c47a90c7...HEAD`, inspect `git diff --check`, and confirm no terminology ledger or decision-index update is required.
- [ ] Commit intentional files, push `drbang-iva/reorder-impressions`, and open a non-draft PR against `main` containing scope fences, both mutation proofs, exact outputs/counts, behavioral evidence, screenshot, and the explicit author-not-evaluator warning.
- [ ] Poll Greptile and PR-Agent at the final head; adjudicate every finding present. Do not wait for or trigger CodeRabbit.
- [ ] Return a sealed bundle with summary, files touched, commit hashes, branch, checks and counts, risks/follow-ups, blockers, and `needs-review` status pending independent exact-head Fable/Opus evaluation.
