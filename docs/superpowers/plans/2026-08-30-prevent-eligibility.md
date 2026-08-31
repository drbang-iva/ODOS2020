# Prevent Eligibility Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run tomorrow's appointments through an asynchronous Stedi batch eligibility sweep and turn only actionable coverage, primacy, and member-data problems into W21-W23 watcher Tasks on the existing Work and front-desk surfaces.

**Architecture:** A new scheduled eligibility worker owns a small FHIR-persisted state machine: submit a batch once, poll status on later ticks, ingest completed results, run eligibility-derived COB only for explicitly supported payers, and poll Insurance Discovery proposals without changing Coverage. The existing 2A watcher registry and engine read normalized sweep evidence and conditionally create Tasks. A health-gated Work projection groups those Tasks into a new Before the visit lane, while the scheduler renders every Task linked to an appointment instead of overwriting all but one.

**Tech Stack:** TypeScript, Express, FHIR R4, Stedi JSON APIs, React 18, Vite, Node test runner, react-test-renderer.

**Spec:** `/Users/ericr.bang/GitHub/performance-od/decisions/2026-08-30-odos-financial-claims-reporting-design.md` sections 19.1-19.2 plus the operator's approved 2026-08-30 rulings in this task.

## Global Constraints

- Work from `origin/main` commit `50194f9a` on `drbang-iva/prevent-slice-3`; PR targets `main` and is never self-merged.
- Test mode uses deterministic mocked Stedi responses. Production proof is a named pre-merge gate and is not run until the operator changes `STEDI_MODE`.
- `unknown` is the default COB applicability. `unknown`, unsupported, traditional Medicare, and capitation all project as `could-not-check`; only explicit `supported` can yield a real result or all-clear.
- Batch eligibility is asynchronous: submit once, persist the batch ID, and poll or ingest on later worker ticks. Never keep a process open waiting on Stedi.
- ACTIVE is silent. INACTIVE, INVESTIGATE, FAILED, a coverage end before the appointment, a supported COB primacy mismatch, or AAA 71/72/74/75 become work.
- The eligibility values returned by the payer are the only source for a COB request. Chart values must not be substituted.
- Insurance Discovery can produce a proposed member ID. It never updates Coverage or patient demographics.
- Eligibility payloads and patient/member data never enter logs. Worker logging is limited to aggregate outcome and opaque job identifiers.
- A failed, stale, or never-run sweep suppresses reassuring counts and clean zero states.
- Reuse watcher registration, grammar, severity, typed dismissal, day-one suppression, health, and conditional-create behavior. Do not modify the 2A watcher engine internals.
- No medical terminology or regulatory citation changes are introduced. The vendor contract evidence is recorded from current Stedi primary documentation.

---

### Task 1: Stedi preventive API contracts

**Files:**
- Modify: `mcp/src/claims/stedi-adapter.ts`
- Modify: `mcp/tests/stediAdapter.test.ts`

**Interfaces:**
- Extend `StediAdapter` without reshaping `ClearinghouseAdapter`.
- Add batch submit, batch item status, completed-result polling, COB, Insurance Discovery submit, and Insurance Discovery result methods.
- Keep the Manager API and Healthcare API base URLs independently configurable.

- [ ] Write endpoint, body, authorization, idempotency-header, and non-JSON/error tests first.
- [ ] Run the focused adapter test and record RED because the new methods do not exist.
- [ ] Implement the smallest typed adapter extension that passes those tests.
- [ ] Assert production-only methods refuse test-mode network calls unless a test double explicitly supplies mocked contracts.
- [ ] Run the focused test GREEN.

---

### Task 2: Explicit payer COB applicability

**Files:**
- Create: `mcp/src/insurance/cob-applicability.ts`
- Modify: `ui/src/lib/patient-insurance.ts`
- Modify: `ui/src/scenes/insurance/PatientInsurance.tsx`
- Modify: `ui/tests/patientInsurance.test.tsx`
- Create: `mcp/tests/cobApplicability.test.ts`

**Interfaces:**
- Persist a Coverage extension with `unknown | supported | unsupported | traditional-medicare | capitated`.
- Treat a missing or malformed extension as `unknown`.
- Present the field as required practice-maintained payer metadata while retaining fail-safe defaulting for existing Coverage resources.

- [ ] Write failing parser/builder round-trip tests, including absent = `unknown`.
- [ ] Write a failing editor test proving a newly created payer defaults to Unknown and can be classified explicitly.
- [ ] Implement the Coverage extension helpers and editor field.
- [ ] Run focused MCP and UI tests GREEN.

---

### Task 3: Asynchronous overnight sweep and normalized evidence

**Files:**
- Create: `mcp/src/jobs/eligibilitySweep.ts`
- Create: `mcp/tests/eligibilitySweep.test.ts`
- Modify: `mcp/src/index.ts`

**Interfaces:**
- Query tomorrow's active appointments and their patient/Coverage/payer inputs through FHIR read paths.
- Persist one sweep state per practice date, including opaque batch IDs, job health, last success, and normalized findings.
- Cap each Stedi request at 10,000 checks and use stable request keys derived from appointment/patient/date.
- On later ticks, poll status, ingest results, run COB from eligibility-returned identity values, and submit/poll Insurance Discovery only for targeted AAA errors.

- [ ] Write failing state-machine tests: first tick submits and persists, second pending tick does not resubmit, later complete tick ingests.
- [ ] Write a failing ACTIVE-silence test and W21/W23 normalization tests for status, plan end, and AAA 71/72/74/75.
- [ ] Write a failing COB-source test showing chart values are ignored in favor of eligibility-returned identity values.
- [ ] Write a failing applicability test: unknown/unsupported/traditional Medicare/capitation = `could-not-check`; explicit supported may report primacy/all-clear.
- [ ] Write the no-auto-apply test: a payer member ID creates a proposal and produces no Coverage write.
- [ ] Implement the persisted nonblocking state machine and startup worker wiring.
- [ ] Run the focused sweep tests GREEN.

---

### Task 4: W21-W23 through the existing watcher engine

**Files:**
- Create: `mcp/src/watchers/prevent-watchers.ts`
- Modify: `mcp/src/watchers/watcher-types.ts`
- Modify: `mcp/src/watchers/watcher-task.ts`
- Modify: `mcp/src/watchers/watcher-registry.ts`
- Modify: `mcp/src/watchers/watcher-projections.ts`
- Modify: `mcp/src/watchers/watcher-routes.ts`
- Modify: `mcp/src/index.ts`
- Create: `mcp/tests/preventWatchers.test.ts`
- Modify: `mcp/tests/watcherRegistry.test.ts`
- Modify: `mcp/tests/watcherRoutes.test.ts`

**Interfaces:**
- W21: today/front desk; eligibility problem or pre-visit coverage end.
- W22: this-week/biller; supported COB primacy mismatch or explicit `could-not-check` work item.
- W23: this-week/front desk; targeted AAA mismatch, optionally with an Insurance Discovery proposal.
- Add `/watchers/work` as a health-gated Task projection grouped by W21/W22/W23 reason; preserve one Task/two renderings.

- [ ] Write failing registry tests for all five grammar elements and approved severities/owners/dismissals.
- [ ] Write failing Task idempotency tests for repeated sweep evaluation.
- [ ] Write failing Work-projection tests for grouping, proposal content, and degraded/never-run state.
- [ ] Extend generic watcher Task input only as needed for reason/proposal metadata; preserve W1 compatibility.
- [ ] Register W21-W23 and expose the Work projection without weakening the registry or engine.
- [ ] Run focused watcher tests GREEN.

---

### Task 5: Before the visit lane and multi-alert front desk

**Files:**
- Modify: `ui/src/lib/watchers.ts`
- Modify: `ui/src/scenes/claims/BillingWork.tsx`
- Modify: `ui/src/scenes/frontdesk/FrontDeskCockpit.tsx`
- Modify: `ui/src/scenes/SchedulerDayGrid.tsx`
- Modify: `ui/src/scenes/scheduler/ResourceDayColumn.tsx`
- Modify: `ui/src/scenes/scheduler/PatientQuickCard.tsx`
- Modify: `ui/tests/billingWork.test.tsx`
- Modify: `ui/tests/watcherFrontdesk.test.tsx`

**Interfaces:**
- Add a grouped Before the visit lane to Work using the same lane/group vocabulary as the existing seven lanes.
- Show W21 on its appointment block and quick card.
- Store `WatcherAlert[]` per appointment and render all linked alerts deterministically.

- [ ] Write failing Work tests for healthy grouped W21-W23 and degraded/unrun states with no clean counts.
- [ ] Write failing scheduler and quick-card tests with W1 and W21 on the same appointment.
- [ ] Change the watcher client and scheduler props to arrays, preserving single-alert rendering.
- [ ] Integrate the lane and row without creating a new route/surface.
- [ ] Run focused UI tests GREEN.

---

### Task 6: Mandate 17 mutations, full gates, UI proof, and PR

**Evidence:**
- Demonstration 1: remove a W21 grammar element; registry test RED; restore GREEN.
- Demonstration 2: render failed/unrun sweep as clean; UI/projection test RED; restore degraded GREEN.
- Demonstration 3: treat unknown/Medicare/capitation as clean; applicability test RED; restore `could-not-check` GREEN.
- Demonstration 4: remove conditional-create/stable-key behavior; two-run idempotency test RED; restore one finding GREEN.
- Demonstration 5: write the discovered member ID into Coverage; no-auto-apply test RED; restore proposal-only GREEN.
- Demonstration 6: collapse appointment alerts to a single Task; same-appointment test RED with one alert missing; restore both GREEN.

- [ ] Run and record all six broken and restored focused commands with exact pass/fail counts.
- [ ] Run `mcp` build and full tests, recording runner counts and any `ODOS_POSTGRES_URL`/local-stack skip as an environmental gate rather than a pass.
- [ ] Run `ui` build and full tests with exact counts.
- [ ] Run root `npm run preflight` with exact output counts.
- [x] Capture UI evidence for healthy Before the visit, W21 appointment row, and degraded/unrun sweep.
- [ ] Commit on `drbang-iva/prevent-slice-3`; after the live gate, push and open a non-draft PR targeting `main`.
- [ ] Stop at the named production Stedi live-proof gate. The operator changes `STEDI_MODE`; then run exactly one real submit/status/result-ingest pass and report actual shapes.
- [ ] After the final proof/fix head, adjudicate every existing bot finding and re-poll both `gh pr checks` and unresolved review threads before reporting `needs-review`.
