# ODOS-SEQ-2 sealed author bundle

Status: **implemented; needs independent Claude Opus 5 (EXTRA) evaluation**. No PR, push, merge or runtime enablement. Author is Codex; this is not an evaluation verdict.

Code head: `4c9225040705ff0f89042188e1d961663ab6d35c`. Branch: `drbang-iva/education-seq-2`. Worktree: `/Users/ericr.bang/GitHub/ODOS2020/.worktrees/education-seq-2`. Base and freshly fetched `origin/main`: `0ddc50c4208234e174640fec8677dc38b1b94f2d`. The subsequent bundle commit changes evidence only.

## Result

The eighth worker is wired beside the reminder engine, disabled by default. It authenticates each sweep, enumerates practice-scoped pages without a downtime lookback, isolates malformed enrollments, holds overdue rows, and admits/claims one row per patient per sweep through required versions on the enrollment resource. Claim and clinician cancellation contend on that resource. Frozen reservations reconcile independently of current catalog/contact/consent state, preserving the enrolling practitioner as sender and recording the system Device separately.

System dispatch cannot carry the staff quiet-hours exemption. A final-gate deferral retains its terminal attempt and creates one linked successor under a new key only with persisted proof the provider was not invoked. Unknown outcomes do not create fresh keys; exhausted attempts require review. Provider acceptance arriving after an indeterminate acknowledgement is projected onto the scheduled attempt without changing the acknowledgement or resending.

Each row keeps its own timing. Predecessor acceptance or an explicit clinician skip supplies the pacing anchor; a skip does not count as acceptance. Exact calendar id/version configuration supplies business days; no weekend/holiday calendar is inferred. Education-only daily spacing checks recorded acceptance at admission and is explicitly non-atomic.

The staff Task queue exposes malformed records, holds and print handouts. The separate Communications review page supports version-checked clinician skip/resume, exact Encounter review for patient-seen holds, and visible 409 recovery. It does not change the chart UI, perform analytics, or implement VisionForge sync. Print never enters electronic admission or dispatch.

## Precondition, first and separate

Commit `969526f7` preceded every worker-code commit. Shared `updateEnrollmentResource` translates underlying FHIR 409/412 into typed `stale-enrollment-version`, and the HTTP wrapper returns **409**, for all four required writes:

- Outcome recording.
- Creation-key repair.
- Indeterminate acknowledgement.
- Terminal active-identifier release.

Eight route cases exercise four paths against both transport statuses. The originally drafted **81 lines were retained**. Subsequent route tests add the staff-versus-worker claim boundary. The existing immediate claim and transition method bodies were compared byte-for-byte against `0ddc50c4`: both unchanged.

## Checks and actual results

From the task worktree root:

```sh
npm --prefix mcp test -- tests/commsApi.test.ts tests/commsSuppression.test.ts tests/commsConfig.test.ts tests/commsPersistence.test.ts tests/educationEnrollmentApi.test.ts tests/educationDispatchActor.test.ts tests/educationEnrollment.test.ts tests/educationSequence.test.ts tests/educationSequenceFhir.test.ts tests/educationSequenceTiming.test.ts tests/educationSequenceWorker.test.ts tests/educationSequenceWorkerStore.test.ts tests/educationSequenceRuntime.test.ts tests/educationSequenceOperations.test.ts
```

```text
# tests 259
# pass 259
# fail 0
# skipped 0
```

Exit 0. These 14 files cover production API/service/suppression/reservation code with synthetic adapters and enforcing FHIR fixtures.

From `ui/`:

```sh
npm exec -- tsx --test tests/appShell.test.tsx tests/roleRouting.test.tsx tests/clinicalGraphRouting.test.tsx tests/engageSheet.test.tsx tests/educationSequenceReview.test.tsx
```

```text
# tests 62
# pass 62
# fail 0
# skipped 0
```

After the final appearance-token change, `npm exec -- tsx --test tests/educationSequenceReview.test.tsx` again returned **6 tests / 6 pass / 0 fail / 0 skipped**, exit 0. Chromium traversed the actual AppShell, RouteSwitch, client and normal Vite proxy with a synthetic HTTP backend. Both refreshed screenshots were opened and inspected: [review](review-ui.png), [handout](review-ui-handout.png).

```text
npm --prefix mcp run build: tsc, exit 0
npm --prefix ui run build: tsc + vite, exit 0; built in 2.43s
npm run preflight: 0 warning(s), 0 hard block(s), exit 0
git diff --check: exit 0
Proxy census: 24 backend route families; 27 proxy entries; every family covered (advisory).
```

The UI build reports a chunk larger than 500 kB. Initial preflight refused 11 hardcoded styling instances in the new page; replacing them with existing appearance tokens cleared the block. Nine existing FHIR-write inventory line references moved with index.ts; only their verified line positions changed, not their authorization classifications. No dependency manifests or lockfiles changed.

## Nine required guards: broken, red, restored

Executed at the code head above with `python3 docs/build-log/education-seq-2/guard-mutations.py`; every test invocation inside the runner uses `npm --prefix mcp test`. The checked-in runner asserts the original baseline is green, makes one source mutation, requires nonzero failures, restores byte-identical source in `finally`, and requires restored green. Logs are `/tmp/odos-seq2-guard<N>-{baseline,red,green}.log` in the author workspace.

Numbers below are **pass / fail**. Every row has zero skipped tests. RED exits 1; restored exits 0.

| Guard | Deliberate defect | RED | Restored |
|---|---|---:|---:|
| 1 System exemption | Remove actor refusal; restore exemption by content class | 10 / 2 | 12 / 0 |
| 2 No clock transition | Invoke transition on the actual sweep path after authentication | 14 / 16 | 30 / 0 |
| 3 Stop wins | Replace the stale snapshot version with a fresh version before writing | 25 / 5 | 30 / 0 |
| 4 Claim wins | Resolve in-flight attempts as though pending when lifecycle stops them | 29 / 1 | 30 / 0 |
| 5 Burst | Remove per-patient handling filter | 26 / 4 | 30 / 0 |
| 6 Quiet-hours terminal trap | Rearm from the original terminal attempt and remove successor deduplication | 29 / 1 | 30 / 0 |
| 7 Fault isolation | Throw malformed enrollment parsing out of the sweep | 29 / 1 | 30 / 0 |
| 8 Typed conflict | Bypass shared translation at outcome recording | 46 / 3 | 49 / 0 |
| 9 Held/cancelled | Remove scheduling-disposition filter | 25 / 5 | 30 / 0 |

Guard 3 includes stop, stage change and same-stage re-entry. Guard 4 retains the in-flight/possibly-delivered truth and proves no successor resend. Guard 6 exercises the real final suppression gate, runtime dispatch factory, terminal recording, polling and simulated restart. Guard 8's failures include HTTP 502 instead of typed 409 and the shared-helper inventory detecting the bypass.

**Reachability audit:** none of the final nine guards was judged unreachable or aimed at an absent surface. Holds use real scheduling states; a legitimately released row is not represented as held. The earlier seven-versus-six worker-count STOP was correct and was cleared by the operator's corrected kickoff. Its closing prose still says eight guards, but the explicit operator instruction and numbered list require nine; all nine were run. A supplemental print fixture initially changed its channel while retaining an incompatible canonical row id; it was rebuilt through normal admission, preserving the identity guard. That fixture error was not counted as safety evidence.

Additional broken/restored guards cover skip pacing, late acceptance after acknowledgement, print task handling, fire-time visits, immediate clock startup, opt-out persistence, lost-outcome reconciliation, daily spacing, disabled runtime, Task deduplication and identity checks, attempt-cap resume refusal, binding integrity, late consent revocation, calendar forecast rejection, and the browser's Encounter confirmation. Main extra worker mutations returned 29/1 then 30/0 each, except lost-outcome reconciliation 28/2 then 30/0. Runtime enablement: 2/1 then 3/0. The UI confirmation mutation: 4/2 then 6/0. Operations, timing and dispatch details are linked below.

## Real Medplum proof

[Live evidence and opt-in command](live-write-proof.md) uses an entirely new, loopback-only Docker stack with explicit unique volume names and new synthetic accounts/projects. No shared database, existing account or actual provider was used.

- Actual stale `If-Match` returned **412**; fresh-version control succeeded.
- Stale admission/claim after stop became typed conflicts; cancellation history survived.
- The worker lost to a real committed stop: **zero adapter calls**.
- The route translated real **412 → HTTP 409**.
- Removing the helper's `If-Match`: **1 pass / 4 fail**; a forbidden adapter call occurred and the route answered 200. Restored: **5/5**.
- Extended staff queue proof exposed plain create responses omitting `meta.project`: **4 pass / 2 fail**. A project-scoped reload now verifies persisted task identity. Final extended live run: **6 pass / 0 fail / 0 skipped**. Identical staff-item requests yield one Task; malformed enrollment yields a visible item without an invented patient.

The live source is identified in the linked record; the late parent runtime wiring is additionally covered by the combined synthetic suite. The owned stack is stopped; isolated synthetic volumes remain. Live route authentication/audit uses test adapters and a fresh project token: this is not live practice-role AccessPolicy proof.

## Limits, setup and follow-ups

- **Independent evaluation remains Claude Opus 5 (EXTRA).** No author PASS marker was produced.
- The enable flag remains false. Enabling requires a real installed `Device/...` actor, the configured practice, providers/public link base, and exact business calendars where rows request them. No system actor can carry `quietHoursExemption`.
- No production provider call, delivery receipt, live clinical AccessPolicy, or full authenticated browser-to-live-backend path was exercised. Browser route proof and live persistence proof are separate instruments.
- Spacing is deliberately non-atomic, education-only, and configurable; it does not coordinate the reminder engine. The existing catalog loader is process-local; this slice adds no publishing/sync mechanism.
- The worker has no transition import/call path and never changes enrollment status/currentStageId. Scheduling disposition and hold-reason unions, row IDs and activation IDs are preserved. Patient class only; no lead nurture.
- No new clinical codes, regulatory assertions or FHIR artifact URLs: no Mandate 14 ledger additions. No new strategy decision: no PerformanceOD decisions/INDEX.md change. Cross-repo follow-up is the independent evaluation handoff only.
- No PR opened, push or merge performed. Other open PRs were scope-checked and do not overlap this slice.

## Commits

```text
969526f7 Education enrollment conflict precondition
458f5a3d Education sequence calendar timing
4b2da332 Education sequence actor dispatch boundary
68031fb2 Education sequence final consent gate
cf3a4f0a Education sequence sweep and versioned attempts
cc5a1f8f Education sequence staff review page
937de496 Education sequence clinical operations queue
dbd670d9 Education sequence real conditional-write proof
e0f54bf7 Education sequence runtime and reconciliation wiring
5249e740 Education sequence staff queue live proof
4c922504 Education review appearance tokens
```

## Complete file inventory

Paths below are relative to the ODOS worktree. This bundle is the additional evidence-only file.

```text
.env.example
docs/build-log/education-seq-2/dispatch.md
docs/build-log/education-seq-2/guard-mutations.py
docs/build-log/education-seq-2/live-write-proof.md
docs/build-log/education-seq-2/operations.md
docs/build-log/education-seq-2/precondition.md
docs/build-log/education-seq-2/review-ui-handout.png
docs/build-log/education-seq-2/review-ui.md
docs/build-log/education-seq-2/review-ui.png
docs/build-log/education-seq-2/timing.md
mcp/src/comms/comms-api.ts
mcp/src/comms/comms-persistence.ts
mcp/src/comms/comms-provider.ts
mcp/src/comms/education-enrollment.ts
mcp/src/comms/education-sequence-operations.ts
mcp/src/comms/education-sequence-runtime.ts
mcp/src/comms/education-sequence-store.ts
mcp/src/comms/education-sequence-timing.ts
mcp/src/comms/education-sequence-worker.ts
mcp/src/comms/education-sequence.ts
mcp/src/comms/suppression-gate.ts
mcp/src/index.ts
mcp/tests/educationDispatchActor.test.ts
mcp/tests/educationEnrollmentApi.test.ts
mcp/tests/educationSequenceFhir.test.ts
mcp/tests/educationSequenceLiveWrite.test.ts
mcp/tests/educationSequenceOperations.test.ts
mcp/tests/educationSequenceRuntime.test.ts
mcp/tests/educationSequenceTiming.test.ts
mcp/tests/educationSequenceWorker.test.ts
mcp/tests/educationSequenceWorkerStore.test.ts
scripts/fhir-read-grant-check.ts
ui/src/App.tsx
ui/src/components/AppShell.tsx
ui/src/lib/communications-client.ts
ui/src/scenes/EducationSequenceReview.tsx
ui/tests/educationSequenceReview.test.tsx
ui/vite.config.ts
```

Supporting evidence: [precondition](precondition.md) · [dispatch](dispatch.md) · [timing](timing.md) · [operations](operations.md) · [review UI](review-ui.md) · [live writes](live-write-proof.md).
