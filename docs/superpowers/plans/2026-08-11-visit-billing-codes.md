# Visit Billing Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship 13 fee-schedule concepts, a passive 12-option encounter visit selector backed by manual `ChargeProposal` rows, and source-verified HCPCS provenance without creating a parallel charge path.

**Architecture:** Extend the existing `ChargeItemDefinition` fee schedule with an optional practice billing code whose coding is positionally first. Store a selected visit as the encounter's single stable manual `ChargeProposal`; the existing sign-cleanup materializer remains the only creator of `ChargeItem`. Keep protocol-linked proposals strict, keep uncoded concepts legal, and pin the existing claim assembler's positional coding contract through its public `buildProfessionalClaim()` consumer.

**Tech Stack:** TypeScript, Node test runner, Zod, FHIR R4 resources, React 18, Medplum FHIR types, existing `ProtocolBasicStore`, existing catalog editor.

## Global constraints

- Work only on `drbang-iva/visit-billing-codes` in the isolated worktree.
- Do not modify any file under `mcp/tests`.
- Do not modify existing `data/code-bindings/*.md` files or any diagnosis/coverage ledger.
- Add no CPT procedure value to source, test, documentation, or final diff.
- Add no direct `ChargeItem` endpoint, no procedure picker, no refraction selector, and no laterality projection.
- Every production behavior starts with a focused failing test and is observed red before implementation.
- Existing `mcp/src/__tests__/protocol-phase5.test.ts` is verification-only and remains byte-identical.

---

## Task 1: Add verified billing provenance and shipped fee concepts

**Files:**

- Create: `data/code-bindings/visit-billing-codes-phase0-ledger.json`
- Create: `mcp/src/__tests__/visit-billing-codes.test.ts`
- Modify: `mcp/src/clinical-graph/procedure-fee-schedule.ts`
- Modify: `mcp/src/clinical-graph/procedure-fee-schedule-endpoint.ts`

### 1.1 Write the failing seed and persistence tests

In the new MCP test file, build a real in-memory FHIR client capable of `ChargeItemDefinition`, `Basic`, `Encounter`, and `ChargeItem` reads/searches/creates/updates. Add literal expectations that prove:

- `PROCEDURE_FEE_SEEDS` contains the 5 existing procedures plus exactly 13 new rows.
- The new rows contain all 12 approved visit concept keys and `refraction`.
- Only `routine-vision-exam-new` and `routine-vision-exam-established` are prefilled, with `S0620` and `S0621` respectively.
- The other 11 new concepts have no `billingCode` property.
- A seeded `ChargeItemDefinition` places the practice billing coding first and the ODOS procedure concept coding second.
- Saving a mixed-case, padded billing value normalizes it to uppercase and preserves the price/active state.
- Saving `null` or blank removes only the billing coding.
- Saving price or active state with `billingCode` absent preserves the existing billing coding.

Run:

```bash
cd mcp && node --import tsx --test src/__tests__/visit-billing-codes.test.ts
```

Expected: FAIL because the seed rows and `billingCode` contract do not exist.

### 1.2 Add the two-row Mandate 14 ledger

Create a phase-0 JSON ledger with `mandate`, `accessDate`, `sources`, and exactly two code rows. Record both CMS quarterly Alpha-Numeric HCPCS files, both accessed `2026-08-11`, and the source-verbatim rows:

- `S0620` — `Routine ophthalmological examination including refraction; new patient`
- `S0621` — `Routine ophthalmological examination including refraction; established patient`

Include the independently captured ZIP SHA-256 values and `sourceRefs`. Add no coverage rules, diagnoses, CPT, or procedure-to-diagnosis wiring.

### 1.3 Implement the fee-schedule model

In `procedure-fee-schedule.ts`:

- Export constants for the ODOS concept system and the HCPCS system where tests/consumers require them.
- Extend seed rows and `ProcedureFeeScheduleItem` with `billingCode?: string`.
- Add the 13 approved rows with the exact approved labels.
- Update `ensureProcedureFeeSchedule()` so newly seeded S-code definitions carry the verified code and additional ad-hoc procedure keys remain uncoded.
- Extend `saveProcedureFeeScheduleItem()` with `billingCode?: string | null`, preserving on `undefined` and removing on `null`/blank.
- Normalize at the server boundary with trim, uppercase, and a loose alphanumeric constraint.
- Build `ChargeItemDefinition.code.coding` as billing first, concept second. Letter-leading billing values use `https://bluebutton.cms.gov/resources/codesystem/hcpcs`; other practice-entered values use `urn:ama:cpt`.
- Keep `procedureConceptKey()` system-based rather than positional.
- Return `billingCode` from the stored definition.

In `procedure-fee-schedule-endpoint.ts`, accept optional nullable `billingCode` on save and pass it through. Deactivation omits it so the stored value is preserved.

### 1.4 Run focused green verification

Run the focused MCP test again. Expected: all Task 1 tests pass.

### 1.5 Commit

```bash
git add data/code-bindings/visit-billing-codes-phase0-ledger.json mcp/src/__tests__/visit-billing-codes.test.ts mcp/src/clinical-graph/procedure-fee-schedule.ts mcp/src/clinical-graph/procedure-fee-schedule-endpoint.ts
git commit -m "feat: seed visit billing concepts"
```

---

## Task 2: Relax only manual charge proposals and add the stable visit seam

**Files:**

- Modify: `mcp/src/__tests__/visit-billing-codes.test.ts`
- Modify: `mcp/src/clinical-graph/protocol-types.ts`
- Modify: `mcp/src/clinical-graph/procedure-fee-schedule.ts`
- Modify: `mcp/src/clinical-graph/protocol-endpoint.ts`
- Modify: `mcp/src/index.ts`

### 2.1 Write failing materializer tests

Add tests proving:

- An accepted proposal with absent `protocolApplicationId` materializes when units, concept key, and diagnosis pointers are valid.
- An absent application id does not weaken invalid-units, invalid-concept-key, or invalid-diagnosis-pointer checks.
- A populated missing application id still throws the existing active-confirmed-application error.
- An empty string counts as populated and still throws.
- A proposal with `chargeItemRef` retains existing idempotent skip/finalize behavior.

Run the focused file and observe failure because the type and linkage check are still mandatory.

### 2.2 Implement the surgical linkage relaxation

- Change `ChargeProposal.protocolApplicationId` to `protocolApplicationId?: string | null`.
- In `materializeAcceptedChargeProposals()`, execute the existing application lookup and validation only when the value is not `undefined` and not `null`.
- Do not reorder or weaken any other validation.
- Do not change `buildChargeItem()` laterality behavior or the `chargeItemRef` branch.

Run the focused test. Expected: the manual case and strict populated-id cases pass.

### 2.3 Write failing manual-visit handler tests

Through new public handler functions in `protocol-endpoint.ts`, test these observable contracts with the real `ProtocolBasicStore`:

- Read requires `chart.read`; mutation requires `chart.write`.
- Initial selection creates `manual-visit-code:<encounterId>` with `planActionRef: "manual-visit-code"`, absent `protocolApplicationId`, units `1`, laterality `OU`, empty evidence and coverage arrays, state `accepted`, and clinician-entered provenance.
- Exactly one valid rank-1 local Condition reference becomes the initial `dxPointers`; no principal or malformed/multiple principals produces `[]` and never blocks.
- Changing the selected visit reuses the same id and preserves edited `dxPointers`.
- Clearing sets state `removed`; selecting again revives the same row as `accepted`.
- A finalized row is not rewritten.
- A conflicting stable id, a second manual visit candidate, or a visit-like row with incompatible ownership fails closed without touching any other procedure/protocol proposal.
- Inactive or non-visit concepts are rejected.
- Any number of unrelated charge proposals remains untouched.

Run the focused file and observe failure because the handlers and identity constants do not exist.

### 2.4 Implement the read/mutation handlers

In `protocol-endpoint.ts`:

- Export the stable id prefix, sentinel action ref, and visit-concept membership as needed by the tests/UI response.
- Add a GET handler returning active visit options plus the current stable manual proposal/selection.
- Add a mutation handler accepting `{ procedureConceptKey: string | null }`.
- Resolve the active visit set from the shipped visit seeds and stored fee definitions; a retired definition is inactive, while an unmaterialized shipped seed defaults active.
- Use `liveService(...).charges` so storage remains the existing FHIR Basic `odos-charge-proposal` model.
- Read the encounter only for initial principal diagnosis defaulting.
- Preserve `dxPointers` after creation and never write a `ChargeItem` from the handler.
- Return `409` for stable-identity/finalization conflicts and `400` for invalid selections.

In `index.ts`, register:

- `GET /clinical-graph/protocols/encounters/:encounterId/visit-charge` with `chart.read`.
- `POST /clinical-graph/protocols/encounters/:encounterId/visit-charge` with `chart.write`.

### 2.5 Run focused green and untouched protocol regression

```bash
cd mcp && node --import tsx --test src/__tests__/visit-billing-codes.test.ts
cd mcp && node --import tsx --test src/__tests__/protocol-phase5.test.ts
```

Expected: both files pass; the existing Phase 5 file remains byte-identical.

### 2.6 Commit

```bash
git add mcp/src/__tests__/visit-billing-codes.test.ts mcp/src/clinical-graph/protocol-types.ts mcp/src/clinical-graph/procedure-fee-schedule.ts mcp/src/clinical-graph/protocol-endpoint.ts mcp/src/index.ts
git commit -m "feat: stage manual visit charges"
```

---

## Task 3: Prove sign materialization, diagnosis linkage, and positional claim coding

**Files:**

- Modify: `mcp/src/__tests__/visit-billing-codes.test.ts`

### 3.1 Write the end-to-end acceptance test

Using one in-memory FHIR graph and the real handlers/stores:

1. Persist an in-progress encounter with one rank-1 Condition reference.
2. Select `routine-vision-exam-new` through the manual visit mutation handler.
3. Assert the stored Basic row parses to an accepted manual proposal with absent `protocolApplicationId`.
4. Invoke `handleProtocolSignCleanupRequest()`.
5. Inspect the resulting `ChargeItem` and assert:
   - first coding is HCPCS `S0620` with the HCPCS system;
   - second coding is the ODOS visit concept;
   - `supportingInformation` carries the principal Condition reference;
   - proposal is finalized with `chargeItemRef`.

This test should fail before the prior tasks are complete, then pass without a second charge path.

### 3.2 Pin the private positional claim contract through the public consumer

Feed that materialized `ChargeItem` to `buildProfessionalClaim()` with literal claim inputs and one diagnosis position. Assert `Claim.item[0].productOrService.coding[0]` is the HCPCS system/code and is not the ODOS concept key. Do not export `firstCoding()` for the test.

Also materialize one intentionally uncoded concept and assert it remains concept-only and legal. Do not change claim assembly behavior for that row; the PR will record the residual defect.

### 3.3 Run focused green and commit

```bash
cd mcp && node --import tsx --test src/__tests__/visit-billing-codes.test.ts
git add mcp/src/__tests__/visit-billing-codes.test.ts
git commit -m "test: prove visit charge claim path"
```

---

## Task 4: Add billing-code settings and the passive selector UI

**Files:**

- Create: `ui/src/lib/visit-charge.ts`
- Create: `ui/src/components/charting/VisitCodeSelector.tsx`
- Create: `ui/tests/visitBillingCodes.test.tsx`
- Modify: `ui/src/lib/procedure-fee-schedule.ts`
- Modify: `ui/src/scenes/settings/FeeScheduleSettings.tsx`
- Modify: `ui/src/components/charting/EncounterHeader.tsx`

### 4.1 Write failing UI adapter/settings tests

Add literal behavior tests proving:

- Fee-schedule list/save round-trips `billingCode` and sends it in the save body.
- The catalog descriptor contains an optional text field labeled `Billing code` and remains `canCreate: false`.
- Facts/search text expose a configured billing code without inventing one for uncoded concepts.

Run:

```bash
cd ui && node --import tsx --test tests/visitBillingCodes.test.tsx
```

Expected: FAIL because UI types and the field are absent.

### 4.2 Implement the settings surface

- Add `billingCode?: string` to the UI item type.
- Send `billingCode: item.billingCode ?? null` on save.
- Add the optional `Billing code` text field to `feeScheduleDescriptor()`.
- Include configured billing codes in facts/search text while preserving existing price/active behavior.

Run the focused UI file green.

### 4.3 Write failing selector tests

Test the real selector component with a controlled fetch implementation:

- It loads blank when no accepted manual visit proposal exists.
- It shows the 12 active visit options and never shows `refraction`.
- S-code options display label plus billing code; uncoded options display only the approved label.
- Selecting sends one POST with the chosen concept.
- Clearing sends `{ procedureConceptKey: null }`.
- No modal, toast, sign gate, or dismissal interaction is introduced.
- Read/mutation failure is non-blocking and appears as local inline error text.

Observe the focused test fail before creating the component.

### 4.4 Implement and mount the selector

- Add a small typed adapter in `ui/src/lib/visit-charge.ts` using existing auth headers and clinical-graph base URL.
- Add `VisitCodeSelector` as a native passive select with blank `Visit billing code` default.
- Mount it in `EncounterHeader` below the encounter summary so both chart views share the same selector.
- Disable it for migrated encounters and while its own mutation is in flight; do not affect signing.
- On encounter-diagnosis events, do not rewrite the proposal or `dxPointers`; the server defaults only at first creation.

Run the focused UI test green.

### 4.5 Commit

```bash
git add ui/src/lib/visit-charge.ts ui/src/components/charting/VisitCodeSelector.tsx ui/tests/visitBillingCodes.test.tsx ui/src/lib/procedure-fee-schedule.ts ui/src/scenes/settings/FeeScheduleSettings.tsx ui/src/components/charting/EncounterHeader.tsx
git commit -m "feat: select encounter visit charges"
```

---

## Task 5: Add the lexical shipped-CPT guard and mutation proof

**Files:**

- Create: `scripts/shipped-cpt-guard.ts`
- Create: `tests/preflight/shipped-cpt-guard.test.ts`

### 5.1 Write the failing guard tests

Test the scanner as behavior, not source text:

- A controlled TypeScript seed containing a standalone five-digit procedure-shaped string produces one finding with file, line, and token.
- Four digits plus `F` or `T` is rejected.
- Numeric program literals, years, prices, ports, pixels, URL components, and hyphenated terminology codes are ignored.
- Exact existing non-procedure allowances are file-and-token scoped and do not allow the same token elsewhere.
- A real repository scan of `mcp/src`, `ui/src`, and `data` is clean while excluding test directories and existing `data/code-bindings/*.md` files.

Run the focused test and observe failure because the scanner does not exist.

### 5.2 Implement the lexical scanner

- Use the TypeScript scanner for strings, templates, JSX text, and comments so numeric program literals are structurally excluded.
- Scan textual data formats directly.
- Ignore matched spans inside URLs and hyphenated terminology identifiers.
- Keep a small named list of exact existing file/token allowances for non-procedure quantities or protocol/error identifiers.
- Exclude test directories and existing Markdown code-binding ledgers; do not edit those files.
- Format a hard failure as `Forbidden shipped CPT-shaped token <token> at <file>:<line>`.

Run the focused guard test green.

### 5.3 Perform and record the mutation proof

Temporarily add one prohibited standalone five-digit billing value to a shipped visit seed using `apply_patch`. Run the guard test and capture its exact red message. Remove the mutation with `apply_patch`, rerun, and capture the clean result. Confirm the mutation never enters a commit.

### 5.4 Commit

```bash
git add scripts/shipped-cpt-guard.ts tests/preflight/shipped-cpt-guard.test.ts
git commit -m "test: guard shipped CPT literals"
```

---

## Task 6: Full verification and rendered evidence

**Files:**

- Modify only if a verified defect is found in files already in scope.
- Create screenshot/evidence outside the repository or in the existing approved build-evidence location only if repository convention requires it.

### 6.1 Static and immutable-boundary checks

Run:

```bash
git diff --check main...HEAD
git diff --name-only main...HEAD -- mcp/tests 'data/code-bindings/*.md'
git grep -n -E '\b9[0-9]{4}\b' -- mcp/src ui/src data
```

Expected: no whitespace errors; no immutable files changed; no shipped numeric procedure code hit.

### 6.2 Focused correctness gates

```bash
cd mcp && node --import tsx --test src/__tests__/visit-billing-codes.test.ts
cd mcp && node --import tsx --test src/__tests__/protocol-phase5.test.ts
cd ui && node --import tsx --test tests/visitBillingCodes.test.tsx
node --import tsx --test tests/preflight/shipped-cpt-guard.test.ts
```

Record real totals and duration.

### 6.3 Full repository gates

```bash
npm run preflight
cd mcp && npm run build
cd mcp && npm test
cd ui && npm run build
cd ui && npm test
```

Record real totals, failures, skips, and duration. Treat any red suite as a defect until explained and corrected.

### 6.4 Rendered workflow proof

Using only the local synthetic application and without traversing an auth flow:

- Render the encounter header with the blank selector.
- Select an S-code visit and show the selected state.
- Show fee settings with both prefilled S-code billing values and an uncoded row.
- Preserve screenshots for the PR.

If the local app is not already reachable without auth interaction, use a deterministic component render/test harness and state that boundary plainly rather than touching login.

### 6.5 Inspect the actual end-to-end resources

From the focused acceptance test or local synthetic stack, capture the stored:

- `ChargeItemDefinition` with billing coding first.
- accepted manual `ChargeProposal` before sign.
- resulting `ChargeItem` after sign with both codings and the Condition pointer.

Use the resulting `ChargeItem` JSON in the PR body/evidence without any PHI.

---

## Task 7: Final branch audit, publication, and independent-evaluation handoff

### 7.1 Self-audit the exact diff

Review every changed file against the design and Amendment 7. Confirm:

- no direct ChargeItem route;
- no CPT procedure value;
- no change under `mcp/tests` or existing code-binding Markdown;
- 13 added concepts, exactly 2 prefilled billing codes;
- selector includes exactly the 12 visits, not refraction;
- manual proposal identity and diagnosis default semantics are preserved;
- populated protocol application linkage remains strict;
- positional billing coding is test-pinned;
- residual uncoded-claim behavior is unchanged.

### 7.2 Commit any verified final corrections

Use a narrow conventional commit. Re-run every affected focused test after a correction, then repeat the full gates if production code changed.

### 7.3 Push and open a ready PR to `main`

Use the `github:yeet` skill. The PR body must include:

- plain-language summary and scope fences;
- two CMS sources and access date;
- test commands with real counts;
- mutation-proof red and green output;
- screenshot/resource evidence, including the resulting `ChargeItem`;
- unchanged protocol Phase 5 proof;
- the known pre-existing defect: an uncoded concept can still reach positional claim assembly with the ODOS concept key as `productOrService`; this slice narrows but does not eliminate it, and a separate decision must choose block, warn, or omit;
- no coverage claim;
- explicit request for Fable/Opus independent exact-head evaluation.

### 7.4 Poll exact-head review state

At the PR head, report Greptile and PR-Agent checks plus unresolved thread count. Do not wait for or mention CodeRabbit. Adjudicate any already-present finding before handoff.

### 7.5 Final status

Report the sealed bundle: summary, files, commits, branch, exact checks/counts, Mandate 14 rows, evidence, risks/follow-ups, PR URL, bot status, and `NOT EVALUATED` until Fable/Opus completes the independent evaluation.
