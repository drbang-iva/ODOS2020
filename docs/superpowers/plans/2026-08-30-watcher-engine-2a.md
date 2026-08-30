# Watcher Engine 2A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reusable watcher engine, W1 appointment-balance alert, appointment-row and Today renderings, and six fail-closed mutation demonstrations.

**Architecture:** Runtime-validated watcher definitions execute through an authenticated scheduled engine. Practice settings and health persist as FHIR Basic singletons; each alert condition persists as one idempotent FHIR Task. Fresh server projections feed both renderers and return structured HTTP 503 degradation instead of stale Tasks.

**Tech Stack:** TypeScript, Node test runner, Express, FHIR R4 via the plain ODOS client, React 18, react-test-renderer, Vite.

**Spec:** `docs/superpowers/specs/2026-08-30-watcher-engine-2a-design.md`

## Global Constraints

- Do not touch `mcp/src/claims/**`, clearinghouse adapters, or clinical/exam code.
- Do not change authentication flows, credentials, AccessPolicies, or role declarations.
- `/desk` gets no UI or API change.
- W1 is one Task with two renderings; the cockpit rendering attaches to the Appointment row.
- Effective severity, cap, freshness, go-live, and thresholds come from persisted practice data.
- Any incomplete W1 source search fails the run; failed or stale health blocks all Task rendering.
- Every production behavior begins with a failing test that names the break it catches.

---

### Task 1: Registry grammar and practice-owned configuration

**Files:**
- Create: `mcp/src/watchers/watcher-types.ts`
- Create: `mcp/src/watchers/watcher-registry.ts`
- Create: `mcp/src/watchers/watcher-config.ts`
- Test: `mcp/tests/watcherRegistry.test.ts`

**Interfaces:**
- Produces: `WatcherDefinition`, `WatcherMatch`, `WatcherSeverity`, `createWatcherRegistry(definitions)`, `WATCHER_DEFINITIONS`, `loadOrSeedWatcherConfig(fhir, now)`.

- [ ] **Step 1: Write failing grammar and config tests**

```ts
assert.throws(
  () => createWatcherRegistry([{ ...validDefinition, owner: "" }]),
  /W1 registration failed: owner is required/,
);
assert.throws(
  () => createWatcherRegistry([{ ...validDefinition, nextAction: undefined }]),
  /W1 registration failed: next action is required/,
);
assert.deepEqual(parsed.watchers.W1, { enabled: true, severity: "today", minimumBalanceCents: 1 });
```

- [ ] **Step 2: Verify RED**

Run: `cd mcp && node --import tsx --test tests/watcherRegistry.test.ts`

Expected: module-not-found failure for `watcher-registry.js`.

- [ ] **Step 3: Implement the runtime grammar and Basic seed/parse seam**

Use one validator over `unknown`; collect missing-rule messages in registry order. Build the W1 definition with one action and three dismissal reasons. Serialize only validated config into the coded Basic singleton.

- [ ] **Step 4: Verify GREEN**

Run: `cd mcp && node --import tsx --test tests/watcherRegistry.test.ts`

- [ ] **Step 5: Commit**

```bash
git add mcp/src/watchers mcp/tests/watcherRegistry.test.ts
git commit -m "Enforce watcher registration grammar"
```

### Task 2: Complete FHIR pagination and W1 evaluation

**Files:**
- Create: `mcp/src/watchers/fhir-pagination.ts`
- Create: `mcp/src/watchers/w1-balance-watcher.ts`
- Test: `mcp/tests/w1Watcher.test.ts`

**Interfaces:**
- Consumes: `WatcherMatch`, persisted W1 settings.
- Produces: `collectAllPages(fhir, resourceType, params, label)`, `evaluateW1(input): Promise<WatcherMatch[]>`.

- [ ] **Step 1: Write failing W1 and completeness tests**

Use literal Appointment, Patient, and Invoice bundles. Assert one match contains `conditionKey: "W1:Appointment/appt-1"`, `balanceCents: 13200`, the patient reference, appointment reference, March age label, and owner/Today copy. Add a two-page Invoice fixture whose second page contains the only matching balance. Add a 101st-page fixture and a fake without `searchUrl`; both must reject with a message that says W1 data is incomplete.

- [ ] **Step 2: Verify RED**

Run: `cd mcp && node --import tsx --test tests/w1Watcher.test.ts`

- [ ] **Step 3: Implement bounded complete reads and the patient join**

```ts
const appointments = await collectAllPages(fhir, "Appointment", { date, _count: "1000" }, "W1 appointments");
const invoices = await collectAllPages(fhir, "Invoice", { status: "issued", _count: "1000" }, "W1 invoices");
```

Reject negative/non-finite money. Filter cancelled/no-show/entered-in-error appointments. Sum positive issued Invoice totals by `subject.reference`; retain oldest Invoice date and count.

- [ ] **Step 4: Verify GREEN**

Run: `cd mcp && node --import tsx --test tests/w1Watcher.test.ts`

- [ ] **Step 5: Commit**

```bash
git add mcp/src/watchers mcp/tests/w1Watcher.test.ts
git commit -m "Evaluate appointment balance watcher completely"
```

### Task 3: Task lifecycle, suppression, idempotency, and health

**Files:**
- Create: `mcp/src/watchers/watcher-task.ts`
- Create: `mcp/src/watchers/watcher-health.ts`
- Create: `mcp/src/watchers/watcher-engine.ts`
- Create: `mcp/src/jobs/runWatcherEngine.ts`
- Test: `mcp/tests/watcherEngine.test.ts`

**Interfaces:**
- Consumes: registry, config loader, `evaluateW1`.
- Produces: `createWatcherEngine(deps)`, `runWatcherSweep(deps)`, `startWatcherWorker(deps)`, `watcherWorkerIntervalMs(value)`, `projectWatcherHealth(state, config, now)`.

- [ ] **Step 1: Write failing lifecycle tests**

Assert conditional Task creation includes `If-None-Exist: identifier={system}|W1:Appointment/appt-1`; a second run updates the same Task and leaves one stored resource. Assert a disappeared active match becomes completed while a cancelled Task stays cancelled. Assert a synthetic fixed-threshold match before `goLiveAt` creates zero Tasks and an immediate W1 match still creates one.

Assert evaluation failure writes failed health while preserving `lastSuccessfulAt`. Assert health is degraded when `outcome === "failed"` or `now - lastSuccessfulAt` exceeds persisted `staleAfterMinutes`.

- [ ] **Step 2: Verify RED**

Run: `cd mcp && node --import tsx --test tests/watcherEngine.test.ts`

- [ ] **Step 3: Implement minimal Task/state persistence and scheduled worker**

Create Tasks conditionally, verify the returned identifier, and update only the matching Task. Store message inputs with explicit local type codings. Update health to running before evaluation, healthy only after every watcher succeeds, and failed on any error.

- [ ] **Step 4: Verify GREEN**

Run: `cd mcp && node --import tsx --test tests/watcherEngine.test.ts`

- [ ] **Step 5: Commit**

```bash
git add mcp/src/watchers mcp/src/jobs/runWatcherEngine.ts mcp/tests/watcherEngine.test.ts
git commit -m "Persist watcher lifecycle and health"
```

### Task 4: Fresh projections, cap, actions, and route wiring

**Files:**
- Create: `mcp/src/watchers/watcher-projections.ts`
- Create: `mcp/src/watchers/watcher-routes.ts`
- Modify: `mcp/src/index.ts`
- Test: `mcp/tests/watcherRoutes.test.ts`

**Interfaces:**
- Produces: `projectFrontDeskAlerts(input)`, `projectTodayDigest(input)`, `registerWatcherRoutes(app, deps)`.

- [ ] **Step 1: Write failing projection and route tests**

Create eight literal today-tier Tasks. Assert the Today body contains exactly five items and one overflow group of three; this-week and watch Tasks are absent. Assert ranking by severity, dollars, then age. Assert counts and dollars for today and yesterday plus both deltas. Assert healthy empty copy includes go-live date.

Feed valid Tasks with failed and stale health. Assert both GET routes return 503, `status: "degraded"`, the exact last success, and no `alerts`/`items`. Exercise dismiss, snooze, reassign, and resolve actions and assert the same Task id is updated with validated fields.

- [ ] **Step 2: Verify RED**

Run: `cd mcp && node --import tsx --test tests/watcherRoutes.test.ts`

- [ ] **Step 3: Implement projections/routes and wire the worker once**

Register watcher definitions synchronously before starting the worker. Reuse `authenticateStaffRoute` and the process service FHIR client; make no authorization-policy edits. A degraded read returns 503 even when Task search succeeds.

- [ ] **Step 4: Verify GREEN and MCP compilation**

Run: `cd mcp && node --import tsx --test tests/watcherRoutes.test.ts && npm run build`

- [ ] **Step 5: Commit**

```bash
git add mcp/src/watchers mcp/src/index.ts mcp/tests/watcherRoutes.test.ts
git commit -m "Expose fresh watcher projections and actions"
```

### Task 5: Appointment-row W1 rendering

**Files:**
- Create: `ui/src/lib/watchers.ts`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/scenes/frontdesk/FrontDeskCockpit.tsx`
- Modify: `ui/src/scenes/SchedulerDayGrid.tsx`
- Modify: `ui/src/scenes/scheduler/ResourceDayColumn.tsx`
- Modify: `ui/src/scenes/scheduler/PatientQuickCard.tsx`
- Test: `ui/tests/watcherFrontdesk.test.tsx`

**Interfaces:**
- Consumes: front-desk projection and action route.
- Produces: Appointment-id alert map, compact balance cue, quick-card action/dismissals, degraded banner, optional initial Appointment deep-link.

- [ ] **Step 1: Write failing real-component tests**

Render a real `ResourceDayColumn` with one matching alert and one unmatched Appointment. Assert `$132 balance` occurs only in Sarah's block. Render `PatientQuickCard` with the Task and assert the full message, consequence, one collection action, and three dismissal reasons. Render degraded `FrontDeskCockpit` and assert the last-success notice exists while no balance cue exists.

- [ ] **Step 2: Verify RED**

Run: `cd ui && node --import tsx --test tests/watcherFrontdesk.test.tsx`

- [ ] **Step 3: Implement the row cue, quick-card content, collection action, and degradation**

Pass watcher data as typed props; do not make `ResourceDayColumn` fetch. Keep the row cue compact and expose the full copy in the appointment-bound Quick Card. Resolve the same Task after successful collection.

- [ ] **Step 4: Verify GREEN and scheduler regressions**

Run: `cd ui && node --import tsx --test tests/watcherFrontdesk.test.tsx tests/schedulerControls.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/watchers.ts ui/src/App.tsx ui/src/scenes/frontdesk/FrontDeskCockpit.tsx ui/src/scenes/SchedulerDayGrid.tsx ui/src/scenes/scheduler/ResourceDayColumn.tsx ui/src/scenes/scheduler/PatientQuickCard.tsx ui/tests/watcherFrontdesk.test.tsx
git commit -m "Attach balance watcher to appointment rows"
```

### Task 6: Today digest rendering

**Files:**
- Create: `ui/src/scenes/BillingToday.tsx`
- Modify: `ui/src/App.tsx`
- Test: `ui/tests/watcherToday.test.tsx`

**Interfaces:**
- Consumes: Today projection and action route.
- Produces: direct `/billing/today` surface.

- [ ] **Step 1: Write failing digest tests**

Render eight server items in a real `BillingToday`; assert exactly five cards and one `3 more, grouped by reason` line. Assert counts are adjacent to dollars and deltas are adjacent to levels. Assert the healthy empty state and degraded last-success state are mutually exclusive. Assert each card has one primary action and overflow controls.

- [ ] **Step 2: Verify RED**

Run: `cd ui && node --import tsx --test tests/watcherToday.test.tsx`

- [ ] **Step 3: Implement Today without tabs or dead destinations**

Use server-projected rank/cap; the client does not recalculate eligibility. Primary actions deep-link to `/frontdesk?appointmentId={id}`. Overflow actions update the same Task and refresh.

- [ ] **Step 4: Verify GREEN and UI build**

Run: `cd ui && node --import tsx --test tests/watcherToday.test.tsx && npm run build`

- [ ] **Step 5: Commit**

```bash
git add ui/src/scenes/BillingToday.tsx ui/src/App.tsx ui/tests/watcherToday.test.tsx
git commit -m "Render capped Today watcher digest"
```

### Task 7: Mutation proof, complete gates, and PR

**Files:**
- Modify only if a discovered defect requires a new failing regression test.

- [ ] **Step 1: Run six reversible mutation demonstrations**

For each guard, use `apply_patch` to introduce the named break, run its focused test to capture RED, then use `apply_patch` to restore and rerun GREEN:

1. bypass owner validation, then bypass next-action validation;
2. return uncapped eligible items;
3. bypass pre-go-live filtering;
4. accept the first Invoice page despite a next link;
5. always create rather than conditional-create/update;
6. return Tasks before checking failed/stale health.

- [ ] **Step 2: Run all four final gates with real counts**

```bash
cd mcp && npm run build
cd mcp && npm test
cd ui && npm run build
npm run preflight
```

Source the existing root `.env` only in-process for the MCP live gate; never print or copy it. Report the known `clinicalWriteAuthzLive` failure separately if it remains the sole failure.

- [ ] **Step 3: Verify scope and count net-new tests**

Run `git diff origin/main --name-only`, assert no `mcp/src/claims/` path, count new `test(` / `it(` calls in added test files, and run `git diff --check`.

- [ ] **Step 4: Push and open the non-draft PR against main**

Push `drbang-iva/watcher-engine-2a`, create the PR with the sealed evidence summary, and do not merge.

- [ ] **Step 5: Adjudicate existing findings and re-poll final-head gates**

Wait for PR-Agent and Greptile final-head checks. Query unresolved review threads through GraphQL, reply/fix every existing finding, and repeat until both bots have a final-head signal or the documented no-bot exception applies.

- [ ] **Step 6: Return the sealed bundle**

Report summary, modeling decisions, files, commits, exact gate counts, all six RED/GREEN demonstrations, net-new test count, Today cap rendering description, risks/follow-ups, and `needs-review`. Include the mandatory independent-evaluation warning because Codex authored the implementation.
