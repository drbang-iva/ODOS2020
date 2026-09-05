# History ROS Bulk Denial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one resumable ROS gesture that records negative answers only for unanswered items, with bounded write units, a durable progress ledger, and a final immutable bulk review act.

**Architecture:** The existing item-review HTTP endpoint routes `method: "bulk"` into a server-owned orchestration path. That path validates ROS targets, creates or resumes a gesture-keyed Basic ledger, writes conditional-create answer transactions sized from the existing bundle-entry constant, confirms persisted negative answers, writes the bulk review act last, and completes the ledger last. The existing history-items read supplies incomplete ledger state to the UI so the same gesture can resume after a partial failure.

**Tech Stack:** TypeScript, Express, FHIR R4 Basic/Observation/Provenance/transaction Bundles, Zod, React, Node test runner, Playwright.

**Spec:** `/Users/ericr.bang/GitHub/performance-od/decisions/2026-09-05-odos-history-1d6-bulk-denial-codex-kickoff.md`

## Global Constraints

- Branch from `origin/main` after squash merge `1ab029d8`.
- Bulk denial records negative answers only for unanswered ROS items; it does not add a review-only bulk gesture.
- Conditional bundles remain limited to 8 total entries; answer chunk size is derived as the entry limit minus one Provenance entry.
- The Basic ledger is created first, updated after every confirmed unit, and completed after the immutable bulk act is written.
- The final act targets confirmed persisted negative answers, never merely intended targets.
- Existing answers are protected with FHIR conditional-create semantics.
- `gestureId` retries are immutable and idempotent.
- The transient progress display disappears after success.
- The `{method}` summary token remains unregistered.

---

### Task 1: Server contract and ledger lifecycle

**Files:**
- Modify: `mcp/src/clinical-graph/hpi-endpoint.ts`
- Modify: `mcp/tests/historyRosHttp.test.ts`
- Modify: `mcp/tests/helpers/historyRosFixture.ts`

**Interfaces:**
- Consumes: `itemHistoryReviewRequestSchema`, `historyReviewTargetKey`, `buildHistoryAnswerObservation`, `recordHistoryItemReview`, and the existing FHIR client.
- Produces: bulk responses shaped as `{ sectionKey, gestureId, status, recorded, total, persistedTargets, attestationReference? }` and incomplete ledgers returned by the existing item-acts read.

- [ ] **Step 1: Write failing HTTP tests**

Add cases proving a valid bulk request returns 200, a missing gesture ID returns 400, unknown or duplicate targets return 400 without writes, and a retry with changed targets returns 409.

- [ ] **Step 2: Run the HTTP test and verify RED**

Run: `cd mcp && node --import tsx --test tests/historyRosHttp.test.ts`

Expected: the valid bulk request still returns 400 because the endpoint is individual-only.

- [ ] **Step 3: Add the Basic ledger and bulk dispatcher**

Use a new code system and identifier system. Store patient, encounter, section, intended targets, persisted targets, gesture status, and actor in the Basic resource. Search by gesture identifier before create; reject immutable-field changes; return the completed result without new writes.

- [ ] **Step 4: Add derived, bounded conditional answer units**

Export the existing conditional bundle entry limit, calculate `answersPerUnit = limit - 1`, construct each answer as an encounter-scoped negative tri-state answer, submit it with `POST Observation` plus `ifNoneExist`, add one Provenance POST, and run the unchanged bundle-size refusal before submission.

- [ ] **Step 5: Confirm persistence and finish in order**

After every unit, re-read each answer identifier. Add only live negative answers to `persistedTargets`, update the ledger, and return resumable progress on failure. After all units, call `recordHistoryItemReview` with only confirmed negative targets, then mark the ledger complete.

- [ ] **Step 6: Run focused MCP tests and verify GREEN**

Run: `cd mcp && node --import tsx --test tests/historyRosHttp.test.ts tests/historyItemReview.test.ts tests/historyRos.test.ts`

Expected: all focused tests pass and the unchanged gesture-immutability and summary-parity guards remain green.

### Task 2: Persistence race, partial failure, and retry proofs

**Files:**
- Modify: `mcp/tests/historyRosHttp.test.ts`
- Modify: `mcp/tests/helpers/historyRosFixture.ts`

**Interfaces:**
- Consumes: the bulk response and incomplete-ledger read from Task 1.
- Produces: independently asserted B1-B5 coverage.

- [ ] **Step 1: Add failing tests for the five persistence obligations**

Prove the unit uses at most the shared entry limit, a failed later unit leaves a readable incomplete ledger, the act is absent on partial failure, the act targets only confirmed negatives, a concurrent positive answer survives conditional create, and a completed `gestureId` retry adds no resources or transactions.

- [ ] **Step 2: Run the new cases and verify RED**

Run: `cd mcp && node --import tsx --test tests/historyRosHttp.test.ts`

Expected: each new assertion fails before its corresponding production behavior exists.

- [ ] **Step 3: Complete only the missing behavior**

Adjust the orchestration and fake FHIR boundary until each persistence assertion observes the real request and stored resource behavior.

- [ ] **Step 4: Run the focused suite and verify GREEN**

Run: `cd mcp && node --import tsx --test tests/historyRosHttp.test.ts tests/historyItemReview.test.ts tests/historyRos.test.ts`

Expected: all tests pass with no changes to the named HOLD tests.

### Task 3: Resumable ROS UI

**Files:**
- Modify: `ui/src/components/charting/HistoryRosSection.tsx`
- Modify: `ui/src/components/charting/useHistoryItemReview.tsx`
- Modify: `ui/tests/historyRosBrowser.test.tsx`

**Interfaces:**
- Consumes: the server bulk response and incomplete ledger projection.
- Produces: `bulkDeny(targets)` and bulk progress state for the ROS section.

- [ ] **Step 1: Write failing browser tests**

Assert a keyboard-reachable `Mark unanswered No` button with a 44px target, disabled in flight; visible `N of M recorded` progress while pending or interrupted; a Resume action after partial failure using the same gesture ID; preservation of an existing Yes; and removal of progress after success.

- [ ] **Step 2: Run the browser test and verify RED**

Run: `cd ui && node --import tsx --test tests/historyRosBrowser.test.tsx`

Expected: the bulk button and progress display are absent.

- [ ] **Step 3: Implement the minimal UI gesture**

Filter unanswered options for convenience, retain the gesture body until completion, refresh answers and item acts after each response, merge returned persisted negative answers into UI state, and keep resumable state visible only for incomplete work.

- [ ] **Step 4: Run the browser test and verify GREEN**

Run: `cd ui && node --import tsx --test tests/historyRosBrowser.test.tsx`

Expected: all ROS browser scenarios pass, including transient-progress disappearance.

### Task 4: Mandate 17 mutation record

**Files:**
- Create: `docs/build-log/history-1d6/mutations.md`

**Interfaces:**
- Consumes: focused MCP and UI tests from Tasks 1-3.
- Produces: six RED/RESTORED records with commands, exit codes, and counts.

- [ ] **Step 1: Run and restore the six required mutations**

Mutate one guard at a time: oversize a unit; remove the ledger update; use intended act targets; replace conditional create; bypass completed-gesture idempotency; and add `{method}` to the ROS summary template.

- [ ] **Step 2: Record exact evidence**

For each mutation, record the failing test count and exit status, restore production, rerun the same command, and record the passing count and exit status. If a mutation stays green, record that enforcement gap plainly.

### Task 5: Full verification and PR

**Files:**
- Create: `docs/build-log/history-1d6/sealed-bundle.md`

**Interfaces:**
- Consumes: the final diff and mutation record.
- Produces: a non-draft PR targeting `main`.

- [ ] **Step 1: Run all three verification gates independently**

Run from the repository root: `npm run preflight`. Run from `mcp/`: `npx tsc --noEmit && npm test`. Run from `ui/`: `npx tsc --noEmit && npm run build && npm test`. Capture each command's own exit code and real counts.

- [ ] **Step 2: Inspect scope and unchanged guards**

Run `git diff --check`, verify the HOLD tests are byte-unchanged, verify the summary template has no method token, and inspect the committed file list.

- [ ] **Step 3: Write the sealed bundle**

Include the shipped behavior, files, real verification counts, all six mutation pairs, limitations, 1e follow-up, and independent-evaluation requirement.

- [ ] **Step 4: Commit, push, and open the PR non-draft**

Use the branch `drbang-iva/ros-bulk-denial`, target `main`, include the sealed evidence in the PR body, and stop without merging.
