# R10 A3.1 §3.6 author evidence

Status: **AUTHOR COMPLETE — NOT EVALUATED**. Parent owns release integration and live authorization. No commits, live execution, containers, or §3.7 changes were made by this task.

## Behavior

Canonical facts and panels resolve by their identity key to the effective definition's stable key, section, and eye. Existing patient/encounter boundary filtering remains in the endpoint; the full scoped Observation snapshot, including retired records, feeds the shared reader's pre-rebuild classification. Closed requests refuse first, pre-rebuild encounters refuse409, selected signed canonical owners refuse422, and lookup outages return structured503. Preview never repairs or writes.

Void and undo repair actual writer audit debt only for selected canonical references. A failed repair returns503 with no lifecycle transaction. Status-only lifecycle writes retain resource/Encounter/ledger If-Match and existing lifecycle Provenance. A repair can create an earlier selected target's audit before a later repair fails; no rollback of those audit records is claimed.

Every nonempty void writes a generated UUIDv4 into its ledger slot and returns the same `voidActionId`. Undo requires that id; absent/malformed input returns400, and a mismatching, consumed or missing slot returns409 `undo-superseded`. Canonical ledger entries capture their operation command in `markerCommandId`. Undo compares all entries before repair and refuses the whole request if any command differs, listing superseded references.

The agreed representation is `markerCommandId: null` for a valid canonical owner without an operation marker and omitted `markerCommandId` for unrelated records. Null→command, command→different command, and command→null each supersede undo. Old persisted slots remain readable but cannot be undone using an invented action id. Unrelated prior-status and already-restored skip behavior remain intact.

## Files

- `mcp/src/clinical-graph/encounter-void-endpoint.ts`
- `mcp/src/clinical-graph/encounter-undo-endpoint.ts`
- `mcp/src/clinical-graph/encounter-undo-ledger-store.ts`
- `mcp/tests/encounterVoidFixture.ts`
- `mcp/tests/encounterVoidEndpoint.test.ts`
- `mcp/tests/encounterUndoEndpoint.test.ts`
- `mcp/tests/encounterUndoLedgerAuthzLive.test.ts` — only the two valid undo requests now supply their persisted action ids.
- `mcp/tests/r10A3VoidUndo.test.ts`

No library writer, matcher, route/index, definition seeds, UI, roles or policies were changed.

## Verification

Initial focused run: **31 tests, 8 existing controls passed, 23 failed** before implementation. Separate lookup-outage probes: **2 failed before the structured failure handling, then 2 passed**. Raw output is in `initial-red.tap`, `lookup-red.tap`, and `lookup-green.tap`.

Final scoped command:

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/r10A3VoidUndo.test.ts mcp/tests/encounterVoidEndpoint.test.ts mcp/tests/encounterUndoEndpoint.test.ts mcp/tests/encounterUndoLedgerStore.test.ts mcp/tests/encounterVoidTransactionFailure.test.ts mcp/tests/encounterVoidRoutes.test.ts mcp/tests/currentFindingReader.test.ts mcp/tests/currentFindingWriter.test.ts
```

Result: **221 tests, 221 pass, 0 fail, 0 skipped** (`scoped-regressions.tap`). This includes **41 focused lifecycle tests**, unchanged old guard10 prior-status restoration checks, adversarial foreign-scope fixtures, and the existing transaction/route failure tests.

`npm --prefix mcp run build`: **exit0**, TypeScript compilation completed (`mcp-build.log`). Owned-file `git diff --check`: **exit0**.

Mutation command:

```sh
node docs/evidence/r10-a3-1/run-mutations.mjs docs/evidence/r10-a3-1/void-undo/mutations.json
```

All **20 variants** failed under mutation and passed after restoration: W76; W77 void, undo, preview; W78 void and undo; W105 comparison and ledger capture; W106 void and undo; W114; W127 action, missing-id schema, response identity; plus pre-rebuild, closed, and structured lookup variants for each endpoint. Exact unique anchors and designated test patterns are in `mutations.json`; preserved results in `mutation-results.json`; raw output in sibling `mutations/lifecycle-*-red.txt` and `*-green.txt`. The runner verified byte restoration for every variant before source was released to parent. Parent subsequently owns additional named release T10–T14 integration and reruns; those are separate evidence.

## Assertion migration

AST inventory covered **648 original assertions** in the seven scoped existing fixture/test files. **642 remain literal-identical**. **Six literal changes** are individually mapped to V36/W127: exact slot shape adds action identity, consumed/absent-slot responses become409, and the unknown-Encounter request supplies a valid action id so its original404 boundary remains reached.

Another **16 literal-retained assertions** have explicit V26/W76 fixture mappings: the section-prefix test and guard7 retain original count/sibling checks while shared legacy cornea/lens snapshots become realistic canonical fixtures. Total ledger: **22 exact before/after rows, zero unmapped changes**. See `assertion-migrations.json` and `assertion-ledger-check.json`. Real seed definitions replace the fixture's empty schemas; original nonshared definition keys, sections and display labels were verified equal.

## Limits and follow-up

These tests exercise real library/handler behavior over a permissive in-memory FHIR fixture. They do not prove live AccessPolicy enforcement or server transaction atomicity. Parent owns the credentialed synthetic-stack §7 lane and release checks. Existing transaction partial-failure behavior remains as documented and tested. The UI must supply the new action id in A3.2; no UI implementation is claimed here.

Independent Fable/Opus evaluation remains required before merge. This is implementation evidence, not an independent verdict.
