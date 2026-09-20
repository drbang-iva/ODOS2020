# S2b-1 shelf — sealed author bundle (REV 3)

The board now ends with one always-visible shelf, using the existing shared editor inventory.
Undrawn editors and available section groups are grouped in the required order and open in one click.
Pulled-in section groups draw their lines without leaving the board; content-pinned groups retain the real server refusal.
Unmatched findings show their value, eye, and date; both carried states remain visible with their provenance.
Scope controls the drawn rows; visit type and diagnoses stay unchanged when an editor opens.
All G1–G8 mutations failed as intended and passed after restoration, including the actual G5 server refusal.
The full UI suite passes; the MCP executed tests pass with its pre-existing unconfigured-live-lane exit 1 reported below.
Real synthetic browser proof passed at 1440 and 390; independent evaluation is pending.

Branch: `drbang-iva/followup-s2b1-shelf`.
Implementation commit: `218aa4da05862cac00f424a83c2e39d04d4effa3`.
Base: `f2ef2c325e36d756759a525339431d70c7bcfde1`.
The PR description records the final evidence head SHA and PR URL; subsequent evidence-only commits do not change the implementation blobs above.

Coded-by: Codex — GPT-6, high effort

NOT EVALUATED — designated evaluator: Claude Opus 5. No merge or deployment is authorized or performed.

## P1–P7 re-verification



All code premises were read using `git show origin/main:<file>`, after `git fetch origin` in the new task worktree. The companion design was read at the specified `9e1913b4` commit in the verified performance-od checkout.

| Premise | Observed source evidence at the base |
| --- | --- |
| P1 | `ExamOverviewBoard.tsx:135–150` has the six-row frame; `:194–203` applies optional/comprehensive, trace, or findings visibility; `:156` groups editors; `:213–217`, `:354–366`, and `:407–443` compute and draw the per-group disclosures. |
| P2 | `ExamOverviewBoard.tsx:162` and `:180` admit only current findings. The unreferenced-finding path maps to an editor at `:183` and drops unmatched groups at `:184`. |
| P3 | `SpineNav.tsx:13–42` defines the base inventory; `:54–74` adds custom/ocular sections; board and rail both call `chartEditorInventory`. |
| P4 | `EncounterCharting.tsx:763–765` computes active, not-effective groups. `:583–604` calls the built encounter section-group endpoint with action add. `:612–647` handles removal, including 409. The old select lives in the editor body at `:964–978`. |
| P5 | `finding-section-group-endpoint.ts:84–87` derives effective groups from pulled-in plus content-pinned groups; `:219–222` refuses content-bearing removal. `EncounterCharting.tsx:949–962` replaces Remove with “Has findings this visit”. `finding-section-groups.ts:29–38` retains content-pinned definitions, including inactive groups. No scheduling category is read in these visibility helpers or the overview projection/endpoint. |
| P6 | `exam-overview-projection.ts:337–341` defaults to comprehensive and selects requirements by exam scope. The board's row predicate uses that scope and completeness trace. |
| P7 | All four named files exist: UI overview and section-group tests, MCP overview projection and R10 parity tests. Additional real-browser dependency: `ui/tests/entrySheets.test.tsx`, included by REV 2. |

## Files touched

| File | Change |
| --- | --- |
| `ui/src/components/charting/ExamOverviewBoard.tsx` | Single shelf, inventory partition, Other findings, carried markers, group availability/pin display. |
| `ui/src/scenes/EncounterCharting.tsx` | Keep opened lines in exam order and draw effective group editors; shelf group actions use the existing pull-in call. |
| `ui/src/styles/charting.css` | Shelf layout, finding metadata, amber unreasserted marker; preserve launch-row and populated-column geometry. |
| `ui/tests/examOverviewBoard.test.tsx` | Assertion migrations plus scene-level one-click/pull-in tests. |
| `ui/tests/entrySheets.test.tsx` | `openFromShelf` retains every former helper caller and the existing geometry/presentation/focus/dirty/swap/hover guards. |
| `ui/tests/visitTypeResolverBoard.test.tsx` | Shared inventory input migration; every assertion retained verbatim. |
| `ui/tests/fixtures/exam-chart-bar-responsive.tsx` | Shared inventory input migration; responsive test assertions unchanged. |
| `ui/tests/examShelf.test.tsx` (new) | Seven partition/persistence/pin/unmatched/carry/scope tests. |
| This build-log directory | Summaries, mutation runner/results, reproducible synthetic harness, screenshots, served-artifact identity. |

REV 3 additionally permits `ui/tests/examChartBarResponsive.test.tsx` and `ui/tests/fixtures/entry-sheets.tsx`; both remain unchanged because their existing assertions and shared inventory already work. No files outside the amended allowlist were needed. No projection shape, SpineNav, dependency, lockfile, server behavior, or clinical terminology changed. The G5 endpoint mutation was temporary and restored.

The full [assertion-migration table](assertion-migration.md) names every changed pre-existing assertion, its previous guard, and the retained/new assertion. The REV 3 fixture changes are input migrations, not weakened assertions.

## Guard evidence

[guards.md](guards.md) quotes every command, red output and restored-green output. [guards.json](guards.json) also records the exact mutation. The G1–G8 target logic is unchanged by the later shelf-padding-only commit. Counts:

| Guard | Mutation | Red pass / fail | Restored pass / fail |
| --- | --- | ---: | ---: |
| G1 | Drop Contact Lenses shelf group | 5 / 2 | 7 / 0 |
| G2 | Re-render old disclosure | 5 / 2 | 7 / 0 |
| G3 | Make editor click write scope | 109 / 1 | 110 / 0 |
| G4 | Hide available section groups | 109 / 1 | 110 / 0 |
| G5 | Disable actual `section-group-has-content` endpoint refusal | 20 / 7 | 27 / 0 |
| G5 pin wording (additional) | Replace visible pin wording | 6 / 1 | 7 / 0 |
| G6 | Restore unmatched-editor skip | 6 / 1 | 7 / 0 |
| G7 | Restore current-only provenance filter | 6 / 1 | 7 / 0 |
| G8 | Key drawing off scheduling category | 6 / 1 | 7 / 0 |

After G5 restoration:

```sh
git diff --stat -- mcp/src/clinical-graph/finding-section-group-endpoint.ts
```

Output: empty (zero lines); exit 0. There is no committed endpoint change.

## Full-suite before/after

```sh
npm --prefix ui test
ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:28434/s2b1_suite npm --prefix mcp test
```

The database is the task-owned synthetic `odos-s2b1-suite-db`; these are public disposable fixture defaults, not operator credentials.

| Suite | Tests | Pass | Fail | Skip | Cancel | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| UI before | 1770 | 1770 | 0 | 0 | 0 | 0 |
| UI after | 1779 | 1779 | 0 | 0 | 0 | 0 |
| MCP before | 6097 | 6042 | 0 | 55 | 0 | 1 |
| MCP after | 6097 | 6042 | 0 | 55 | 0 | 1 |

Failing executed test names in these final runs: none.

Final UI summary:

```text
# tests 1779
# pass 1779
# fail 0
# cancelled 0
# skipped 0
# duration_ms 209835.921416
```

Final MCP summary:

```text
# tests 6097
# pass 6042
# fail 0
# cancelled 0
# skipped 55
# duration_ms 153122.075666
LIVE STACK NOT CONFIGURED — 47 tests skipped
```

Both MCP commands exit 1 because 47 live tests are unconfigured within the 55 total skips. No ungated opt-out was used. This is not a fully green MCP package command and does not prove the broader live-authorization lane. The task's specific real 409 path is separately proved with the provider identity on the disposable stack.

The REV 3 focused migration command (`cd ui && node --import tsx --test tests/examOverviewBoard.test.tsx tests/visitTypeResolverBoard.test.tsx tests/examChartBarResponsive.test.tsx`) passed 114/114 with zero skips. `npm --prefix ui run build` and `npm --prefix mcp run build` exited 0; the proof harness rebuilt the implementation commit for the final browser run. `git diff --check` exits 0.

## Real-stack browser proof

The original and proposed UI are served from separate worktrees on loopback ports 31092 and 31091, through generated copies of the repository front-door configuration. They use the same synthetic Medplum data and unchanged MCP implementation. Provider login, actual persisted findings, actual endpoint calls, and native controls are used; no route mocks or response substitutions are installed. Runtime credentials and complete logs remain gitignored.

[Served identity](served-artifact.json) records source commit and asset hashes. [Browser results](browser-proof.json) record both viewports, unchanged scope/type/diagnoses, the persisted finding states, computed amber color, and actual 409 response. G1's complete inventory partition is additionally proved in unit tests; the screenshot alone is not claimed as a census.

| Proof | 1440 | 390 |
| --- | --- | --- |
| 1. Comprehensive shelf, before | [Before](screenshots/1440-before-comprehensive.png) | [Before](screenshots/390-before-comprehensive.png) |
| 1. Comprehensive shelf, after | [After](screenshots/1440-after-comprehensive.png), [complete shelf](screenshots/1440-after-complete-shelf.png) | [After](screenshots/390-after-comprehensive.png), [complete shelf](screenshots/390-after-complete-shelf.png) |
| 2. Office scope shelf | [Shelf](screenshots/1440-after-office-shelf.png) | [Shelf](screenshots/390-after-office-shelf.png) |
| 2. One-click Macula existing editor and retained line | [Editor](screenshots/1440-after-macula-editor.png), [drawn row](screenshots/1440-after-macula-drawn.png) | [Editor](screenshots/390-after-macula-editor.png), [drawn row](screenshots/390-after-macula-drawn.png) |
| 3. Dry Eye pull-in without leaving board | [Drawn lines](screenshots/1440-after-dry-eye-pulled-in.png) | [Drawn lines](screenshots/390-after-dry-eye-pulled-in.png) |
| 3. Charted group is pinned; removal is 409 | [Pinned](screenshots/1440-after-dry-eye-pinned.png) | [Pinned](screenshots/390-after-dry-eye-pinned.png) |
| 4–5. Previously undrawn recorded data | [Before](screenshots/1440-before-recorded-data.png) | [Before](screenshots/390-before-recorded-data.png) |
| 4. Other findings value, eye, date | [Board](screenshots/1440-after-other-findings.png), [detail](screenshots/1440-after-other-findings-detail.png) | [Board](screenshots/390-after-other-findings.png), [detail](screenshots/390-after-other-findings-detail.png) |
| 5. Confirmed and amber unconfirmed carried values | [Carried lines](screenshots/1440-after-recorded-data.png), [count](screenshots/1440-after-carried-count.png) | [Carried lines](screenshots/390-after-recorded-data.png), [count](screenshots/390-after-carried-count.png) |

At both widths, the browser reads three persisted findings: one current unmatched finding and two carried findings. The unreasserted marker computes to `rgb(231, 169, 76)`, equal to the resolved `--odos-amber`; the completeness control says `1 carried, not reasserted`. After Macula returns to the board the rows are exactly History, Ocular Health, Assessment; only Macula is drawn in Ocular Health. The group removal response is:

```json
{"status":409,"body":{"code":"section-group-has-content","sectionKeys":["dry-eye:symptoms"]}}
```

The saved symptoms are entered through the actual existing editor before this refusal. Screenshot evidence shows the pin wording; the HTTP response is recorded in the browser result rather than drawn as invented UI.

## Cleanup and scope

Task-owned containers and application processes are stopped after evidence capture; synthetic volumes are retained for replay. Colima remains at 8 GiB. User-owned stacks are untouched.

```sh
docker ps --filter name=odos-s2b1- --format 'table {{.Names}}\t{{.Status}}'
```

```text
NAMES     STATUS
```

No additional allowlist expansion is needed. The earlier stopped bundles are superseded by REV 3 and this evidence. No new design decision was made, so no performance-od decision or `decisions/INDEX.md` update is needed. No new medical code, FHIR artifact URL, regulatory citation, or clinical threshold was introduced; no new Mandate 14 ledger row is required. The synthetic harness reuses existing builders and coding constants.

## Risks and explicit deferrals

- Independent evaluation remains pending at the final PR head; these are author checks. The broader MCP live-test gate remains unconfigured as described above.
- The existing 390px chart header can overflow horizontally; this is visible in the captures and outside this slice. The shelf reserves bottom spacing so its last entry clears the existing build stamp: 20.5625px overlap before, 27.4375px clearance after. Shelf entries and Other findings fit the narrow board. Detail captures make the new finding content readable; the existing ocular editor can still have fixed chrome over its narrow-screen content.
- Not done: collapse, Add to this visit search, coverage census/adapters (S2b-2); profiles (S3); Following strip, Since last visit, pull-forward sheet, Same today, or any new carried-finding write path (S5). SpineNav keeps its existing fail-open behavior.

NOT EVALUATED — hand to Claude Opus 5 for the independent evaluation before merge. Codex wrote the implementation and cannot supply its acceptance verdict.

needs-review
