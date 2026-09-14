# Diagnosis-center slice 1 — fixback 2 sealed bundle

**Status: needs-review.** Local author changes on `drbang-iva/dx-status`, continuing exact head `e6e7c501a54ace85d3265cfa8a8e5b9b083e0b78` in `.worktrees/dx-status`. No push, PR, merge, or deployment.

The latest matching visit now counts a diagnosis as resolved if its FHIR clinical status is resolved **or its stored visit status is `resolved-this-visit`**. Prior statuses are read using the existing store, once per eligible visit, and matched by Condition reference. The latest-visit/window rules and mixed-eye all-resolved rule remain intact. The stye/follow-up/recurrence test keeps clinicalStatus active and obtains New from the follow-up's stored resolution.

Suggestion failures now return HTTP 200 with saved doctor rows intact and explicit `{ conditionReference, source: "unavailable" }` rows only for diagnoses whose suggestion cannot be calculated. Unavailable rows have no value. History-read failure affects unsuggested diagnoses; a diagnosis-specific calculation failure affects only that diagnosis. Failure to load current choices or validate current diagnoses still refuses the read rather than claiming those choices are known. No failed suggestion is stored.

UI/server row types both include unavailable rows. The diagnosis header shows a local error and Retry without selecting New or Established for an unavailable row; the doctor can still choose. Switching back to a doctor-chosen diagnosis shows that choice without the unrelated error. Assessment identifies unavailable newness on the affected card. Its existing protocol feed continues to use successful doctor rows and never invents New for unavailable rows.

## Verification of review and scope

Read `../performance-od/decisions/2026-09-14-odos-diagnosis-center-slice1-fixback-eval.md` and verified it matches the file at companion commit `205c7dd3`. Reverified the cited code at the requested head: resolution only checked clinicalStatus; DiagnosisWorkspace's clinicalStatus use at line 906 is filtering, not an editor; its visit-status update calls the endpoint/store only; the read handler's broad catch returned 503 after any history error; and the final suggestion uses `latestVisit.every(isResolved)`. The existing start-encounter path passes an ISO instant at encounter-bundles.ts:178; the import's localDateTime function at :1254 returns a timestamp with an offset. The review's ICD-category note is out of scope and unchanged.

Main was `6baea1d51666461e3de94ded1287ffe8817d2f70` at start. The final fetch advanced it to **`bd7029eb55435655f3e4332b2cc703bfd2d77e7e`**, the unrelated Guarantor search/Move/Join/undo merge (#593). Its changes do not overlap this fixback. The final open-PR query returned `[]`. This branch remains on its requested slice history; no rebase was performed.

## Files touched

Eight source/test files, plus the evidence directory enumerated in `files.txt`:

- `mcp/src/clinical-graph/diagnosis-newness.ts`: read prior visit statuses; include stored resolution in the existing predicate.
- `mcp/src/clinical-graph/diagnosis-newness-endpoint.ts`: preserve doctor rows and isolate suggestion failures.
- `mcp/src/clinical-graph/diagnosis-newness-types.ts`: explicit unavailable row variant.
- `mcp/tests/diagnosisNewness.test.ts`: recurrence, mixed-eye and partial-failure guards.
- `ui/src/lib/clinical-graph-client.ts`: matching response type.
- `ui/src/components/charting/DiagnosisWorkspace.tsx`: selected-row unavailable state; preserve doctor's display.
- `ui/src/components/charting/AssessmentSection.tsx`: unavailable message on affected diagnosis card.
- `ui/tests/diagnosisWorkspace.test.tsx`: switch between doctor and unavailable rows; selection/error isolation.

No schema, migration, dependency, standard medical code, canonical URL, MDM logic, or ICD fallback change. No new decisions or Mandate 14 ledger rows are needed: this applies the operator's explicit correction using existing local status values. No companion files changed.

## Checks and actual output

Commands below were executed in this worktree; where noted, cwd is its package directory. TAP trailing whitespace was trimmed only for git whitespace checks.

| Command | Actual output/result | Evidence |
| --- | --- | --- |
| `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/diagnosisNewness.test.ts` before implementation | `# tests 15`, `# pass 12`, `# fail 2`, `# skipped 1` | `before.tap` |
| Same command after implementation | `# tests 15`, `# pass 14`, `# fail 0`, `# skipped 1` | `after.tap` |
| cwd `mcp`: `node --import tsx --test tests/diagnosisNewness.test.ts tests/diagnosisVisitStatus.test.ts tests/diagnosisCarryForward.test.ts tests/v035b-ui-view.test.ts` | `# tests 160`, `# pass 158`, `# fail 0`, `# skipped 2` | `mcp-focused.tap` |
| cwd `ui`: `node --import tsx --test tests/diagnosisWorkspace.test.tsx tests/diagnosisNewness.test.tsx` | `# tests 47`, `# pass 47`, `# fail 0`, `# skipped 0` | `ui-focused.tap` |
| `npx --prefix mcp tsc --noEmit -p mcp/tsconfig.json` | exit 0; no diagnostics | `mcp-types.txt` |
| cwd `ui`: `npm run build` | exit 0; TypeScript clean; `built in 2.11s`; existing large-chunk warning | `ui-build.txt` |
| `node docs/build-log/diagnosis-center-fixback2/browser-proof.mjs` | PASS; real parent navigation and two-diagnosis switching; unavailable row isolated from doctor choice; save/reload and signed locks retained; 0 page errors | `browser.txt`, `browser-proof.json`, PNGs |
| `git diff --cached --check` | exit 0; no output after evidence whitespace normalization | final author check |

The two server skips are existing optional Postgres tests. Database schema/store SQL did not change and no database was started for this fixback. Prior migration proof is in the first fixback bundle; it was not rerun. The prior full UI count of 1,509 is historical, not a new run here. Current proof is the focused suites, typechecks/build, browser path and mutations above.

The browser mounts the real EncounterCharting parent and real components with intercepted synthetic HTTP. It proves the UI consumes partial row responses, not live Medplum policy or browser-to-database integration. The server recurrence test uses an injected store and asserts the follow-up visit was actually queried. No real patient data or credentials were used.

## Mandate 17 mutations

Run: `python3 docs/build-log/diagnosis-center-fixback2/mutations.py`. Each guard has paired TAP files and a result in `mutations.json`:

| Guard | Deliberate break | Broken | Restored |
| --- | --- | --- | --- |
| Stored resolution | Delete `\|\| prior.visitStatus === "resolved-this-visit"` | exit 1; recurrence produces Established instead of New | exit 0 |
| Mixed eyes | Change final `.every(isResolved)` to `.some(isResolved)` | exit 1; one resolved/one active incorrectly produces New | exit 0 |
| Doctor survives | Propagate history-read failure to the outer 503 catch | exit 1; expected partial 200 response | exit 0 |
| Unavailable UI | Remove unavailable-row error condition | exit 1; affected diagnosis loses its error | exit 0 |

All mutations were restored. `source-sha256.json` binds the eight source/test files to the final tested contents.

## Remaining boundaries

ICD three-character fallback, history identity/window rules, and the prior bundle's limitations remain unchanged. History now also depends on reading prior visit-status rows; a failed read makes unsuggested rows unavailable while preserving loaded doctor choices. Live policy enforcement was not exercised. No push, PR or merge is authorized.

**NOT EVALUATED — Codex authored this fixback. Hand the exact final commit to Fable (high) or Opus (medium) in Claude for the independent re-check of these three findings.**
