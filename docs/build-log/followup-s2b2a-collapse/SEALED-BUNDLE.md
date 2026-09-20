# S2b-2a REV 2 — implementation evidence

This is the initial implementation record. The latest fixback and corrected save/clear protection are in [FIXBACK-1-BUNDLE.md](FIXBACK-1-BUNDLE.md).

NOT EVALUATED. Independent evaluator: Claude Opus 5, at the final PR head identified in the handoff.

## Summary

The overview now supports collapse/expand and returning proven-empty lines to their shelf.
One editor map owns the unchanged mapping algorithm and explicit data-evidence decisions.
Unknown editors, including every Procedure editor, are collapse-only.
View state is per encounter and browser; projected data overrides stored shelving on every render.
The full UI suite passes 1,800/1,800, with no skips; typecheck and preflight pass.
All 23 mutation cases covering G1–G11 and the migrated assertion go red and restore green.
Real-stack proof passed at 1440 and 390; all task containers are stopped.
Saved Procedures remain undrawn, and the existing immediate post-save overview requires a refresh in this stack.

## Identity, scope and files

- Branch: `drbang-iva/followup-s2b2a-collapse`.
- Pinned base: `da799f4eb9c290cf6e6e270b0031562e2b432d8a`.
- At resume, refreshed `origin/main` was `dbb41241826c5ab5bcce67cc2b1b165e5638c487` (email PR #634). The premise-bearing files had not changed; the requested pinned base was retained. Open PR #626 did not overlap.
- PR: [#635](https://github.com/drbang-iva/ODOS2020/pull/635). The final head SHA accompanies this bundle in the handoff and PR description. No merge or deployment is authorized or claimed.
- Author model: `gpt-6-astra`. Session configuration reports `xhigh`; the kickoff's requested `Coded-by: Codex — gpt-6-astra, high effort` marker is retained in the PR.
- Canonical design was read from the verified performance-od checkout, commit `9e1913b4`, `documents/drafts/2026-09-19-follow-up-exam-final/{design,acceptance-cases}.md`.

| File | Change |
| --- | --- |
| `ui/src/lib/exam-editor-map.ts` | Finding/editor routing, row/shelf helpers, and explicit tri-state data evidence. |
| `ui/src/lib/exam-view-state.ts` | Exception-safe load/save and pure view transitions. |
| `ui/src/components/charting/ExamOverviewBoard.tsx` | Presentational controls, collapsed summaries, data-wins rendering. |
| `ui/src/scenes/EncounterCharting.tsx` | Owns keyed view state, persists view-only changes, checks shelving and clears marks when an editor opens. |
| `ui/src/styles/charting.css` | Theme-token styles for line/control/summary and data marker. |
| `ui/tests/examEditorMap.test.tsx` | 14 tests: real writer pins/save/read/clear, census, unknown/Other findings, complete SpineNav inventory. |
| `ui/tests/examViewState.test.tsx` | 7 tests: persistence, no requests/mutations, data wins, unavailable storage, editor opening, fallback summary, active sheet protection. |
| `ui/tests/entrySheets.test.tsx` | One selector adaptation; the same 17-row anatomical-order assertion remains. |
| `docs/build-log/followup-s2b2a-collapse/` | Historical block/procedure probe, writer helper used by the new tests, mutation runner/results, disposable-stack proof, screenshots and this bundle. |

`SpineNav.tsx` was mutated for G5/G9 and restored byte-for-byte; there is no shipped rail change.
No files outside the allowlist were needed. No `mcp/`, `scripts/`, `.github/`, `data/`, lockfile, or appearance-baseline edits.
No new clinical codes, artifact URLs, regulatory assertions or clinical rules: Mandate 14 ledger rows added: **0**.
No new decision: `decisions/INDEX.md` unchanged. The kickoff author updates design status after merge.

## P1–P11 re-verification

The original checks at freshly fetched `origin/main = da799f4e` remain in [BLOCKED.md](BLOCKED.md), preserved as requested. REV 2 supersedes its pending-clarification status.

| Premise | Verified result |
| --- | --- |
| P1 | Six sheet definitions, original drawn union, shelf partition and FindingRow/EmptyEditorRow/ShelfEntry were present. The original union is retained before applying the authorized view-state override. |
| P2 | Eight explicit keys plus fallback candidates matched. All four routing helpers were local to the board; they now live together in `exam-editor-map.ts`, along with grouping/order helpers. Existing routing tests remain green. |
| P3 | Unmapped groups remain under Other findings; mapped and carried groups count as data. Any Other findings group prevents shelving every editor in that row. |
| P4 | Both surfaces derive from `chartEditorInventory`; G9 renders the actual rail against that same inventory, including on-demand entries. |
| P5 | Opened editor state, encounter reset, section-group union, fallback and return strip matched. View state is added beside them and keyed/reset on encounter change. |
| P6 | No prior collapse or shape record existed in the examined path. The existing preference helper can throw, so the new module catches both the localStorage getter and operations. |
| P7 | Group content-pin/refusal logic, scheduling-category independence, scope-driven rows and shelf partition are unchanged. Existing suites pass; G11's category regression fails the existing scope test. No new server authorization claim is made. |
| P8 | All eight real writer/definition modules import successfully into UI tests. All eight exports are pinned; actual save/overview/clear routes pass. No unpinned hand-table key remains. |
| P9 | New styles use charting classes/theme tokens. No appearance-debt-baseline edit. Preflight: zero warnings/blocks. |
| P10 | CI package commands were read. Baseline 1,779 tests; final 1,800 tests; both zero failed/skipped. UI typecheck, UI/MCP builds and preflight pass. |
| P11 | All five listed test/fixture importers were inspected and retained. Every specified test ID and copy string remains; the only existing assertion migration is below. |

## Assertion migration

| Existing assertion | Original protection | Adaptation and current protection |
| --- | --- | --- |
| `entrySheets.test.tsx`: “the comprehensive worksheet renders all 17 Ocular Health rows in anatomical order” | Exact ordered list of all 17 Ocular Health editors. | Read `data-drawn-editor-id` on the new line wrapper, falling back to the prior `data-editor-section-id`. The complete expected list is unchanged. The launch ID stays on the launch button. `assertion-migration` changes the wrapper identity to a wrong ID: exactly this test fails; restoring yields 50/50. |

No pre-existing assertion was removed, weakened or given a shorter expected list. Other existing test files and fixtures are unchanged.

## Registry decisions and real writer evidence

These are evidence capabilities, not assertions that an editor is currently empty. A mapped group or History summary returns `true` first. Other findings in the same row returns `unknown`; only a proven capability with no corresponding data can return `false`.

**False-capable (complete list of registry rules):** `auto-refraction`, `manual-keratometry`, `stereopsis`, `color-vision`, `cover-test`, `iop`, `cup-disc`, `ocular-health:*`, `custom:*`, and the exact key `dry-eye:tear-volume`.

**Explicit unknown (complete list):** `wearing`, `pretest-vitals`, `pachymetry`, `va`, `pupils`, `eom`, `cvf`, `dilation`, `refraction`, `refraction-history`, `eye-growth`, `soft-contact-lens`, `specialty-contact-lens`, `ortho-k`, `myopia-management`, `gonioscopy`, `dry-eye`, `imaging`, `prescription`, `aesthetics-consent`, `dry-eye:*` except the exact tear-volume override, and **every `procedure:*`**. Any absent ID is also unknown.

**Never-shelvable:** `hpi`, `assessment`. HPI's real finding is proven, but its separate summary can remain after clearing that observation, so it is deliberately never certified empty.

| Editor | Writer-owned key / export | Save → overview → clear |
| --- | --- | --- |
| iop | `resolveIopDefinitions().intraocularPressure.stableKey` → `intraocular_pressure` | 1 → 0 |
| cup-disc | `resolveCupDiscDefinition().stableKey` → `cup_disc_ratio` | 1 → 0 |
| auto-refraction | `resolveAutoRefractionDefinitions().autoRefraction.stableKey` → `auto_refraction` | 1 → 0 |
| cover-test | `COVER_TEST_KEY` → `entrance:cover` | 1 → 0 |
| manual-keratometry | `MANUAL_K_KEY` → `manual_keratometry` | 1 → 0 |
| color-vision | Real `buildEntranceFindingDefinitions()` Color vision definition → `entrance:color` | 1 → 0 |
| stereopsis | Real `buildEntranceFindingDefinitions()` Stereopsis definition → `entrance:stereo` | 1 → 0 |
| hpi | `HPI_STABLE_KEY` → `hpi_ros` | 1 → 0; summary may remain |
| ocular-health:anterior:cornea | Real materialized catalog plus current-finding writer | 1 → 0 |
| dry-eye:tear-volume | `DRY_EYE_TEAR_VOLUME_KEY` plus real custom capture endpoint | 1 → 0 |
| custom:synthetic-measurement-s2b2a000 | Definition created through the real creation endpoint, loaded by `FhirFindingDefinitionStore`, saved by real custom capture | 1 → 0 |

Command: `node --import tsx docs/build-log/followup-s2b2a-collapse/writer-probe.mjs` — exit 0, **11 successful real save/read/clear proofs**. Exact summaries: [writer-results.json](writer-results.json).

These tests invoke production endpoints/writers, `handleExamOverviewRequest`, and `handleEncounterVoidRequest` with the existing permissive in-memory FHIR fixture. Its create wrapper assigns fresh IDs and its transaction adapter implements conditional Observation PUT, matching the persistence operations the writer needs. It does not manufacture a finding projection or filter expected rows for the guard. These are not real AccessPolicy proofs; the browser lane below uses actual Medplum.

REV 2 Procedure evidence remains in [procedure-projection-probe.mjs](procedure-projection-probe.mjs) and [BLOCKED.md](BLOCKED.md): capture 201, one saved Procedure, zero Observations, overview 200 with zero findings before and after. The endpoint searches Basic, Condition, Observation and Provenance, never Procedure. No Procedure-family save/clear proof is claimed. G5 deletes the explicit Procedure decision and fails naming `procedure:synthetic`.

## G1–G11: destructive proof

The complete quoted red and restored-green summaries, commands and failing test names are in [GUARDS.md](GUARDS.md), with structured results in [mutation-results.json](mutation-results.json). There are **23 independent mutation cases**, all red, all restored green.

| Guard | Mutation result | Restored result |
| --- | --- | --- |
| G1 | Force false: 12 failures, including all eight saved hand-table editors. | 14/14 |
| G2 | Shelving calls refresh: 1 failure. | 7/7 |
| G2 active-sheet boundary | Remove active-sheet disabling: 1 failure. | 7/7 |
| G3 | Drop collapsed lines: 5 failures. | 7/7 |
| G4 default | Unknown/unregistered defaults false: 1 failure. | 14/14 |
| G4 Other findings | Ignore Other findings: 1 failure. | 14/14 |
| G5 iop | Delete iop decision: 2 failures; names iop. | 14/14 |
| G5 Procedure | Delete Procedure-family decision: 1 failure; names procedure:synthetic. | 14/14 |
| G5 new inventory entry | Add synthetic-unregistered without a decision: 1 failure naming it. | 14/14 |
| G6 | Apply shelving before checking data: 1 failure. | 7/7 |
| G7 | Collapse calls refresh: 1 failure. | 7/7 |
| G8 × 8 keys | Rename each mapped writer key independently: 1 corresponding writer-pin failure each. | 14/14 each |
| G9 | Remove iop from the actual rail rendering: 1 failure. | 14/14 |
| G10 | Let storage loader throw: 2 failures. | 7/7 |
| G11 | Re-key board drawing to scheduling category: existing S2b1 scope guard fails. | 7/7 |
| Migrated assertion | Corrupt line identity: the unchanged 17-row order expectation fails. | 50/50 |

Tests changed or added — covered by G1–G11 and the explicit assertion-migration mutation.

Map/registry — G5 enforces explicit decisions; deleting an entry goes red.

No decision file describes a shape this slice repairs; the kickoff author updates design status after merge.

## Real-stack proof 1–5

The disposable stack uses `odos-s2b2a-proof`, isolated ports and subnet, real Medplum 5.1.30, Postgres, Redis, built MCP and built UI through the real front-door route map. The before UI is from an unmodified detached worktree at da799f4e. The response proxy forwards normally: no mocked or dropped response was used. Colima: **8 GiB**. Only generated synthetic identities/data; runtime credentials are ignored and not in this bundle.

Commands (repository-relative except the operator-supplied before checkout):

```sh
node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs prepare
node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs up
node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs build
node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs serve
node --import tsx docs/build-log/followup-s2b2a-collapse/proof/seed-collapse.ts --fresh
node docs/build-log/followup-s2b2a-collapse/proof/browser.mjs "$BEFORE_ROOT"
node docs/build-log/followup-s2b2a-collapse/proof/browser.mjs "$BEFORE_ROOT" --pairs-only
node docs/build-log/followup-s2b2a-collapse/proof/browser.mjs "$BEFORE_ROOT" --baseline-refresh
node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs stop
```

`BEFORE_ROOT` is the separately built, clean pinned-base worktree. Do not run the before build from the author worktree. The build stamp displays the preceding commit because these captures preceded the final commit; [served-identity.json](served-identity.json) records dirty-build status, the actual JS/CSS hashes, source hashes, ports and server-image digest. No application source changed after the final build. The accessibility-only bot fixback and proof-runner corrections are recorded in [REVIEW-FIXBACK.md](REVIEW-FIXBACK.md).

| Proof | Actual result at both 1440 and 390 | Screenshots under `screenshots/` |
| --- | --- | --- |
| 1 | Save OD IOP 17 through the real UI/endpoint; refresh existing overview once (limitation below). Collapse only; unchanged Pretest order, marker and value remain. Reload retains collapse; expand restores FindingRow. | `{width}-after-expanded.png`, `-after-collapsed.png`, `-after-reload.png` |
| 2 | Proven cornea line goes to Ocular Health shelf; one click opens it, returning to overview shows it again and removes its shelved mark. Unknown wearing remains collapse-only. | `{width}-after-shelved.png`, `-after-unknown.png` |
| 3 | Persist cover-test shelving, save via the real `/clinical-graph/cover-test` endpoint while that preference exists, reload: live projection includes `entrance:cover`, line is open and collapse-only. | `{width}-after-data-wins.png` |
| 4 | Separate fresh private context opens fully expanded. Denying get/set for **exam-view state keys** leaves the board open and session collapse usable. Absent storage/getter/read/write failures are separately exercised by G10. | `{width}-private-open.png`, `-storage-denied-session.png` |
| 5 | Full UI tests, typecheck and preflight before/after below. | Numeric evidence below. |

Actual browser results: [browser-results.json](browser-results.json). Every isolated collapse/expand/shelve click had **0 network requests**; real page error count **0**. New private contexts reuse only the generated identity's authentication session, never local view preferences. This is not a claim that every unrelated application localStorage consumer tolerates total storage denial.

Primary before/after screenshots use the same synthetic encounter and stored findings, dimensions, route and IOP focus. They compare the original expanded line with the new collapsed line. Pair capture summaries: [screenshot-pairs.json](screenshot-pairs.json).

| Width | Before | After |
| --- | --- | --- |
| 1440 | [Expanded at base](screenshots/1440-before-expanded.png) | [Collapsed](screenshots/1440-after-collapsed.png) |
| 390 | [Expanded at base](screenshots/390-before-expanded.png) | [Collapsed](screenshots/390-after-collapsed.png) |

The immediate post-save board remained on its earlier empty snapshot until one explicit **Refresh exam overview**. This reproduced at unmodified da799f4e: **0 IOP rows immediately after save → 1 after refresh** ([baseline-refresh-probe.json](baseline-refresh-probe.json)). The proof does not claim this existing freshness issue is repaired. Shelving decisions see the received projection, so a stale projection remains a limitation until refreshed. No server or unrelated lifecycle change was made.

## Suite summaries

| Command | Before | After |
| --- | --- | --- |
| `npm --prefix ui test` | Exit 0: 1,779 pass; 0 fail/cancelled/skipped/todo; 213657 ms | Exit 0: 1,800 pass; 0 fail/cancelled/skipped/todo; 216523 ms |
| `cd ui && npx tsc --noEmit` | Exit 0, no diagnostics | Exit 0, no diagnostics |
| `npm run preflight` | Exit 0: 0 warnings, 0 hard blocks | Exit 0: 0 warnings, 0 hard blocks |
| `npm --prefix ui run build` | Pinned-base comparison build exit 0 | Author build exit 0 |
| `npm --prefix mcp run build` | Not changed | Exit 0; server source unchanged |

```text
BEFORE: npm --prefix ui test
# tests 1779
# pass 1779
# fail 0
# cancelled 0
# skipped 0
# todo 0

AFTER: npm --prefix ui test
# tests 1800
# pass 1800
# fail 0
# cancelled 0
# skipped 0
# todo 0

BEFORE AND AFTER: npm run preflight
ODOS preflight complete: 0 warning(s), 0 hard block(s).
```

No required check was skipped. No excluded file was needed. The UI build reports the existing large-chunk advisory; no dependency or bundling change was attempted.

## F9 read-only trace, storage and limitations

- The only application runtime import of `exam-view-state` is `EncounterCharting.tsx`; the board has a type-only import. `rg -n 'exam-view-state' ui/src mcp/src` finds no MCP import.
- `EncounterHeader.finishEncounter` runs protocol sign cleanup, calls `buildEncounterStatusPatchBundle`, and signs off series procedures. The bundle in `ui/src/lib/encounter-bundles.ts` patches Encounter status/end and adds Provenance. Neither imports or consumes exam view state.
- `ui/src/lib/print-window.ts` takes title and HTML; its callers are the receipt/lab surfaces (`CollectPanel`, `OpticalOrder`, `LabOrdersWorklist`). Neither that utility nor those callers imports view state. The existing correspondence renderers are server-side and have no such import.
- These are **read-only traces**, not a printed/signed clinical-record test. The deferred printed-record half of F9 is not claimed. G7 and the live request census prove the view actions themselves do not write or request chart data.
- Browser key: `odos:exam-view:v1:<encounterId>`, with editor IDs only. A second browser/device starts expanded; it does not receive the first browser's shelved/collapsed preferences. This is the safe interim direction until S3 migrates preferences to its shape record. No cross-tab/device synchronization is added.
- Unknown does not mean empty. Some unproven editors may already have saved content the overview does not expose; they cannot be shelved by this change.
- **A saved Procedure is drawn nowhere on the overview.** Its editor is explicitly unknown/collapse-only. Among the other measurement kinds actually saved by these proofs, every Observation reaches the overview; no additional undrawn measurement resource kind was found. The probes also write supporting Basic/Encounter/Provenance records, which are not standalone finding lines (HPI summary and undo/provenance use them). Untested unknown editors are not claimed to have complete projection coverage.

## Explicitly not done and follow-ups

- S2b-2b: Add to this visit search and search adapters; F4/BD-6/search half of F11.
- S3: follow-up profiles, shape record and shared view-state migration.
- S5: Same today and carried-finding write paths.
- Any server change or Procedure projection repair.
- Any SpineNav behavior change.
- Promoting any unknown editor without the required real save/read/clear proof.
- The deferred printed-record half of F9.

Cross-repo follow-up: kickoff author updates design status after merge. Separate follow-ups remain for Procedure visibility, the reproduced post-save overview freshness issue, and the pre-existing locale-sensitive identifier normalization preserved by the mapping-equivalence contract. Independent author-separated evaluation remains required before merge.

## Cleanup

`node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs stop` exited 0. Its owned application processes and before Caddy processes are stopped. Containers and volumes are retained for reproducibility but stopped; unrelated user stacks remain running.

`docker ps --filter name=odos-s2b2a- --format 'table {{.Names}}\t{{.Status}}'`:

```text
NAMES     STATUS
```

`docker ps --format 'table {{.Names}}\t{{.Status}}'`:

```text
NAMES               STATUS
vf-prac1b-walk-db   Up 32 hours
```

needs-review
