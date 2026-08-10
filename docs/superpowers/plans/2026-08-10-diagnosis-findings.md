# Diagnosis Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver diagnosis-scoped offered/charted findings, explicit present/absent persistence, Condition-evidence diagnosis binding, unassigned findings, and a shared by-structure projection.

**Architecture:** A dedicated encounter-findings service projects configured atomic finding candidates and recorded Observations into one read model. Diagnosis-workspace assertions are atomic Observations; diagnosis ownership is derived only from `Condition.evidence.detail`. Existing section Observations are normalized for cross-view display without changing section-component internals.

**Tech Stack:** TypeScript, FHIR R4 `Observation`/`Condition`/`Provenance`, Express, Zod, React, Node test runner, Vite.

## Global Constraints

- Branch `drbang-iva/dx-findings` from `9741426`; PR target `main`; never merge.
- `FindingInstance.presence` is required `present | absent` and independent of interpretation.
- Top-level `Observation.valueBoolean` means presence exclusively; boolean clinical values use a component.
- Diagnosis binding lives only in `Condition.evidence.detail`; never use `Observation.focus` or another reverse edge.
- Offered/absent values are never preselected or inferred; grade never defaults.
- Never propose or create a diagnosis from a finding.
- Do not modify the internals of the 39 section components or touch claims, PM scenes, protocols, MDM, scheduler, backup/DR, or slice-3 carry-forward.
- Every registered GET and mutation route has separate 401 and 403 tests.

---

### Task 1: Presence-safe finding projection

**Files:**
- Modify: `mcp/src/clinical-graph/glaucoma-suspect.ts`
- Modify: `mcp/tests/glaucoma-suspect-clinical-graph.test.ts`
- Modify fixtures typed as `FindingInstance` in `mcp/tests/diagnosisLinkL1.test.ts`, `mcp/tests/diagnosisLinkL2.test.ts`, and `mcp/tests/refractionEndpoint.test.ts`

**Interfaces:**
- Produces: `FindingPresence = "present" | "absent"`; required `FindingInstance.presence`; `FindingValue` variant `{ type: "presence" }`.
- Produces: `projectFindingInstanceToObservation()` mapping `{ type: "presence" }` to top-level `valueBoolean`, and mapping `{ type: "boolean" }` to a `CLINICAL_VALUE` boolean component.

- [ ] **Step 1: Write failing projection tests**

Add literal assertions proving present/absent map to `true`/`false`, present-and-normal keeps interpretation independent, and boolean clinical value produces a component with no top-level `valueBoolean`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test tests/glaucoma-suspect-clinical-graph.test.ts`

Expected: type/runtime failures because presence and the presence-only value shape do not exist.

- [ ] **Step 3: Implement the minimal model and projection**

Add required presence, add the presence-only value variant, pass explicit `presence: "present"` at both production capture builders, project presence-only values to top-level boolean, and project boolean clinical values into a named component. Keep quantity/string/json/component behavior unchanged.

- [ ] **Step 4: Update typed fixtures explicitly**

Every existing `FindingInstance` fixture states `presence: "present"`; do not add a builder default.

- [ ] **Step 5: Run focused and affected tests GREEN**

Run the clinical-graph, diagnosis-link L1/L2, and refraction endpoint test files directly.

- [ ] **Step 6: Commit**

Commit message: `feat: separate finding presence from value`

### Task 2: Encounter findings read model and FHIR mutations

**Files:**
- Create: `mcp/src/clinical-graph/diagnosis-findings-endpoint.ts`
- Create: `mcp/tests/diagnosisFindings.test.ts`
- Modify: `mcp/src/index.ts`
- Reuse: `mcp/src/clinical-graph/custom-fields.ts`, `mcp/src/clinical-graph/finding-definition-store.ts`, `mcp/src/clinical-graph/diagnosis-catalog-store.ts`

**Interfaces:**
- Produces: `AtomicFindingCatalogRow`, `EncounterFindingRow`, `DiagnosisFindingsPayload`.
- Produces: `handleDiagnosisFindingsReadRequest(deps, input)` and `handleDiagnosisFindingsMutationRequest(deps, input)`.
- Registers: `GET` and `PUT /clinical-graph/encounters/:encounterId/findings`.
- Mutation actions: `assert`, `clear`, `grade`, `laterality`, `assign`, `standalone`.

- [ ] **Step 1: Write failing authorization route tests**

Register the real handlers in a local Express harness. Assert GET 401 unauthenticated, GET 403 without `chart.read`, PUT 401 unauthenticated, and PUT 403 without `chart.write`.

- [ ] **Step 2: Write failing read-model tests**

Use complete in-memory FHIR fixtures to prove candidate expansion, materialized `applicableFindingDefinitionIds`, controlled grade extraction, latest section snapshot normalization, unique visit-diagnosis grouping, and ambiguous/unmatched unassigned behavior.

- [ ] **Step 3: Write failing mutation tests**

Assert present/absent Observation persistence, no grade default, laterality inheritance/override, idempotent update instead of duplicate create, clear-to-`entered-in-error`, grade-scale validation, and exact encounter/patient/Condition boundaries.

- [ ] **Step 4: Write failing binding tests**

Assert assignment appends `Observation/<id>` once to the selected visit Condition, reassignment removes it from the old visit Condition, standalone removes it from all visit diagnosis Conditions, and no Observation reverse edge is written.

- [ ] **Step 5: Run the new test file and verify RED**

Run: `node --import tsx --test tests/diagnosisFindings.test.ts`

Expected: module-not-found or missing-export failures before the endpoint exists.

- [ ] **Step 6: Implement catalog/read-model helpers**

Expand exact option rows from active finding definitions and existing diagnosis mappings. Return definition ID, definition stable key, option code, display, controlled section key, grade scale, diagnosis keys, and custom/shipped origin. Deduplicate by atomic identity and laterality and sort charted before offered.

- [ ] **Step 7: Implement FHIR read and mutation handlers**

Read the encounter, its visit Conditions, finding definitions, diagnosis catalog, and encounter Observations. Persist atomic assertions with the presence-only projector and Provenance. Update the same atomic Observation for repeated assertions. Bind solely by idempotently updating Condition evidence.

- [ ] **Step 8: Register GET and PUT routes**

Use the existing `authenticateStaffRouteForAction("chart.read")` and `authenticateStaffRouteForAction("chart.write")` patterns and return handler status/body unchanged.

- [ ] **Step 9: Run the new tests GREEN and affected server tests**

Run the new test plus diagnosis-pick, custom-section, diagnosis-link L1/L2/L3, and referral-service tests.

- [ ] **Step 10: Perform binding and presence mutation proof**

Temporarily remove the `valueBoolean: false` branch and verify the absent round-trip test fails. Restore it. Temporarily remove the Condition evidence append and verify the binding test fails. Restore it. Record exact failing test names/output for the sealed bundle.

- [ ] **Step 11: Commit**

Commit message: `feat: add diagnosis findings service`

### Task 3: Diagnosis findings table and unassigned rail

**Files:**
- Create: `ui/src/components/charting/DiagnosisFindingsTable.tsx`
- Create: `ui/src/lib/diagnosis-findings.ts`
- Modify: `ui/src/components/charting/DiagnosisWorkspace.tsx`
- Modify: `ui/src/styles/charting.css`
- Modify: `ui/tests/diagnosisWorkspace.test.tsx`

**Interfaces:**
- Consumes: `GET/PUT /clinical-graph/encounters/:encounterId/findings` payload/actions.
- Produces: `DiagnosisFindingsTable` with charted/offered rows and explicit presence/grade/laterality controls.
- Produces: `orderedFindingSearchRows()` and pure row-state helpers for mutation-proof UI tests.

- [ ] **Step 1: Write failing pure and rendered UI tests**

Assert charted-first sorting, candidate-first search, present/absent signs, explicit unanswered grade option, muted inherited versus solid overridden laterality, and re-click dispatching clear rather than a second assertion.

- [ ] **Step 2: Write failing unassigned-tray tests**

Render unmatched rows, assignment choices from current visit diagnoses, and standalone action. Assert the tray is absent when empty and never contains a diagnosis-creation affordance.

- [ ] **Step 3: Run focused UI tests and verify RED**

Run: `node --import tsx --test tests/diagnosisWorkspace.test.tsx`

Expected: missing component/helper assertions fail.

- [ ] **Step 4: Implement the typed client and table**

Fetch on selected diagnosis change, send explicit mutation actions, refresh after success, and emit an encounter-findings-changed event. Offered rows have separate present and absent actions. Grade begins at an empty option.

- [ ] **Step 5: Replace only the slice-1 placeholder and populate Unassigned**

Keep the existing header, laterality, problem status, quick list, and imaging. Insert the table at the placeholder and the tray beneath Find dx.

- [ ] **Step 6: Apply the existing appearance system**

Use existing charting tokens/classes, clinical nouns in every label, keyboard-reachable controls, and responsive table layout.

- [ ] **Step 7: Run focused UI tests GREEN**

Run the diagnosis workspace test and appearance debt tests.

- [ ] **Step 8: Commit**

Commit message: `feat: render diagnosis finding rows`

### Task 4: Shared by-structure overlay

**Files:**
- Create: `ui/src/components/charting/EncounterFindingOverlay.tsx`
- Modify: `ui/src/scenes/EncounterCharting.tsx`
- Modify: `ui/src/styles/charting.css`
- Create: `ui/tests/diagnosisFindingGrouping.test.tsx`

**Interfaces:**
- Consumes: encounter findings payload `bySection` projection.
- Produces: `EncounterFindingOverlay` filtered by the active controlled section key.

- [ ] **Step 1: Write failing grouping and render tests**

Assert an atomic diagnosis finding appears only under its section, renders its sign/grade/laterality, and refreshes after the diagnosis-side change event. Assert no section component props or internals are changed.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test tests/diagnosisFindingGrouping.test.tsx`

- [ ] **Step 3: Implement the overlay**

Load the shared endpoint only in structure view, filter by the active section key, and render the overlay above the existing section component. Do not make the overlay a second write surface.

- [ ] **Step 4: Prove both grouping directions**

Add endpoint/UI integration fixtures showing diagnosis-origin atomic Observation in structure grouping and structure-origin section Observation under a unique visit diagnosis or Unassigned.

- [ ] **Step 5: Run focused tests GREEN**

Run both new UI test files and the existing encounter charting/ocular-health/custom-section tests.

- [ ] **Step 6: Commit**

Commit message: `feat: group findings by exam section`

### Task 5: Rendered clinical proof and final gates

**Files:**
- Create screenshots under `docs/build-log/2026-08-10-dx-findings/`
- Modify only test/evidence files required by actual failures.

**Interfaces:**
- Produces: three rendered screenshots named `findings-table.png`, `unassigned-findings.png`, and `by-structure-finding.png`.

- [ ] **Step 1: Run all requested static and suite gates**

Run `npm install` in root, `mcp`, and `ui`; `npx tsc --noEmit` in each; full MCP and UI suites; `npm run preflight`; and `npm run build` in `ui`. Capture real counts and exit codes.

- [ ] **Step 2: Run a local synthetic clinical traversal**

Use only the local synthetic stack. Capture the table with charted/offered/absent, populated unassigned tray, and by-structure overlay. If local auth or stack state prevents traversal, record the blocker and use clearly labeled synthetic renders.

- [ ] **Step 3: Review scope and diff**

Run `git diff --check`, inspect changed paths against the must-not-touch list, confirm no codes/artifact URLs were added, and inspect every new route for 401/403 coverage.

- [ ] **Step 4: Commit evidence and final fixes**

Commit message: `test: prove diagnosis findings workflow`

- [ ] **Step 5: Push and open the PR**

Push `drbang-iva/dx-findings`, open a draft PR targeting `main`, and include the FHIR presence/binding rationale and mutation proof.

- [ ] **Step 6: Run exact-head evaluation gate**

Run `scripts/eval-worktree.sh <PR#>` at the final PR head and record its summary. Re-poll PR-Agent and Greptile at the exact final head; adjudicate every finding already present. Report quiet bots as absent, not clean.

- [ ] **Step 7: Return the sealed bundle**

Report summary, files, commits, branch/PR, FHIR representation, checks with counts, mutation red/green evidence, screenshots, risks/follow-ups, cross-repo decision follow-up, and `needs-review` status. State that Codex authored the slice and independent Fable/Opus evaluation is still required before merge.
