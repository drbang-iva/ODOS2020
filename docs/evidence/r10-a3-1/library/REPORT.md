# A3.1 library author bundle

Status: implementation and focused author checks complete, no commit and no independent evaluation verdict. Parent retains endpoint/lifecycle integration, full suites and live proof; Claude Opus independently evaluates the final head.

## Files and APIs

- `mcp/src/clinical-graph/current-finding-identity.ts`: `ownsFact`, strict `FindingPanelKey`/`currentFindingPanelKeySchema`, `findingPanelIdentifier`, `findingPanelTargetId`, `parseFindingPanelEnvelope`, `FindingPanelState`, `normalizeFindingPanelState`, `findingPanelComponents`, `readFindingPanelState`; authentic audit content/set/instant matching; historical inactive owned fact resolution.
- `mcp/src/clinical-graph/current-finding-reader.ts`: inactive and signed fact readonly metadata; unique panel ownership, including retired duplicates; panel state/baseline/audit debt/integrity; retired panels expose baseline without values; panel-only definition views and typed values alongside live fact views.
- `mcp/src/clinical-graph/current-finding-writer.ts`: panel target kind through conditional create/update/replay/repair/revive/recovery; actor-bound strict reassertion audit witnesses; strict mutation audit create/recovery and mixed-result mismatch; selected-reference repair; known deleted vs unknown-write vs confirmed-write deleted outcomes; fresh direct read before replay success; ordinary signed fact/panel refusal.
- `diagnosis-findings-endpoint.ts`: library agent added the `ownsFact` import and ownership filter inside `materializeAtomicFindingCatalog` only. Parent owns every other change in this file.
- `mcp/tests/r10A3Library.test.ts`: 50 new tests (including parameterized cases).
- Existing reader/writer tests and one parent-authorized endpoint refresh fixture changed as mapped below.

`repairPendingAudits(deps, request, {targets: ['Observation/id']})` limits debt by target resource reference. Omission preserves broad repair. `classifyReplay` accepts `staffReference` on loaded state for reassertion matching. `PendingFindingAudits` remains Set-compatible and adds `mismatches: Set<string>`. Projection facts/panels expose `auditIntegrity: 'mismatch'`. Panel baseline is canonical `{kind, reference, versionId}`. Absent panel write baseline is `{kind:'absent',key}`. `findingPanelTargetId(key)` is the public target-id mechanic.

Signed-state correction requested by parent: §3.13 overrides the brief's preliminary/retired-only implication. Panel final/amended/corrected identities remain recognized, visible and readonly; ordinary fact/panel writers refuse them. Void retired owners remain reviveable in place.

## Actual checks and outputs

`mcp/node_modules/.bin/tsx --test mcp/tests/r10A3Library.test.ts mcp/tests/currentFindingReader.test.ts mcp/tests/currentFindingWriter.test.ts`

Final output (`docs/evidence/r10-a3-1/library/green.log`): **134 tests, 134 pass, 0 fail, 0 skipped, 0 todo**. Initial test-first batch `red.log`: 25 tests, 2 pass, 23 fail. Additional strict audit/inactive/definition checks `red-additional.log`: 40 tests, 36 pass, 4 fail. Recovery gap `red-recovery.log`: 46 tests, 44 pass, 2 fail. Signed lifecycle correction `red-signed-panels.log`: 3 tests, 0 pass, 3 fail. Panel test field names were corrected to the existing `CUSTOM_` schema before final assertions; no production validation was relaxed for the fixture.

`npm --prefix mcp run build`: exit 0, `tsc` no diagnostics (`library/build.log`). `git diff --check`: exit 0.

`mcp/node_modules/.bin/tsx --test --test-name-pattern 'W44 refresh' mcp/tests/diagnosisFindingsCommands.test.ts`: 1 test, 1 pass, 0 fail (`library/door-refresh-green.log`). Parent owns the full existing door suite rerun.

Mutation manifest `docs/evidence/r10-a3-1/library/mutations.json` uses exact unique anchors. `library/mutation-results.json` aggregates **14 guards, each red exit 1 then green exit 0**: W65, W71, W83, W84, W85, W92, W95, W106, W109, W110, W112, W115, W117, W128. W71 was rerun after the signed-state correction. Individual stdout is in `docs/evidence/r10-a3-1/mutations/library-W*-{red,green}.txt`. All mutated files were restored byte-exactly. No registry/source entry was added without guard evidence. The parent runner's top-level `mutations/results.json` retains only its latest invocation; use the library aggregate for these 14.

## Every existing assertion/fixture migration

Line numbers below are original baseline lines unless explicitly identified as new; tests otherwise stay intact. New assertions in `r10A3Library.test.ts` carry their W-row in each name.

| File:line | Before | After | Mapping |
|---|---|---|---|
| currentFindingReader.test.ts:168-171 | Panel fixture used identifier `panel`, no envelope, yet asserted deferred true | Same assertions; fixture uses hashed identity and strict R10_PANEL_META | W71 / V21 |
| currentFindingWriter.test.ts:348 | Supersession mismatch reason prior-audit-unrepaired | audit-mismatch; same zero-clinical-write/state-preservation assertions | W83 / V31 |
| currentFindingWriter.test.ts:360 | Forged reassert replay status refused | conflict plus explicit command-reused; audit/write count unchanged | W84 / V31 |
| currentFindingWriter.test.ts:393,406 | classifyReplay fixture omitted current actor | Supply writerContext staffReference; existing not/exact/reused assertions unchanged | W84 |
| currentFindingWriter.test.ts:433-436 | Provenance searches failed before any clinical write, implicitly assuming no pre-write replay lookup | Outage starts only after a clinical write, preserving asserted unconfirmed/confirmed/audit-lookup | W85 / W128 (additional known-deleted replay lookup) |
| currentFindingWriter.test.ts:457 | Lookup failure classification omitted actor | Supply current actor; same audit-lookup rejection assertion | W84 |
| currentFindingWriter.test.ts:506 | Changed-baseline replay classifier omitted actor | Supply current actor; same reused-with-different-content result | W84 |
| currentFindingWriter.test.ts:512,518-519 | Audit lacking command witness described/accepted as exact-key fallback; exact-replay before drift | Both tags required; renamed test and reused-with-different-content before drift; actor supplied | W84 / §3.9 |
| currentFindingWriter.test.ts:521 | Same malformed audit after source drift yielded not-replay | reused-with-different-content, since the original tagged record remains malformed | W84 / §3.9 |
| currentFindingWriter.test.ts:523 | Changed-baseline lookup with no witness and different operation key yielded not-replay | Unchanged; no matching record is discoverable under either key | W84 / §3.9 |
| diagnosisFindingsCommands.test.ts:66-67 | After first Provenance creation, all search types fail; expected second target refresh failure | Only Observation encounter refresh search fails; authenticity post-create Provenance check allowed. Same 502, first confirmed, second not-attempted/refresh assertions | W83 / W109 (new post-create authenticity check) |
| r10A3Library.test.ts:91 (new test adjusted during this task) | final panel asserted invalid from brief §3.3 status restriction | Removed from invalid cases; lines 111-116 assert final/amended/corrected recognized, readonly, visible values and ordinary writer refusal | W115 / §3.13 parent clarification |

No catalog-size, candidate-support, parity capture, existing section fixture or medical-code assertions were changed by the library agent. No medical terminology, artifact URL or regulatory fact introduced: no new Mandate 14 row needed. No business decisions or cross-repo files written. No Docker, policy/seed/builder/UI modifications, commit, PR, review verdict, or deployment performed by this agent.

## Guard scope and practical limitations

These are real library execution tests with a deterministic in-memory FHIR transport; they prove emitted writes, conditional headers, projection outcomes and failure classification, not server AccessPolicy. Parent's live-authz and synthetic-stack lane remains required. W65 here proves classification/catalog portion only; door behavior is parent-owned. W110 here proves reader debt and library repair; history/HTTP route behavior is parent-owned. W117 here proves panel-only definition views with typed values; candidate linkability and supportingFacts filtering is parent-owned. W114 caller sourcing remains parent-owned: pass effective stored definitions including inactive definitions into every consumer.

No outstanding implementation blocker in the bounded library scope at handback.

## Follow-up: W94 / W117 candidate fixture and numeric proof

Parent authorized exactly the W94/W117 candidate test in `r10A3DoorGuards.test.ts`. Root cause: the persisted custom finding definition retained `sourceStatus: verified-seed`; the store logged `Persisted finding definitions must have sourceStatus local-practice` and skipped it. The panel thus had no effective stored field definition and no candidate view. Corrected the fixture to `sourceStatus: local-practice`; no reader/candidate production fix was needed.

Assertion mapping: original `r10A3DoorGuards.test.ts:54-68` select-panel candidate assertions remain unchanged (candidate exists, no observationReference, row/candidate linkable false, no supportingFacts, zero writes). The fixture now represents a valid stored practice definition (W114, W94, W117). Added parallel select-with-live-owned-fact and real tear-film TBUT numeric-only cases, preserving every original expected behavior. Selected stored scalar option must not borrow support from a same-definition live owned fact; TBUT-only numeric mapping must appear with no evidence reference/support and linkable false.

`candidate-red.log`: 1 test failed at missing candidate row with the store warning. `candidate-green.log`: 3 cases, 3 pass. `door-guards-green.log`: full file 8 tests, 8 pass. `candidate-mutations.json` / `candidate-mutation-results.log`: two additional one-time guards red exit 1 / restored green exit 0, with unique anchors and byte-exact restoration:
- `library-W94-select-support`: remove option-field/option support filtering; the mixed select+fact candidate test fails.
- `library-W117-numeric-candidate`: remove panel-only definition view; the TBUT-only candidate test fails at the missing row.

Production files were only temporarily mutated for proof, then fully restored. This follow-up changed only the parent-authorized candidate test section and evidence/report files.

Additional parent-requested W93 guard: added an actual findings GET `searchIndex` test with an active shared select option, shared numeric value field, non-shared checkbox field and owned OD/OS positive controls. It proves only owned shared checkbox options reach the search index and emits zero writes. No existing assertion was removed. `search-index-mutations.json` removes only the catalog `ownsFact` filter; actual GET test goes red, restores green (`search-index-mutation-results.log`). Final full `r10A3DoorGuards.test.ts` output is **9 tests, 9 pass, 0 fail** in `door-guards-green.log`. Follow-up production sources remain unchanged after byte-exact mutation restoration.
