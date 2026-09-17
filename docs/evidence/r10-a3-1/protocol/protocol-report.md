# §3.8 author implementation checkpoint — source released

Production files: mcp/src/clinical-graph/protocol-service.ts and protocol-endpoint.ts. New tests r10A3Protocols.test.ts and test-only fixtures/r10/protocol-harness.ts. Existing T19 block/imports updated; dryEyeInitiationProtocols.test.ts fixture gains missing Encounter. No other release blocks modified, no new production files/schema/policies/seed changes, no commits or live execution.

Prevalidation resolves real stored definitions, checks closed/preRebuild state, and rejects selected valued shared definitions before built-in seeding/application/proposed-item writes. It accounts for defaults, per-eye values, overrides, and inherited proposed values so a prompt override cannot hide a valued shared item. Opted-out items and truly prompt-only shared items remain allowed. Service mutation callbacks recheck open/commit/add/unapply; actual commitFinding/materialize/remove/restore paths retain guards. Unapply scans all target references before any write. Restore checks current Encounter/reader and target identity at invocation; 409/422 survives compensation error handling.

Capture consumes reader canonical facts and panels with values regardless of preliminary/final/amended status; folds committed no-Observation prompts, dedupes by shared stableKey, unions OD/OS, preserves explicit bilateral source prompts, emits promptOnly/no defaultValue. Cleared/inactive/context-only rows do not seed. Nonshared value/action/charge behavior remains unchanged.

Focused first red:16 tests,3 pass13 fail. Additional rollback red:22 tests,19 pass3 fail; bilateral-source eye red:27 tests,26 pass1 fail; inherited-value red:28 tests,27 pass1 fail. Final29/29. Existing dryEyeProtocols + dryEyeInitiationProtocols + procedureChargeMaterialization30/30. T19 1/1. Final combined §3.7/§3.8 focused+regressions126/126, release T7/T8/T9/T19 4/4, build exit0; no skip/todo in selected runs. Logs overview-protocol-final.tap / overview-protocol-release.tap / overview-protocol-build.txt.

14/14 source mutations red then restored29/29 each: W82 valued/preseed/original-payload; W91 closed; W108 prebuild/unapply-preflight/restore; V28 shared-removal/cleared/inactive; T22 actual restore; W107 eyes; W119 panel; W114 stored definitions. Exact recipes protocol-mutations.py, result protocol-mutation-results.json, per mutation red/green TAP. overview-protocol-mutations.json records all23 mutations with counts and failing test names. Source restored byte-exact after each mutation.

The new inactive fixture initially inserted duplicate persisted definitions, allowing nondeterministic store duplicate resolution. Corrected fixture to call real FhirFindingDefinitionStore.deactivate and repeated all14 protocol mutations successfully. Same no-seed assertion; no production workaround.

## Exact existing assertion/fixture ledger

- mcp/tests/r10A3ReleaseScenarios.test.ts:98 T7 — todo removed; expected `[Observation/fact]` unchanged (V27).
- same file:102 T8 — real stored-definition fixture replaces shared context injection; status200 and extension-home diagnosis assertion unchanged; todo removed (W80).
- same file:108 T9 — private raw predicate/misspelled entry fixture replaced with real stored catalog handler; same live=true, cleared=false behavior assertions; todo removed (W81/V27).
- same file:171 T19 — real capture handler and stored-definition fixture replace direct service raw input; expected finding count1 unchanged; adds promptOnly and OD-eye assertions; todo removed (V28/W107/W119).
- mcp/tests/examOverviewProjection.test.ts:514,526 — invented cornea definition/raw normal record replaced with real lens seed and canonical explicit absent fact; original complete and 6/6 assertions unchanged (V27/W81).
- mcp/tests/dryEyeInitiationProtocols.test.ts:379 — add in-progress Encounter for real newly enforced boundary; all original assertions unchanged (V24/W91).
- No parity capture/divergence edit; no other existing assertion changed.

## Stable test-only T22 reuse

`protocolFixture(items?)` supplies a real saved ProtocolDefinition, stored finding definition, synthetic scoped Encounter/Condition, counted FHIR adapter, and real `apply`, `capture`, `unapply` handler calls. `findingItem(key,value?)` builds protocol inputs. `protocolRollbackFixture(mode)` returns `original`, `applicationId`, and `run()`:

- mode restore: actual unapply removes an unrelated Observation; intentional Basic finding-state failure triggers real If-Match restoration; run rejects with injected failure. This is fault-triggered compensation evidence, not a successful request.
- closed/pre-rebuild/shared: after first Observation removal the test changes state, then fails Basic persistence; actual restoration is refused with409/422 and no second Observation write.
- raw writes record attempted resource/method/headers; resources map records persisted state. Synthetic only; no credentials in fixtures. Diagnosis code derives from the existing stored catalog seed shape, no new clinical literal.

Status: AUTHOR PROOF ONLY. §7 remains unexecuted by this agent. Parent owns §3.11/full suite scheduling and independent evaluation handoff.
