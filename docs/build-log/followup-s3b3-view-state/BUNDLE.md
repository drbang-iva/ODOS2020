# S3b-3 — server view state — REV 3 sealed author bundle

Collapse and shelf preferences now belong to the encounter and are shared across browsers and clinicians.
A separate Basic record avoids conflicts with the versioned shape record; I agree with the kickoff's reasoning.
Writes debounce for 300 ms and serialize within each mounted client; seven rapid toggles produced one write.
Read failure opens the board; write failure leaves the session toggle intact, silently.
Data, unknown evidence, and session-saved editors keep the existing reconciliation behavior.
No merge or deployment. NOT EVALUATED; independent evaluator: Claude Opus 5, high effort.

Coded-by: Codex

## Identity and scope

- Base: `35fa0eed2d78124c3905f5bdd96815fdd2e35d92`, freshly fetched and confirmed before implementation.
- Branch: `drbang-iva/followup-s3b3-view-state`.
- PR URL and exact final head are in the handoff and PR metadata; this evidence directory is included in that head.
- Runtime model/effort was not exposed by the session. High effort was recommended, not certified as the actual runtime setting (REV 2).
- Own isolated task worktree. Other open PRs were inspected: the only shared application file was index.ts in #647; this change adds only a separate route-registration block after all existing registrations. No existing handler was edited.
- Endpoint: new `exam-view-state-endpoint.ts`, to keep preference handling separate from the shape/read projection endpoint. Registered under the existing `/clinical-graph` prefix, so no proxy/deployment changes.
- Preferences require authenticated chart.read access and a successful caller-scoped Encounter read before the service client accesses the preference Basic. This preference does not authorize a clinical write.

## Files touched

- New: `mcp/src/clinical-graph/exam-view-state-store.ts`, `mcp/src/clinical-graph/exam-view-state-endpoint.ts`, `mcp/tests/examViewStateStore.test.ts`, `ui/tests/examViewStateServer.test.tsx`.
- Edited: `mcp/src/index.ts` (registration only), `ui/src/lib/exam-view-state.ts`, `ui/src/scenes/EncounterCharting.tsx`, `ui/tests/examViewState.test.tsx`, `ui/tests/clinicalGraphRouting.test.tsx` (57 → 58 only).
- Evidence and reproducible proof scripts: `docs/build-log/followup-s3b3-view-state/`.
- No final diff: `mcp/src/clinical-graph/exam-scope-store.ts`, `ui/src/components/charting/ExamOverviewBoard.tsx`. Board props are unchanged.

## P1–P8 re-verification at origin/main

| Premise | Verified evidence |
|---|---|
| P1 | exam-view-state.ts stores collapsed/shelved arrays under odos:exam-view:v1:<encounterId>, catches absent/throwing storage; EncounterCharting synchronously saves inside its toggle state updater without debounce. |
| P2 | shapeIfAbsent, pick and set route through write; pick/set use caller expectedVersion and If-Match; creation is conditional. Shape writes advance the persisted version. Separate preference storage avoids contention. |
| P3 | FhirEncounterSectionOverrideStore stores per-encounter Basic resources and conditionally creates by code + subject. Its structure informed the new store; preference updates deliberately omit version preconditions. |
| P4 | preflight's extension-shape rule checks the odos2020.com host. Scope uses urn:odos: identifiers. The new record uses only urn:odos: URLs; no canonical-registry entry is required. |
| P5 | Caddy and Vite already route /clinical-graph. The new GET/PUT use /clinical-graph/encounters/:encounterId/exam-view-state. |
| P6 | Board evidence reconciliation draws data/unknown despite shelving, treats saved editors as unknown, and keeps unknown collapse-only. Scene prevents shelving saved/active editors. Empty state opens the board. These production rules are untouched. |
| P7 | No view-state server store existed at the base. The new Basic starts with an encounter identifier, and If-None-Exist uses it. Two real concurrent first writes left one row. |
| P8 | Base routing census asserted 57 callers. The new UI module makes 58; only the count changed, and the full per-caller loop passes. |

## Assertion migration: examViewState.test.tsx

All seven original tests remain, with the following assertions preserved or adapted. No S1/S1b/S2a/S2b/S3a/S3b-1/S3b-2 test was removed.

| Original test | Assertions retained in the server-backed form |
|---|---|
| G10 storage scoped/malformed/inaccessible | Exact collapsed/shelved serialization; encounter-one round trip; encounter-two isolation; malformed JSON, null, non-string collapsed IDs and non-array shelving all open; missing/unavailable backend and throwing requests open; writes do not throw; a throwing localStorage getter cannot break reads or writes. The old key assertion is replaced by the exact encounter endpoint/body assertion, plus G8's zero-storage-access guard. |
| G3 collapsed data/order/remount/expand | Editor order unchanged; summary includes value 17; accessible label includes collapsed/data/value; data marker true; expanded finding row absent while collapsed; collapse survives a remount after persistence; expand restores one finding row. |
| G2/G7 no chart mutations and shelf opening | Collapse, expand and shelf remain local UI actions plus preference persistence only; line disappears into its shelf; refresh/group-write callbacks stay at zero; no unrelated fetch; shelf click restores the line and invokes the editor callback; final persisted shelving is empty. The former zero-network assertion now restricts requests to GET/PUT on the encounter preference endpoint. |
| G6 persisted shelf loses to data/unknown | IOP with data and Wearing with unknown evidence are drawn outside scope despite persisted collapsed+shelved IDs; neither is collapsed. |
| G10 unavailable state/session collapse | HTTP-unavailable, rejected reads, and rejected writes all start open; collapse works in-session and remains applied after the failed persistence attempt. |
| G3 empty/fallback/editor | Unformatted recorded data uses the fallback; collapsed summary opens the editor; open removes collapse; unknown empty Wearing remains drawn with the review fallback. |
| G2 active/absent | Active empty sheet's shelf control remains disabled; a collapsed preference alone does not draw an absent editor. |

## Full suites, types, builds, and preflight

| Command | Base | Candidate |
|---|---|---|
| `npm --prefix ui test` | 1,824 pass, 0 fail, 0 skip | 1,828 pass, 0 fail, 0 skip |
| Full MCP command below | 6,196 total: 6,141 pass, 0 fail, 55 skip | 6,201 total: 6,146 pass, 0 fail, 55 skip |
| `npx tsc --noEmit` at root, and with `-p mcp/tsconfig.json` / `-p ui/tsconfig.json` | all exit 0 | all exit 0 |
| `npm run preflight` | 0 warnings, 0 hard blocks | 0 warnings, 0 hard blocks |
| MCP and UI production builds | — | exit 0; existing Vite chunk-size advisory |

UI: **1,824 + 4 = 1,828**. MCP: **6,196 + 5 = 6,201**. The seven migrated tests retain their count.

```sh
ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:29836/medplum ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test
```

This ran the complete default suite against task-owned Postgres. The opt-out explicitly acknowledges existing live-credential skips; it is not live-authz proof. Feature-specific real-stack proof is separate below. Raw logs are not committed; actual suite summaries are in `suite-summaries.json`.

An initial candidate run had six failures in `tests/preflight/fhir-read-grant-check.test.ts` because an inserted import/route shifted exact inventory line numbers. The failures were: live FHIR coverage; CLI full coverage; planted MCP create; planted UI create; planted serviceFhir read; planted UI read. Registration was moved to the end of the existing route setup, with one dynamic import at startup. The inventory, checks, and existing call sites were not edited or weakened. The complete rerun passed, as above.

`node .claude/skills/tier0-census/scripts/check-proxy-coverage.mjs`: existing advisory for /follow-up-profiles; the new route uses the already-covered /clinical-graph prefix. No outside-scope repair was needed.

Unchanged shape and overview tests: `node --import tsx --test mcp/tests/examShapeRecord.test.ts mcp/tests/examOverviewEndpoint.test.ts` → **43 pass, 0 fail**.

## G1–G10 mutation proof

Each mutation was applied alone and restored byte-for-byte before the green run. Reproduction: `python3 docs/build-log/followup-s3b3-view-state/proof/mutations.py`. Exact runnable commands and summaries are in `mutations.json`. G2 redirected the **new view store** to the shape record's identity/extension/code, which is within the normal allowlist and fails on the shape version. The G2 temporary grant for exam-scope-store.ts was not needed.

### G1

Command: `cd mcp && node --import tsx --test '--test-name-pattern=S3b3 G1' tests/examViewStateStore.test.ts`

Broken (exit 1):

```text
not ok 1 - S3b3 G1 independent clients share the encounter preference, other encounters stay open
  error: |-
  expected:
  actual:
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

Restored (exit 0):

```text
ok 1 - S3b3 G1 independent clients share the encounter preference, other encounters stay open
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G2

Command: `cd mcp && node --import tsx --test '--test-name-pattern=S3b3 G2' tests/examViewStateStore.test.ts`

Broken (exit 1):

```text
not ok 1 - S3b3 G2 collapse does not bump or change the shape record
  error: |-
  expected: '1'
  actual: '2'
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

Restored (exit 0):

```text
ok 1 - S3b3 G2 collapse does not bump or change the shape record
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G3

Command: `cd ui && node --import tsx --test '--test-name-pattern=S3b3 G3' tests/examViewState.test.tsx`

Broken (exit 1):

```text
not ok 1 - S3b3 G3 S2b2a G6 persisted shelving loses to saved data and unknown evidence, even outside scope
  error: 'iop must draw despite persisted shelving'
  expected: true
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

Restored (exit 0):

```text
ok 1 - S3b3 G3 S2b2a G6 persisted shelving loses to saved data and unknown evidence, even outside scope
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

`git diff -- ui/src/components/charting/ExamOverviewBoard.tsx` → **empty output**.

### G4

Command: `cd ui && node --import tsx --test '--test-name-pattern=S3b3 G4' tests/examViewState.test.tsx`

Broken (exit 1):

```text
not ok 1 - S3b3 G4 S2b2a G10 unavailable server keeps the board open and collapse works in-session
  error: 'network denied'
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

Restored (exit 0):

```text
ok 1 - S3b3 G4 S2b2a G10 unavailable server keeps the board open and collapse works in-session
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G5

Command: `cd ui && node --import tsx --test '--test-name-pattern=S3b3 G5' tests/examViewStateServer.test.tsx`

Broken (exit 1):

```text
not ok 1 - S3b3 G5 actual chart keeps a failed write in-session without changing its alert count
  error: |-
  expected: 0
  actual: 1
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

Restored (exit 0):

```text
ok 1 - S3b3 G5 actual chart keeps a failed write in-session without changing its alert count
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G6

Command: `cd ui && node --import tsx --test '--test-name-pattern=S3b3 G6' tests/examViewStateServer.test.tsx`

Broken (exit 1):

```text
not ok 1 - S3b3 G6 rapid toggles coalesce and slow writes retain the final state
  error: |-
  expected: 1
  actual: 7
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

Restored (exit 0):

```text
ok 1 - S3b3 G6 rapid toggles coalesce and slow writes retain the final state
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G7

Command: `cd mcp && node --import tsx --test '--test-name-pattern=S3b3 G7' tests/examViewStateStore.test.ts`

Broken (exit 1):

```text
not ok 1 - S3b3 G7 concurrent first writes leave one physical row, subsequent writes need no expectedVersion
  error: |-
  expected: 1
  actual: 2
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

Restored (exit 0):

```text
ok 1 - S3b3 G7 concurrent first writes leave one physical row, subsequent writes need no expectedVersion
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G8

Command: `cd ui && node --import tsx --test '--test-name-pattern=S3b3 G8' tests/examViewStateServer.test.tsx`

Broken (exit 1):

```text
not ok 1 - S3b3 G8 server persistence never accesses browser localStorage
  error: |-
  expected: 0
  actual: 1
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

Restored (exit 0):

```text
ok 1 - S3b3 G8 server persistence never accesses browser localStorage
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G9

Command: `cd ui && node --import tsx --test '--test-name-pattern=S3b1 G1|S3b2 G1|S3b1 G2 legacy|bookkeeping|unconfirmed shape' tests/examOverviewBoard.test.tsx ../mcp/tests/examShapeRecord.test.ts ../mcp/tests/examOverviewEndpoint.test.ts`

Broken (exit 1):

```text
ok 1 - S3b1 G8 an unconfirmed shape create serves the unshaped overview and retries next open
ok 2 - S3b1 failed bookkeeping write serves the unchanged overview
ok 3 - S3b2 G1 G2 G5 explicit pick replaces derived, survives overview, writes only the scope
not ok 4 - S3b1 G1 profile edit and retirement never reshape a stored visit, scope edits preserve shape
  error: 'Exam scope changed concurrently — reload and retry.'
not ok 5 - S3b2 G1 explicit shape survives automatic shaping at the store boundary
  error: 'Exam scope changed concurrently — reload and retry.'
not ok 6 - S3b1 G2 legacy row parses and keeps exactly the same drawn lines without retro-shaping
  error: 'this.fhir.create is not a function'
ok 7 - S3b1 G8 unconfirmed bookkeeping write still draws the unshaped board
# tests 7
# pass 4
# fail 3
# cancelled 0
# skipped 0
```

Restored (exit 0):

```text
ok 1 - S3b1 G8 an unconfirmed shape create serves the unshaped overview and retries next open
ok 2 - S3b1 failed bookkeeping write serves the unchanged overview
ok 3 - S3b2 G1 G2 G5 explicit pick replaces derived, survives overview, writes only the scope
ok 4 - S3b1 G1 profile edit and retirement never reshape a stored visit, scope edits preserve shape
ok 5 - S3b2 G1 explicit shape survives automatic shaping at the store boundary
ok 6 - S3b1 G2 legacy row parses and keeps exactly the same drawn lines without retro-shaping
ok 7 - S3b1 G8 unconfirmed bookkeeping write still draws the unshaped board
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
```

`git diff -- mcp/src/clinical-graph/exam-scope-store.ts` → **empty output**.

### G10

`cd ui && node --import tsx --test tests/clinicalGraphRouting.test.tsx`:

```text
ok 2 - clinical-graph requests share the literal Vite route and Medplum authorization helpers
# tests 8
# pass 8
# fail 0
```

Caller inventory is **58**. The per-caller loop and every other assertion are unchanged. G10 is verification-only under REV 3.

## Real-stack proof 1–5

Two independent Chrome browser processes, separate browser contexts, synthetic provider sign-ins, production-built UI/MCP, real Medplum/Postgres, and generated Caddy routing from the repository frontdoor. Source hashes and served-asset hashes are recorded alongside the proof; the build is a dirty candidate at the base SHA, not falsely labeled as committed code.

1. Collapse Wearing in browser A; open the same encounter in browser B: collapsed there. Shape version unchanged. Screenshots: `screenshots/1440-shared-second-browser.png`, `screenshots/390-shared-second-browser.png`.
2. A shelves blank IOP. B charts IOP through the real editor while its preference write fails, leaving A's persisted shelved ID intact. Both browsers reload and draw the recorded IOP. Screenshots: `screenshots/{1440,390}-data-wins-{first,second}-browser.png`.
3. Route returns 503: board opens; no collapsed lines; alert count **0**. A toggle still applies, alert count stays **0**, and another reload loses that unpersisted toggle. The clinical editor still opens. Screenshots: `screenshots/{1440,390}-read-failed-open.png` and `screenshots/{1440,390}-write-failed-session-toggle.png`.
4. At both widths, **7 rapid toggles → 1 PUT**, final persisted state correct. The per-toggle mutation produced **7 writes** and failed the count assertion. `browser-proof.json` records the real measurements.
5. Full suite/type/preflight results above. `concurrent-create.json` additionally proves **2 concurrent first writes → 1 physical Basic row** against real Medplum, with a subsequent write visible through the other independent client.

Screenshots are candidate-state previews, not a claimed base/candidate appearance comparison. The 390-wide capture uses a taller viewport to show the board below the existing header/picker; this slice does not change their layout.

## Regression, limits, and follow-ups

- **Accepted regression:** with the server unreachable, reloading loses collapse/shelf preferences; there is no localStorage fallback or migration.
- Preferences are now shared by the encounter, including across clinicians and computers. They load on mount; there is no live push/polling synchronization between already-open clients.
- Last-write-wins may lose a concurrent user's toggle, as specified. Within one client, writes serialize to preserve its final state.
- Read failure opens; write failure retains session state; neither creates an alert.
- Not done: Following strip; Since last visit; pull-forward sheet (S5); test queue and Follow-up tab (S3c); nextVisit.requests[] and Appointment.basedOn (S4); changes to shape, source, or best-effort shaping.
- Mandate 14: zero ledger rows added; no new billing/medical codes, clinical intervals, or canonical URLs. Proof uses existing synthetic fixture conventions.
- No new strategy decision: the supplied separate-record ruling was implemented. No decisions/INDEX.md change or cross-repo edit.
- Outside §4: **none**. The two temporary-grant files have empty final diffs and must not appear in the PR file list.
- Author checks and bot checks do not replace independent evaluation. Claude Opus 5 must evaluate the exact final head before merge.

## Cleanup

`node docs/build-log/followup-s3b3-view-state/proof/stack.mjs stop` stopped the task app and all odos-s3b3-proof containers, retaining disposable volumes. Final `docker ps --format '{{.Names}} {{.Status}}'`:

```text
vf-prac1b-walk-db Up 47 hours
```

No odos-s3b3- container remains running. Other owners' services were left alone.

⚠️ NOT EVALUATED — hand to Claude Opus 5, high effort, for the independent eval before merge. I wrote it; I can't be the judge.

needs-review
