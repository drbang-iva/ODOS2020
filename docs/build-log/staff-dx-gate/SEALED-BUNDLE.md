# Staff diagnosis gate — author handoff

**NOT EVALUATED. Needs independent Claude Opus evaluation before merge.**

## Result and scope

`chart.diagnosis.write` is a registered, credential-bound business action. Provider is the only current role with Condition create/update grants, so Provider is the only declaration granted the action. The full role-table test derives its expectation from each compiled AccessPolicy, in both directions, separately for create and update. A membership override cannot grant this credential-bound action to Staff or Admin; explicit revocation remains effective.

Staff diagnosis picks and diagnosis-door finding assertions now refuse before any clinical write. Finding grade/laterality and quick-list pin maintenance keep their existing permissions. No finding-owned link storage was implemented.

- Branch: `drbang-iva/staff-dx-gate`
- Original base: `40c19a9e442015e1d32396958b661394318713d2`; rebased main: `5f0a67922eb2bcf52a2ab60f99a9dbb810fad384`.
- UI commit: `d6dc02d2` (cherry-picked from the task's isolated UI subtask).
- Integrated implementation commit: `d7564d14c126f596b338c23cd124fc29a2a03cda`.
- **Rebased: yes.** PR #607 merged during final packaging. The rebase had no conflicts; the full role-table file was rerun afterward, before opening this PR. Full backend/UI suites and live/browser proof were also rerun. The final pre-PR check is in `pre-pr-state.json`.
- `roles.ts` has exactly three action-list additions: business action registry, credential-bound list, and Provider's actions. No resource rule changed; #607's Basic rules/resource-list insertion are untouched. `roles-only.diff` records this.

## Gated call sites

| Boundary | Permission behavior |
|---|---|
| `handleDiagnosisPickRequest` / POST `diagnosis-picks` | Diagnosis action before possible/create, confirm, discard, transactions, tally or status writes |
| `handleDiagnosisOrderRequest` / PUT `diagnosis-order` | Diagnosis action before rank changes |
| `handleDiagnosisProblemStatusRequest` / PUT `diagnoses/:conditionId/problem-status` | New authenticated complexity boundary; expected Encounter version, same-patient/encounter binding, conditional update, existing Provenance targets |
| `handleDiagnosisVisitStatusUpdateRequest` / PUT `diagnoses/:conditionId/status` | Diagnosis action before status-store access |
| `handleDiagnosisNewnessUpdateRequest` / PUT `diagnoses/:conditionId/newness` | Diagnosis action before newness-store access |
| `handleDiagnosisPullRequest` / carry-forward route | Diagnosis action before copy/attach/provenance writes |
| `handleDiagnosisFindingsMutationRequest` / PUT `findings` | Ordinary chart action remains; assert, assign, standalone and clear additionally require diagnosis action before any write. Grade/laterality retain chart action |
| `handleEncounterVoidRequest` | Preview remains readable; actual clear involving Conditions requires diagnosis action before transaction |
| `handleEncounterUndoRequest` | Slots containing Conditions or diagnosis rows require diagnosis action before restore |

Quick-list GET/PUT, diagnosis catalog, findings GET, void responses, undo ledger and undo responses expose fresh `canWriteDiagnosis`. The UI fails closed for false or absent capability. DiagnosisWorkspace, DiagnosisPicker, AssessmentSection, findings assignment/assertion, PreviousExams pulls, clear and undo all consume it. Complexity's UI helper now delegates to the authenticated endpoint; the server owns the versioned update and Provenance.

## Checks and actual output

Commands ran in this task worktree. Larger raw outputs are gzip-compressed **without content changes**. `test-output-index.json` records the original SHA-256 and exact counters; `gzip -dc <file.tap.gz>` reads them.

| Check | Real result | Output |
|---|---|---|
| `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` with `ODOS_POSTGRES_URL` supplied privately from this task's disposable stack | **5127 tests; 5075 pass; 0 fail; 52 skipped** | `mcp-rebased.tap.gz` |
| `npm --prefix ui test` | **1613 tests; 1613 pass; 0 fail; 0 skipped** | `ui-rebased.tap.gz` |
| `npm --prefix ui run build` | Exit 0; 331 modules transformed; built in 2.24s | `ui-build-rebased.txt` |
| `./mcp/node_modules/.bin/tsc --project mcp/tsconfig.json --noEmit` | Exit 0 | `mcp-typecheck-rebased.txt` |
| Full role-table file: `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test -- tests/v05a-authz.test.ts` | **22 tests; 20 pass; 0 fail; 2 live skips** | `role-table-rebased.tap` |
| Restored backend mutation targets | **244 tests; 242 pass; 0 fail; 2 live skips** | `mutations-restored-green.tap.gz` |
| UI focused regression / restored guards | **459/459** / **47/47** | `../staff-dx-gate-ui/README.md` |
| Source/caller inventory corrections | Backend **27/27**; UI routing + browser walkthrough **23/23** | `source-inventory-green.tap`, `ui-routing-walkthrough-green.tap` |
| Proxy census | 25 backend route families; 28 proxy entries; no missing family (advisory) | `proxy-coverage.txt` |
| `git diff --check` | Exit 0 | Author command result |

The full MCP suite's 52 skips include 44 credentialed live checks. `ODOS_ALLOW_UNGATED_MCP=1` is explicitly acknowledged; the unit suite is **not** a live authorization verdict. Separate live evidence follows.

The first full run had six missing-default-PostgreSQL failures. Running against isolated PostgreSQL then exposed the new route's stale source-line inventory and route count; both were corrected. The first full UI run exposed the new caller count and two provider browser fixtures missing capability. The final full runs above are green. Intermediate outputs are retained.

## Mandate 17

All backend mutations ran in a separate scratch worktree at the pre-rebase integrated implementation (`3e79c526`). The full policy-derived role table was rerun after the rebase. Every replacement was checked to have landed; originals were restored in `finally`, and the full scratch diff was identical afterward. Exact commands/counters: `mutations.json`; executable procedure: `mutations.mjs`.

| Deliberate defect | RED result |
|---|---|
| Remove findings pre-write diagnosis refusal | **1 failure**; actual create calls violate zero-write assertion |
| Grant Staff the diagnosis action | **1 failure** in policy-derived role table |
| Revert complexity gate to ordinary chart action | **1 failure** |
| Revert pick gate | **4 failures** |
| Remove credential-bound classification | **1 failure** |
| Remove diagnosis void / undo gates | **1 failure each** |
| Claim all callers can write diagnoses in catalog / quick-list / findings payload | **1 failure each** |

Restoration: **242 passed, 0 failed, 2 skipped**. Four additional UI mutations failed as expected: Workspace bypass (2 failures), finding-handler bypass (2), cached Assessment permission (3), and dropped void-result permission refresh in actual EncounterCharting (3). Restored UI guards: **47/47**.

## Live and browser evidence

`live-proof.mjs` ran against the isolated Medplum 5.1.30 stack using repository-compiled policies and real verified Staff and Provider+Staff+Admin identities. No in-memory FHIR substitute was used. **13 cases succeeded** (`live-proof.json`):

- Staff pick, assertion, visit status, newness, complexity and reorder all returned **403**, with **zero attempted FHIR mutations** and unchanged resource versions.
- Provider confirmation returned **201**; finding assertion, visit status, newness, complexity and reorder returned **200**. The Condition, Encounter attachment, Observation and legacy Condition evidence actually persisted. Status/newness use the real isolated PostgreSQL store; their FHIR write count is zero by design.
- Native Staff Condition update returned **403** from Medplum under the unchanged AccessPolicy.

`browser-proof.mjs` used Chromium against the actual `App → RouteSwitch → PatientRoute → EncounterCharting` route, selecting the same synthetic diagnosis. Base and proposed UI worktrees used distinct strict ports (28986/28984), isolated Vite caches, the same live data and a 1920×1080 viewport. The images are native screenshots of the diagnosis workspace. Each capture asserts that Find diagnosis, Problem status and Diagnosis visit status are present; enabled for base Staff and proposed Provider, disabled for proposed Staff. Selecting/read-only viewing remains available. See `browser-proof.json` and `browser-{before,after,provider}.png`.

Browser limit: a proof harness registers the real selected handlers and real carry-forward/desk registrars; it does not launch the entire MCP process. Both UI revisions use proposed read handlers. No browser responses are mocked. Unrelated routes are absent and their failed requests are recorded, so this is evidence for the diagnosis surface, not a whole-app walkthrough or deployment.

## Existing test adjustments

- Backend `fresh Admin reads an honest empty quick list without attempting the writable seed`: expected response adds `canWriteDiagnosis: false`; seed/write assertions remain unchanged.
- `every definition-backed clinical-graph HTTP closure receives the persistent dependency`: route count 103→104 and an explicit assertion for the new complexity route's diagnosis action.
- `clinical-graph requests share the literal Vite route and Medplum authorization helpers`: caller count 55→56.
- `P0 assessment-search: immediate navigation uses a responsive in-app discard confirmation` and `P0 assessment-status: immediate navigation uses a responsive in-app discard confirmation`: shared provider fixture declares `canWriteDiagnosis: true`; assertions unchanged.
- Exact UI fixture and assertion inventory is in `../staff-dx-gate-ui/README.md`. Client-created complexity Provenance expectations moved to the server test; response-envelope expectations gained the capability. No staff half-write expectation was relaxed.

## Files and limits

`files-changed.txt` lists every changed application/test/script file. Changes are in role action declarations, the clinical endpoint boundaries listed above, matching UI consumers, regression tests and the exact source inventory. Evidence is confined to this directory and `../staff-dx-gate-ui/`.

Remaining boundaries requiring separate authorization/design:

- Seven legacy MCP diagnosis tools use the process service identity and have no authenticated staff caller context. This change does not retrofit MCP transport authentication. They are not secured by these staff HTTP gates.
- Native Encounter AccessPolicy still permits Staff edits to an open Encounter; business-action enforcement is at the application endpoints. Raw native Encounter diagnosis/complexity writes are outside this gate. Resource constraints were intentionally untouched under the slice's approved scope.
- Direct UI Condition helpers retain native FHIR writes, now hidden/disabled by server capability; native Staff Condition writes remain denied by Medplum. This PR does not make a broader claim about arbitrary native callers or person-level revocation at raw FHIR endpoints.
- The UI build retains its existing large-chunk warning. No deployment is claimed.

No new architecture decision: the accepted kickoff decision was implemented; `decisions/INDEX.md` needs no new entry. No new medical-code or FHIR-artifact literals were added to application code; no Mandate 14 ledger rows were required. No dependency or lockfile change. R10 A2 finding-owned links remain a separate follow-up.

Containers started by this task are **stopped, retained, not removed** (confirmed in `containers-final.json`):

- `staff-dx-gate-live-medplum-1`
- `staff-dx-gate-live-postgres-1`
- `staff-dx-gate-live-redis-1`

Status: implementation and author proof complete; **NOT EVALUATED**. Hand to independent **Claude Opus, high effort** for exact-PR-head evaluation. The author will not post an evaluation marker or merge.
