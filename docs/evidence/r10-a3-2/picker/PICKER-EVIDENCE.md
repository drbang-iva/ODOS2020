# A3.2 shared supported pick and Ocular picker evidence

NOT EVALUATED. Author implementation checks only; no commit or merge performed by this subtask.

## Implementation

- Added `ui/src/lib/supported-diagnosis-pick.ts`: extracted existing Condition pick → scope/bodySite → link sequence. `supportedFindingLink` also extracts the existing support-baseline link builder.
- `DiagnosisWorkspace.tsx` changes are extraction only; original workspace test assertions remain untouched. First caller extracted and checked before adding second caller.
- `DiagnosisPicker.tsx` adds explicit `linkMode="facts"` branch. Default renderer retains legacy behavior. Canonical branch loads projection keys; reads proposed status from homes, merges supports per diagnosis for actions, derives scope from support eyes, uses shared ordered sequence and preserves identical pending link for Finish linking. Scope identity blocks late pick responses from continuing scope/link after changing visit.
- `OcularHealthSection.tsx` mounts facts picker from present projected facts without requiring one snapshot Observation id.

## Check results

- `workspace-before.txt`: tests 22, pass 22, fail 0, skipped 0, todo 0.
- `workspace-extracted.txt`: tests 22, pass 22, fail 0, skipped 0, todo 0.
- `initial-red.txt`: tests 3, pass 0, fail 3, skipped 0, todo 0.
- `green.txt`: tests 25, pass 25, fail 0, skipped 0, todo 0.
- `W51-green.txt`: tests 2, pass 2, fail 0, skipped 0, todo 0.
- `integration.txt`: tests 68, pass 68, fail 0, skipped 0, todo 0.
- `final-focused.txt`: tests 101, pass 101, fail 0, skipped 0, todo 0.
- `carried-suggestions.txt`: tests 2, pass 2, fail 0, skipped 0, todo 0.
- `exam1b-green.txt`: tests 6, pass 6, fail 0, skipped 0, todo 0.
- `sweep-editor-green.txt`: tests 21, pass 21, fail 0, skipped 0, todo 0.
- `scope-change-red.txt`: tests 1, pass 0, fail 1, skipped 0, todo 0.
- `scope-change-green.txt`: tests 28, pass 28, fail 0, skipped 0, todo 0.
- UI `tsc --noEmit --skipLibCheck`: exit 0; `typecheck.txt` empty, no errors.

## Mutations

Exact replacement anchor count was asserted; misses raised an exception. Every mutation restored source in finally; restored suite executed.

- `W139-picker-red.txt`: tests 3, pass 2, fail 1, skipped 0, todo 0.
- `W139-restored-green.txt`: tests 25, pass 25, fail 0, skipped 0, todo 0.
- `W140-supports-picker-red.txt`: tests 3, pass 1, fail 2, skipped 0, todo 0.
- `W140-supports-restored-green.txt`: tests 25, pass 25, fail 0, skipped 0, todo 0.
- `W140-shared-scope-picker-red.txt`: tests 3, pass 1, fail 2, skipped 0, todo 0.
- `W140-shared-scope-workspace-red.txt`: tests 22, pass 20, fail 2, skipped 0, todo 0.
- `W140-shared-scope-restored-green.txt`: tests 25, pass 25, fail 0, skipped 0, todo 0.
- `blank-panel-red.txt`: tests 16, pass 15, fail 1, skipped 0, todo 0.
- `offered-selection-red.txt`: tests 16, pass 15, fail 1, skipped 0, todo 0.
- `panel-offered-restored-green.txt`: tests 16, pass 16, fail 0, skipped 0, todo 0.

The W140 shared scope mutation disables bodySite execution in the extracted helper. Both consumers independently fail their existing/new ordered pick→scope→link assertions. W139 substitutes Condition.evidence for canonical homes and fails contradictory-evidence assertion. W140 support mutation sends only clicked candidate support instead of union and fails two-eye assertion.

## Assertion changes and contract rows

| Test | Before | After | Contract |
|---|---|---|
| Existing workspace tests | Existing behaviors/assertions | Unchanged; 22/22 focused and 53/53 general | Extraction-only ruling |
| New picker proposed test | None | OD home linked with contradictory OS Condition.evidence still marks OD proposed only | W139 / T16 |
| New picker action tests | None | OD+OS supports merged; pick before PATCH before link; scope error forbids link; one commandId reused | W140 / T17 |
| New legacy tests | None | CVF/Refraction actions omit commandId and supportingFacts; prior W51 tests cover default ocular and Cup/Disc | W51 |
| New scope-change test | None | Late pick response after visit switch does not PATCH Condition or link | W140 boundary |
| customSections saved-findings proposal | Snapshot findingInstanceId request | Canonical UUID/support key+baseline/laterality request; successful link adds Condition home. Explicit-only propose/retract assertions unchanged | W139/W140 / V18 |
| customSections fresh history | Initial legacy snapshot save and saved snapshot Observation id | Real handler offered baseline→canonical fact save200→fresh canonical row baseline reference; no-write remount and suggestion text assertions unchanged | V18 / W130 / W139 |
| New blank text/offered test | None | Blank other/remarks omitted; checked offered row becomes one new assertion with absent baseline and empty homes | W136/W137 |

## Integration defects repaired

- Real sweep rejected blank optional panel strings: serializer now omits trimmed blank Other/Remarks.
- Actual reader wraps negative acts as `{scope,status,...}`: hydration unwraps live scope; no legacy bare-act assumption.
- Multi-definition refresh previously consumed a one-time choice-preservation flag, dropping remaining unsaved structures: same-identity hydration merges pending deltas consistently.
- Parent completion now waits for no failures/no unsent edits, retains successes across partial attempts, labels failures by structure, retries only failed segment and preserves newer in-flight changes. Existing EXAM-1B six tests green without weakening assertions.
- Saved historical negative acts survive panel edits; unsaved drafted acts are removed when edited.
- Restored visible N/N saved summary used by existing entry-sheet browser proof.

## Remaining validation

Root owns full-suite, release checker, served-route harness/screenshots, PR/CI and independent evaluator handoff. No Docker containers were started by this subtask. All source mutations are restored.
