# Rev 2.6 reader fixture assertion ledger

Coder changes only; NOT EVALUATED. Before files preserved privately at `.odos/r10-a3-1/rev26-reader-checkpoint/`. Original `legacy-baseline.json` and all five `parity-divergences.json` entries remain unchanged. No production changes, UI, policies, auth, commits or verdicts in this bounded task.

| Before file:line | After file:line | Exact expectation/fixture delta | Contract |
|---|---|---|---|
| `mcp/tests/currentFindingIdentity.test.ts:56` | same file:57–59 | Identifier-only `{system:urn:odos:finding-panel:v1,value:panel}` was `panel-context`; now `invalid`. Added positive control with exact panel hash and `R10_PANEL_META`, expected `panel-context`. | W71; §3.3 |
| `mcp/tests/currentFindingIdentity.test.ts:82` and `fixtures/r10/field-identities.json:55–56,80,145–147` | identity test:85 and fixture:55–56,80,145–147 | Full structural equality unchanged. Tear-film select-method and anterior-chamber select-grade sample IDs replaced with owned checkbox samples; vessels select-ratio samples replaced with owned checkbox samples. Other field identities and samples unchanged. Exact six before/after entries in `field-identities-delta.json`. | V32 / W93; §3.1 |
| `mcp/tests/currentFindingIdentity.test.ts:102–103` | same file:105–106 | Audit fixture previously tag + target only; now includes actor `Practitioner/test`, CREATE activity using existing exported code-system constant, and `2026-09-15T13:00:00Z`. Expected pending list remains exactly `[Observation/two]`. Timestamp intentionally equivalent to marker `.000Z`. | W83; §3.9 |
| `mcp/tests/currentFindingIdentity.test.ts:120–121` | same file:123–124 | Copied-marker audit fixture now includes original marker actor/time and CREATE activity; expected pending list remains exactly `[Observation/second]`. | W83; §3.9 |
| `mcp/tests/findingSectionHelpers.test.ts:15` | same file:16–35 | Nonshared captures retain exact full JSON equality (line17). Shared captures retain exact old `rows` unless negative-only, whose rows now `[]` and whose negative reference is pinned in `eyes[eye].negativeActs` (line33). Shared results additionally assert encounter references, pre-rebuild read-only flags, eye/panel/fact editability. Synthetic transport gains scoped Encounter read and resource-type-correct searches; original captured resources unchanged. | V18, V23, V21 / W-j; §3.4 |
| `mcp/tests/r10-parity.test.ts:68` | same file:69 | Eight overview captures 3,4,5,6,7,8,9,66 compare to explicit additive `a3-overview-expectations.json`; all others compare to unchanged legacy captures. Every changed leaf is recorded before/after in `overview-expectation-delta.json`. Legacy rows now have `creditsCompleteness:false`; old aliases/duplicate components normalize through the current reader. | V27; §3.7 |
| `mcp/tests/r10-parity.test.ts:72` | same file:73 | Projected-overview comparison uses the same reviewed expected overview above; existing five divergence records and their hashes remain identical. | V27; §3.7 |

Overview delta review: 35 changed leaves; 11 added completeness flags and 24 alias/qualifier component display changes. Fixture 4 translates brunescent to nuclear-sclerosis + colour, preserves grade and merges duplicate nuclear components. Fixtures 5/6 translate horseshoe-tear to retinal-tear + subtype. Fixture 8 translates legacy iron-line alias; fixture 9 translates legacy macular-hole alias. These are the same reader normalization now consumed by overview, as required by §3.7. Original captured clinical resources, dates, IDs and codes have not been changed.

No synthetic FHIR URL or medical terminology was introduced: audit activity uses the existing exported constant; new expectation fixture copies existing captured terminology/display values only. No new decision or Mandate 14 verification claim.

## Verification

Same focused command before/after from `mcp/`:

`node --import tsx --test tests/currentFindingIdentity.test.ts tests/findingSectionHelpers.test.ts tests/r10-parity.test.ts`

- Before: 250 tests, 201 pass, 49 fail, zero skip/TODO (`red.txt`).
- After: 250 tests, 250 pass, zero fail/skip/TODO (`green.txt`). The separate premise replay fixture repair and its assertion ledger are owned by the parent task's replay lane.
- W71 mutation returns `panel-context` for invalid envelope: identity 17 pass / 1 fail.
- W93 mutation removes catalog `ownsFact` filter: identity 17 pass / 1 fail.
- V23 mutation makes shared history editable regardless of pre-rebuild: history 26 pass / 36 fail.
- V27 mutation credits every shared overview row: legacy parity fixtures 160 pass / 8 fail.
- Restored identity + history: 80/80. Restored legacy parity fixtures: 168/168. The mutation parity command uses `--test-name-pattern='^legacy fixture'` solely to exclude the then-pending replay; final command above has no filter.
- All four production mutations were sequential, with root-coordinated exclusive test window; all source bytes restored, with SHA-256 checks in `mutations.json`. No production change retained.
- Scoped `git diff --check` succeeds. No commit created.
