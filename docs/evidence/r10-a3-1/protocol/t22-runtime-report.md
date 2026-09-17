# T22 protocol runtime helper

`mcp/tests/fixtures/r10/protocol-write-paths.ts` exports `runProtocolWritePaths()` and registers no tests. It invokes the actual exported apply/unapply handlers through protocol-harness and the shared write-path-recorder. Effective definitions come from the real FhirFindingDefinitionStore. Every attempted/persisted Observation is classified and required to be unrelated; protocol paths emit no Binary patches or shared Observations.

| Fixed id | Handler result | Own attempted/persisted writes | Own Observation writes | Rejection |
|---|---:|---:|---:|---|
| protocol-commit |200|5/5|1/1 final|422 shared valued item, whole invocation zero writes|
| protocol-unapply |200|3/3|1/1 entered-in-error|409 closed encounter, whole invocation zero writes; separate422 shared target zero-write control|
| protocol-restore |500 after successful compensation|1/1|1/1 restored final, If-Match|409 late close, zero restore-phase writes; full invocation retained; separate whole-invocation422 shared-target control|

The restore row does not claim a successful request. A deliberate Basic finding-state failure occurs after the initial Observation removal. The real rollback callback then performs the guarded If-Match restoration; the original error is still thrown. The helper asserts the restored clinical resource equals its original content (excluding meta), then records that exception honestly as500 with `handlerOutcome:threw-after-compensation`.

For late-close rejection, the same deliberate Basic failure is followed by an external fixture close immediately before the restore guard reads Encounter. This setup mutation occurs outside mutator tracing and is retained explicitly as `fixtureStateChange`. There are preceding legitimate unapply writes and later Basic compensation writes. `rejectionScope:phase-only` means only Observation restoration is zero-write; the helper retains `rejectionInvocation` and `rejectionSetup`, and makes no claim that the full request wrote nothing.

Real handler setup for rollback is captured using an optional backward-compatible configure callback in protocolRollbackFixture. Commit and unapply share one scenario id; restoration uses a separate fault-triggered invocation. No runtime row is generated from the registry.

Independent verification: runProtocolWritePaths returned exactly3 rows with all internal assertions passing. Focused protocol suite29/29 after helper addition; owned helper/harness semantic type diagnostics0. Full synthetic in-memory traces: t22-runtime.json. Counts: protocol-runtime-check.txt. Regression output: protocol-runtime-regression.tap. Type result: protocol-runtime-types.txt. No production edits or mutations in this step, no live execution, no commit or independent evaluation.
