# §3.5 carry author evidence — contract rev2.4

Status: implementation and author checks complete; no independent evaluation performed. No commit or evaluation marker created. Worktree `r10-a3-1`, branch `drbang-iva/r10-a3-1`. Only the five files listed in `source-hashes.json` were changed for this carry assignment, plus this evidence and private work logs. Parent owns release scenarios and downstream integration.

Carry now persists a conditional diagnosis owner, frozen plan, guarded Encounter link, canonical fact writer command and version witness as standalone steps. Identical commands resume their stored plan; distinct commands share diagnosis identity; partial carries retain explicit confirmed state. Replan uses a new command and the same diagnosis. Step 5 accepts `applied`, `already-applied` and `unchanged` only with a confirmed reference/version and no pending audit. Later lifecycle versions remain edited, including void followed by undo before the witness is written. Completed retries preserve the original witness. Previous exams use canonical homes and effective stored definitions, with legacy evidence confined to pre-rebuild read-only encounters.

## Checks and exact output

- `mcp/node_modules/.bin/tsx --test mcp/tests/diagnosisCarryForward.test.ts mcp/tests/r10A3Carry.test.ts`: **158 tests; 157 pass; 0 fail; 1 skip**. The skipped case is the embedded credential-dependent live test. `focused-final.txt`.
- Private own-stack launcher with `tests/diagnosisCarryForward.test.ts`: **128 tests; 128 pass; 0 fail; 0 skip**. `live-final.txt`. This actually executed the ordinary-clinician policy and persistence test against the parent's isolated synthetic local stack, including 403 policy probe, real canonical persistence, a forced Encounter version conflict, retained Condition/plan and retry completion. No new stack was created; credentials are absent from evidence.
- `npm --prefix mcp run build`: exit **0**, TypeScript `tsc`. `build-final.txt`.
- `git diff --check` on the five owned source/test files: exit **0**.
- Initial TDD: `carry-new-red.txt` records **14 failures, 0 passes** before implementation; additional completed-witness, replan-resend, Step-5 unsafe-unchanged and boundary controls were written and observed red before their fixes. Their red logs are retained beside the final combined green.
- Strict mutation runner checks each anchor occurs exactly once, restores exact bytes in `finally`, runs the same command against restored code and checks byte equality. **18/18 guards failed through assertion errors and returned green after restoration.** Every red log was inspected for behavioral assertions; no syntax/import failure served as a kill. Exact edits and commands: `mutations.json`; machine results and full TAP: `mutations/`. Run from the worktree root: `node docs/evidence/r10-a3-1/carry/run-mutations.mjs docs/evidence/r10-a3-1/carry/mutations.json`.

| Guard | Mutated run | Restored run |
|---|---:|---:|
| carry-W73-homes | 2 failed | 2 passed, 0 failed |
| carry-W74-canonical | 4 failed | 4 passed, 0 failed |
| carry-W75-version | 4 failed | 6 passed, 0 failed |
| carry-W79-prebuild | 2 failed | 3 passed, 0 failed |
| carry-W91-closed | 1 failed | 3 passed, 0 failed |
| carry-W101-conditional | 2 failed | 3 passed, 0 failed |
| carry-W102-fingerprint | 1 failed | 1 passed, 0 failed |
| carry-W103-frozen | 1 failed | 1 passed, 0 failed |
| carry-W104-partial-witness | 1 failed | 1 passed, 0 failed |
| carry-W113-both-eyes | 1 failed | 1 passed, 0 failed |
| carry-W114-stored | 1 failed | 1 passed, 0 failed |
| carry-W123-command-independent | 1 failed | 1 passed, 0 failed |
| carry-W124-resume | 27 failed | 32 passed, 0 failed |
| carry-W125-replan | 1 failed | 1 passed, 0 failed |
| carry-W125-unchanged | 1 failed | 1 passed, 0 failed |
| carry-W125-audit | 1 failed | 1 passed, 0 failed |
| carry-W125-missing-version | 1 failed | 1 passed, 0 failed |
| carry-W126-writer-version | 2 failed | 2 passed, 0 failed |

W73/W74/W75 commands include the parent's release T1/T2/T3. W74 also directly kills the migrated legacy happy-path and retired-source controls. W124 also runs all 30 migrated phase/status cases: all 25 failures after Condition creation are caught, while the five Step-1 failures still pass (plus two new resume cases fail). This distinguishes actual guard sensitivity from unrelated red tests. The final runner restored source bytes; `source-hashes.json` seals the resulting owned files.

## Assertion migration ledger

`assertion-ledger.json` inventories exact TypeScript assertion calls before and after, including test titles and line numbers. **322 before; 345 after; 195 unchanged; 127 changed/removed mapped; 150 added/replacement; 0 unmapped.** Every changed/removed assertion has explicit V/W rows, rationale and after-assertion IDs resolving to exact replacement text. Multiple old transaction-shape assertions map to a fully enumerated new boundary assertion block when the literal standalone contract removes that representation. No clinical code, laterality, diagnosis identity, rank, source scope or lineage assertion was dropped without replacement.

The old atomic transaction/privileged rollback contract is explicitly replaced by §3.5's five standalone steps (V25/V36; W101–104/W123–125). Thirty phase/status controls cover Condition, plan, link, fact, audit and findings witness at 403/409/412/500/503. Each verifies non-success, exact retained Condition state, no completed witness and no privileged compensation, followed by identical-command completion. Four malformed conditional-create response controls recover only an independently read exact owner; six malformed owner-query controls refuse with zero writes. Existing wrong-patient and wrong-Encounter source tests still refuse with zero writes; fixtures now inject invalid canonical rows through the real scoped reader dependency, rather than trusting obsolete `Condition.evidence` or letting the fake pre-filter the wrong row.

Fixture migration: each carry request has UUIDv4 commandId; ordinary writable destination is in-progress with a real version; canonical source facts have exact patient/encounter/eye metadata and diagnosis homes; the fake implements actual conditional create and If-Match update persistence. Source present and absent live facts both carry. Retired owners remain hidden. Existing legacy lineage-only fixture tests explicitly declare `preRebuild: true`. The embedded live test was migrated and executed, not skipped or retired; its cleanup includes plans, audits and witness Provenance.

## Public integration points and limits

`carryPlansForCondition`, `carryCommandPlan`, `parseCarryPlan`, `carryFindingsWitness` and `carryOutcomeVersions` expose validated plan/witness mechanics. `readDiagnosisCarryState` accepts an explicit `preRebuild` context override; without one it loads effective full encounter state when the client supplies `baseUrl`. Plan clinical content can support later completeness work, but `edited: true` alone is not proof of fresh charting (link/void/undo also advance versions). The reusable test harness exports `fixture`, `request`, `pull`, `carried`, `conditions`, `plans`, `witnesses`, `planValue` and `versionValue`, without registering tests on import.

The optional injected `writeFindings` dependency defaults to the real writer. Two unsafe-unchanged route controls wrap real writer results only to produce the otherwise unreachable missing-version/audit-pending outcomes, and assert no witness plus `lineageStep: not-attempted`. W126 wraps the same real writer to inject a lifecycle version change between its return and Step 5; witness values remain the writer-confirmed versions. No production validation is relaxed for these seams.

No policy, seed, builder, UI, medical terminology or decision file was changed by this carry assignment. Native carry identifiers/extensions implement the supplied rev2.4 contract; clinical fixtures reuse existing seeded terminology. Parent retains ownership of global Mandate 14/decision records, full-suite/runtime T22 integration, commits and independent Claude evaluation. These checks establish the scoped author evidence only; they do not constitute an evaluator verdict or a claim that all downstream consumers have migrated.
