> Historical bot guidance below is superseded by AGENTS.md: poll CodeRabbit and PR-Agent at the final head; do not trigger or wait for the former bot. Adjudicate all existing findings.

# Diagnosis Carry-Forward Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver paged previous-exam diagnoses, one-click atomic pull-forward, present/absent-safe finding behavior, and visible aging provenance.

**Architecture:** A dedicated server endpoint pages four prior Encounters at a time and returns exact recorded diagnosis/finding snapshots. A POST on the same resource performs one FHIR transaction for the new Condition, Encounter diagnosis link, present-finding Observations, and carry Provenance. A shared provenance helper enriches the existing findings read model so the workspace can distinguish carried, edited, and prior-absent offered state.

**Tech Stack:** TypeScript, FHIR R4 `Encounter`/`Condition`/`Observation`/`Provenance` transaction Bundles, Express, Zod, React, Node test runner, Vite.

## Global Constraints

- Branch `drbang-iva/dx-carry` from `b361a13`; PR target `main`; never merge.
- Previous-exam pages contain exactly four encounters; diagnoses and findings within each returned encounter are deliberately unbounded; encounter paging has no total cap.
- No clinical inference, terminology crosswalk, automatic pull, staging, bulk confirmation, or preselection.
- Diagnosis identity includes exact laterality and preserves rank gaps by appending at `max(rank) + 1`.
- Prior present findings become new current Observations; prior absent findings remain offered until explicitly reasserted.
- Diagnosis binding remains only `Condition.evidence.detail`; never write `Observation.focus`.
- Prior resources are immutable. Grade and laterality copy as values, not links.
- Do not touch claims, PM scenes, protocols/`ProtocolTrigger`, MDM, scheduler, backup/DR, section component internals, or by-structure behavior.
- GET and POST server methods each have separate 401 and 403 tests.
- No medical code, external FHIR artifact URL, regulatory citation, or dated source is introduced; no Mandate 14 ledger row is expected.

---

### Task 1: Exact identity, paging, and prior-exam read model

**Files:**
- Create: `mcp/src/clinical-graph/diagnosis-carry-forward-endpoint.ts`
- Create: `mcp/tests/diagnosisCarryForward.test.ts`
- Modify: `mcp/src/index.ts`

**Interfaces:**
- Produces: `PreviousExamDiagnosisIdentity`, `PreviousExamFinding`, `PreviousExamDiagnosis`, `PreviousExamGroup`, and `PreviousExamsPage`.
- Produces: `handlePreviousExamsReadRequest(deps, input)`.
- Registers: `GET /clinical-graph/encounters/:encounterId/previous-exams`.

- [ ] **Step 1: Write failing 401 and 403 route tests**

Register the real GET handler in the existing Express test harness and assert literal 401 without authentication and 403 for a role lacking `chart.read`. The production change caught is removal or misregistration of either server guard.

- [ ] **Step 2: Write failing page and identity tests**

Use complete in-memory Encounter, Condition, and Observation fixtures. Assert four encounters newest-first, an opaque next cursor, exact visit labels, every diagnosis in an encounter, refuted/entered-in-error exclusion, and all explicit evidence-linked boolean findings. Assert OD/OS versions of the same diagnosis have different identities and that identical OD rows across encounters match.

- [ ] **Step 3: Run the new test and verify RED**

Run: `node --import tsx --test tests/diagnosisCarryForward.test.ts`

Expected: missing-module or missing-export failure because the endpoint does not exist.

- [ ] **Step 4: Implement the minimal read endpoint**

Read the current Encounter and patient, search exactly four older Encounters per page, follow only validated FHIR `next` links, read every referenced Condition and evidence Observation, and return the literal record. Encode/decode the cursor without exposing or accepting a cross-origin URL. Do not add a total page limit.

- [ ] **Step 5: Register the GET route and run GREEN**

Run the new server test plus `diagnosisFindings.test.ts`, `diagnosisLinkL2.test.ts`, and `diagnosisQuickList.test.ts`.

- [ ] **Step 6: Commit**

Commit message: `feat: page previous exam diagnoses`

### Task 2: Atomic pull transaction

**Files:**
- Modify: `mcp/src/clinical-graph/diagnosis-carry-forward-endpoint.ts`
- Modify: `mcp/tests/diagnosisCarryForward.test.ts`
- Modify: `mcp/src/index.ts`

**Interfaces:**
- Produces: `handleDiagnosisPullRequest(deps, input)`.
- Registers: `POST /clinical-graph/encounters/:encounterId/previous-exams`.
- Returns: `{ conditionReference, alreadyPresent, transaction }`.

- [ ] **Step 1: Write failing POST authorization tests**

Assert 401 unauthenticated and 403 without `chart.write` through the registered route. Removing the write guard must make the 403 test fail.

- [ ] **Step 2: Write failing transaction-shape tests**

For a source Condition with one present and one absent atomic finding, assert one Condition POST, one Encounter PUT with exact `If-Match`, one Observation POST only for the present finding, and one Provenance POST. Assert Condition evidence points only to the new present Observation URN, Provenance source entities include both prior Observations, and no new Observation references the prior Observation.

- [ ] **Step 3: Write failing rank, idempotency, and identity tests**

Assert ranks `[1, 4]` append at `5`; repeated or raced pull returns the exact current Condition without executing a transaction; OD does not satisfy OS; and an uncataloged exact-coded diagnosis uses literal coding/text/laterality identity without mapping.

- [ ] **Step 4: Run focused tests and verify RED**

Run the new test file and confirm each behavior fails because POST is absent.

- [ ] **Step 5: Implement and execute the transaction**

Validate patient/source membership and retraction state. Build transaction resources with `urn:uuid:` full URLs, source values only, and `Prefer: return=representation`. Reject failed transaction entries and map FHIR precondition conflicts to 409.

- [ ] **Step 6: Run focused tests GREEN**

Run the carry-forward, diagnosis-pick, diagnosis-findings, transaction-atomicity, and diagnosis-link suites.

- [ ] **Step 7: Commit**

Commit message: `feat: pull diagnoses atomically`

### Task 3: Provenance chain and findings enrichment

**Files:**
- Create: `mcp/src/clinical-graph/diagnosis-carry-provenance.ts`
- Modify: `mcp/src/clinical-graph/diagnosis-carry-forward-endpoint.ts`
- Modify: `mcp/src/clinical-graph/diagnosis-findings-endpoint.ts`
- Modify: `mcp/tests/diagnosisCarryForward.test.ts`
- Modify: `mcp/tests/diagnosisFindings.test.ts`
- Modify: `ui/src/lib/diagnosis-findings.ts`
- Modify: `ui/src/lib/clinical-actions.ts`
- Modify: `ui/tests/diagnosisRankSafety.test.tsx`

**Interfaces:**
- Produces: `readDiagnosisCarryState(fhir, condition, observations)` returning pulled-from date, edited state, oldest unchanged date, source absent snapshots, and per-Observation carried flags.
- Extends: `DiagnosisFindingsPayload.carryProvenance` and `EncounterFindingRow.carried/priorPresence/priorGrade/priorLaterality`.

- [ ] **Step 1: Write failing chain-aging tests**

Build three linked carry Provenances and assert the newest unedited diagnosis reports the oldest encounter date. Add a later target Provenance to the middle Condition and assert the chain stops there. Add a later finding Provenance and assert the diagnosis becomes edited and only that finding loses `carried`.

- [ ] **Step 2: Write failing absent-offer tests**

Assert a prior absent source Observation enriches the current offered row with the literal prior grade/laterality and does not enter charted findings. Reasserting it through the existing finding mutation creates a fresh row without a carried tag.

- [ ] **Step 3: Run focused tests and verify RED**

Run `diagnosisCarryForward.test.ts`, `diagnosisFindings.test.ts`, and `diagnosisRankSafety.test.tsx`.

- [ ] **Step 4: Implement the actual-chain resolver**

Identify carry Provenance by `CREATE` plus `Diagnosis pull-forward`, follow direct source Condition references without a depth cap, detect cycles visibly, and compare later target Provenance timestamps. Merge source absent snapshots into offered rows by exact atomic code plus laterality.

- [ ] **Step 5: Make diagnosis problem-status edits target the Condition**

Extend the existing UI Provenance builder call for `update_encounter_diagnosis_problem_status` to include the affected Condition as a second target. Do not change MDM calculation or status semantics.

- [ ] **Step 6: Run focused tests GREEN**

Run all affected server/UI files and verify existing non-carry finding behavior is unchanged.

- [ ] **Step 7: Commit**

Commit message: `feat: age diagnosis carry provenance`

### Task 4: Previous exams rail and visible carry state

**Files:**
- Create: `ui/src/components/charting/PreviousExams.tsx`
- Create: `ui/src/lib/diagnosis-carry-forward.ts`
- Modify: `ui/src/components/charting/DiagnosisWorkspace.tsx`
- Modify: `ui/src/components/charting/DiagnosisFindingsTable.tsx`
- Modify: `ui/src/styles/charting.css`
- Modify: `ui/tests/diagnosisWorkspace.test.tsx`
- Create: `ui/tests/diagnosisCarryForward.test.tsx`

**Interfaces:**
- Consumes: GET/POST `/clinical-graph/encounters/:encounterId/previous-exams`.
- Produces: `PreviousExams` with append-only paging, automatic sentinel load, checked selection, and explicit pull.
- Produces: `appendPreviousExamsPage()` and `previousDiagnosisRowLabel()` pure helpers.

- [ ] **Step 1: Write failing paging and empty-state UI tests**

Assert automatic initial load, four-encounter first page, exact append order, retained earlier pages on a later error, continued next-cursor use, and plain `No previous exams recorded.` state.

- [ ] **Step 2: Write failing checked/pull tests**

Render two encounters and two prior diagnoses. Assert checked rows select without POST; unchecked rows send exactly one source Condition reference; the returned current Condition is selected; two diagnoses from different encounters can both become checked; and a repeated click does not duplicate.

- [ ] **Step 3: Write failing provenance render tests**

Assert `pulled from <date> · unedited`, `· edited`, `unchanged since <date>`, carried finding tags, and prior-absent offered text. Ensure a fresh finding never receives the carried tag.

- [ ] **Step 4: Run focused UI tests and verify RED**

Run the two workspace/carry test files and confirm missing component and text failures.

- [ ] **Step 5: Implement the client, rail, and header**

Insert Previous exams between This visit and Common. Use the accessible sentinel button plus `IntersectionObserver` auto-load. Keep all labels clinical and all appearance states on existing tokens.

- [ ] **Step 6: Enrich the findings table**

Render carried only for unchanged present copies. Render prior absent grade/laterality on the offered row without setting presence or creating an Observation.

- [ ] **Step 7: Run focused UI tests GREEN**

Run diagnosis workspace, carry-forward, grouping, routing, appearance debt, and rank-safety tests.

- [ ] **Step 8: Commit**

Commit message: `feat: render previous exam pulls`

### Task 5: Mutation proof, rendered evidence, and publication

**Files:**
- Create: screenshots under `docs/build-log/2026-08-10-dx-carry/`
- Modify only source/test files required by observed failures.

**Interfaces:**
- Produces: `previous-exams.png`, `carried-diagnosis.png`, and `new-patient-empty.png` using synthetic local data only.

- [ ] **Step 1: Perform red-then-green mutation proof**

Temporarily remove the Encounter transaction entry and run the named atomicity test; restore it. Temporarily chart prior absence and run the named absent-offer test; restore it. Temporarily omit laterality from identity and run the named OD/OS test; restore it. Record exact failing names and output.

- [ ] **Step 2: Install and run every requested gate**

Run `npm install` in root, `mcp`, and `ui`; `npx tsc --noEmit` in each; full MCP and UI suites; `npm run preflight`; and the UI production build. Preserve real totals, failures, skips, and exit codes.

- [ ] **Step 3: Capture three rendered proofs**

Use a local synthetic fixture or local synthetic stack only. Show two prior encounters, one pulled diagnosis with carried findings/provenance, and a new-patient empty state. Do not traverse an auth flow or expose `.env` values.

- [ ] **Step 4: Audit scope and source obligations**

Run `git diff --check`; inspect every changed path against the must-not-touch list; confirm `Observation.focus` is never written; confirm no new medical code or canonical artifact URL; leave `decisions/INDEX.md` and Mandate 14 ledgers unchanged and state why.

- [ ] **Step 5: Commit, push, and open the PR**

Stage only the slice files, commit the evidence/final fixes, push `drbang-iva/dx-carry`, and open a draft PR against `main` without merging.

- [ ] **Step 6: Adjudicate exact-head review signals**

Reply to every existing Greptile or PR-Agent thread. Re-poll both at the final head; an in-progress or missing signal is pending/absent, never clean.

- [ ] **Step 7: Run the exact-head evaluator gate**

Run `scripts/eval-worktree.sh <PR#>` at the final pushed SHA and paste its real summary in the sealed bundle.

- [ ] **Step 8: Return the sealed bundle**

Report summary, changed files, carry/no-carry rationale, transaction shape, real commands/counts, mutation failures, screenshots, commit/branch/PR, risks/follow-ups, decision/ledger status, and `needs-review`. State that Codex authored the slice and independent Fable/Opus evaluation remains required before merge.
