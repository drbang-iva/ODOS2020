# AVFILL-1 — fabricated A/V ratio

Base: `178791bdd61880dc093b5cff2d9eed6735ef5d24`. Branch: `drbang-iva/av-ratio-default`.

Saving Vessels used to supply an unentered A/V ratio and the control displayed 2:3 without a blank choice. The fix deletes `defaultGradeValue` entirely: an unentered grade remains the empty string, every grade selector offers Select, and the existing save filter omits the empty value. An explicitly chosen 2:3 still emits `2-3`, its unchanged option code. No other grade behavior, option, definition, negative-act contract, or DONE-1 feature changes.

Files: `ui/src/components/charting/OcularHealthSection.tsx`, `ui/tests/customSections.test.tsx`, and this evidence directory. No new decision was made: the existing private canonical AVFILL-1 decision and user kickoff authorize this correction; no decisions/INDEX.md update. No medical terminology changes or Mandate 14 ledger rows.

## Mandate 17

Commands run from `ui/`. Each command's exit status was captured separately, with no output pipeline hiding it.

Restored the complete original production file (including the default), ran:

`node --import tsx --test --test-name-pattern='AVFILL-1|posterior seeded history' tests/customSections.test.tsx`

[Verbatim RED](default-red.log): exit 1, 5 tests, 1 pass, 4 fail. The three omission/blank guards fail and the updated pre-existing blank-control count fails; deliberately choosing 2:3 still passes.

Restored the fix, then temporarily changed the save path to discard *every* A/V ratio, including selected values:

`node --import tsx --test --test-name-pattern='AVFILL-1 deliberate' tests/customSections.test.tsx`

[Verbatim RED](drop-choice-red.log): exit 1, 1 test, 0 pass, 1 fail.

Restored the fix and reran all five affected tests: [verbatim GREEN](restored-green.log), exit 0, 5 tests, 5 pass, 0 fail.

The four requested demonstrations, using verbatim test result lines:

1. Unentered normal: `not ok 3 - AVFILL-1 unentered normal does not invent an A/V ratio` → `ok 3 - AVFILL-1 unentered normal does not invent an A/V ratio`. The original path emits `{ code: 'CUSTOM_GRADE_A_V_RATIO', value: '2-3' }` instead of `[]` when clearing an existing abnormal finding and saving normal without touching the ratio.
2. Deliberate choice: `not ok 1 - AVFILL-1 deliberate 2:3 choice persists and does not POST again while pristine` → `ok 2 - AVFILL-1 deliberate 2:3 choice persists and does not POST again while pristine`. The discard-all mutation emits `[]` instead of the explicitly chosen field. The guard also requires no OS rewrite and no second POST while pristine.
3. Blank option: `not ok 4 - AVFILL-1 blank control does not invent an A/V ratio` → `ok 4 - AVFILL-1 blank control does not invent an A/V ratio`. Original actual `'2-3'` differs from expected `''`; the fixed control exposes `{ value: '', label: 'Select' }` for both eyes.
4. Fundus All Normal: `not ok 5 - AVFILL-1 Fundus All Normal does not invent an A/V ratio` → `ok 5 - AVFILL-1 Fundus All Normal does not invent an A/V ratio`. Five requests, ten eyes, each normal with an explicit negative act and no custom grade values.

The tests inspect actual component-generated requests at the fetch boundary, not a reimplemented save function. Additional Chrome proof invokes the real capture endpoint and checks the resulting Observation components with in-memory FHIR writes.

## Browser evidence

[Before](before.png) / [After](after.png) show the same Vessels surface, production seed definitions, synthetic empty history, and 1440×1000 viewport. Separate base and proposed worktrees were served on task-owned loopback ports 15281/15282 with strictPort; both servers close at the end. Images were inspected.

Reproduce from the proposed repository root:

`AVFILL_BASE_ROOT=/absolute/path/to/base-worktree node --import tsx docs/build-log/avfill-1/browser-proof.mjs`

[Script](browser-proof.mjs), [output](browser.log). Before: two A/V components after five structures/ten eyes are swept and saved. After: zero. Explicitly selecting 2:3 afterward emits one OD component with code `OD_CUSTOM_GRADE_A_V_RATIO` and valueCodeableConcept coding `2-3` / display `2:3`; OS is not rewritten.

This uses the actual OcularHealthSection, generated production definitions, and real capture endpoint, with a synthetic in-memory FHIR boundary. It does **not** claim full application-route wiring, live persistence, role enforcement, or deployed-artifact proof. No backend or route wiring changes in this PR.

## Persisted-data census — read only

[SQL](census.sql), [verbatim output](census.log), exit 0. Executed against the already-running local synthetic `odos-history-1d5-postgres-1` database `medplum`, in a READ ONLY transaction followed by ROLLBACK. No migration, deletion, backfill, seed, or clinical record write was performed by the census.

- Current rows / parseable current Observations: **6,144 / 6,144**.
- Deleted rows: **10**; excluded from the current-resource census. Resource version history is not included.
- Carrying A/V ratio: **0**.
- Of those, carrying the default value: **0**.
- Positive control, existing exact `SPHERE` component: **4** Observations, using the same component/coding traversal.
- Positive control, any component: **12** Observations; any custom component, including eye-prefixed codes: **0**.
- Negative control, impossible `AVFILL_IMPOSSIBLE_739604ae` component: **0**.

The query covers unprefixed, OD-prefixed, and OS-prefixed A/V codes and both coded and string `2-3`/`2:3` representations. Its first draft failed on blank deleted content; the final query counts deleted rows separately and verifies all current rows are parseable.

**This sample has no custom-component data and licenses no conclusion about other installations.** The configured root installation at localhost:8103 had no listener; its exposure remains unverified. These counts describe the reachable synthetic stack, not the separately deployed box mentioned in the kickoff. Stored 2:3 cannot distinguish a fabricated default from a genuine measurement; nothing recorded the choice. No retrospective classification is possible from that value alone.

## Report, do not fix

Read-only scan findings at the base SHA, left unchanged:

- `ui/src/components/charting/IopSection.tsx:115-120` selects the first active method into both eyes; `:472` sends that method when a pressure is entered and saved. The pressure itself remains blank. Method can therefore be recorded without choosing it.
- `ui/src/components/charting/VaSection.tsx:31-34` initializes chartType SNELLEN and correction SC; `:68-72` includes them when an acuity value is entered and saved, even if those metadata controls were untouched.
- `ui/src/components/charting/MyopiaManagementSection.tsx:39-40` initializes concentration/frequency; `:132-140` sends them on the explicit add-atropine action. This is a treatment-action default, reported for separate review rather than adjudicated as a fabricated measurement here.
- `ui/src/components/charting/DryEyeSection.tsx:76` initializes the first product; `:224-238` records it on explicit add-product with default dosage text. Same separate-review limitation.

`CustomFindingSection.tsx:221` displays a field default but `:455-466` serializes only entered values; it is not evidence of a saved default. Cup/disc, refraction, and wearing numeric controls use picker centering values with empty capture state; a defaultValue prop alone is not proof of a fabricated measurement. This was a bounded source scan, not an exhaustive audit of all charting workflows.

## Checks and status

| Command | Result | Output |
|---|---|---|
| `npm --prefix ui test` | exit 0; 1,308 tests, 1,308 pass, 0 fail, 0 skipped | [UI](ui-suite.log) |
| `ODOS_POSTGRES_URL=<task-owned loopback PostgreSQL> ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` | exit 0; 4,384 tests, 4,339 pass, 0 fail, 45 skipped | [MCP](mcp-suite-configured.log) |
| `cd ui && ./node_modules/.bin/tsc --noEmit --skipLibCheck` | exit 0; no diagnostics | [UI types](ui-typecheck.log) |
| `cd mcp && ./node_modules/.bin/tsc --noEmit` | exit 0; no diagnostics | [MCP types](mcp-typecheck.log) |
| `npm run typecheck:scripts` | exit 0; no diagnostics | [Script types](scripts-typecheck.log) |
| `npm run preflight` | exit 0; 0 warnings, 0 hard blocks | [Preflight](preflight.log) |
| `git diff --check` | exit 0 | No diagnostics |

The initial unconfigured MCP run exited 1: 4,322 pass, 6 fail, 57 skipped. All six failures were connection-refused hooks for unavailable PostgreSQL on 5433. A disposable task-owned PostgreSQL container on loopback 15947 resolved that setup failure. The configured rerun explicitly acknowledges unconfigured live-stack tests: 41 of the 45 skips are live tests, including authorization; this does not gate live authz. [Initial failure excerpt](mcp-suite.log).

One UI rerun had an unrelated ROS browser timeout (1,307 pass / 1 fail). [Failure excerpt](ui-timeout.log); the isolated ROS file retry passed 3/3, exit 0, [output](ros-browser-retry.log). The initial UI pass before adjusting the existing blank-count assertion also reported 1,307 pass / 1 fail (expected 10 blank controls, now 12); the revised count is included in the mutation evidence. Full-suite logs retain verbatim terminal summaries; complete raw local outputs are retained in `/tmp/avfill-*-full.log`.

No independently evaluated or deployed status is implied. Independent Fable/Opus evaluation at the exact PR head is required. The author has not posted an evaluation marker or operator override. No merge or deployment performed; DONE-1 remains blocked pending this slice landing.
