# R10 A2b.1 writer amendment evidence

Base: `4b3f6d7c25fb40268e216dcd22ad03a866d03643`. Scope: contract §3.4, W-h. Author verification only; NOT EVALUATED. No Docker containers started. Synthetic in-memory FHIR transport; no PostgreSQL or live authorization claims.

## Implementation

- Every writer outcome carries `clinicalWrite`; non-success and pending audit outcomes carry a typed cause. A known successful clinical write remains confirmed if its audit cannot be confirmed. Reassert and the repair API report no clinical write.
- `executionOrder` contains indices into submitted targets in the actual writer processing order, including halted slots. The first unexecuted slot after a failed refresh owns `refresh`; subsequent slots own `halted-by-earlier-target`. Load/refresh outcomes retain typed `fresh` internally for HTTP selection.
- Async `classifyReplay(state, command, target)` uses the complete loaded state; pass `{ ...state, fhir }` for reassert audit verification. `FindingReplayLookupError.cause` is `audit-lookup`. Fact exact replay requires owner identity, command, intended digest, and persisted rehash. Intended digest mismatch is reuse; persisted drift with the original intended digest is not replay and goes through ordinary validation/conflict handling.
- `repairPendingAudits` reconstructs frozen mutation audit debt, stopping after a failure; it never attempts an Observation write.

## Existing assertions

No existing assertion changed or removed. All 35 original writer tests remain green, including W25's direct-library command reuse behavior. Reuse refusal belongs to the diagnosis handler through `classifyReplay`. The added 13 tests map to W-h; W38 and W44 identify their mutation guards explicitly.

## Checks

Command: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/currentFindingWriter.test.ts`.

- Test-first field/API red: 35 pass, 8 fail (`tdd-red.txt`). Missing replay/repair exports are exposed through namespace import so the existing 35 tests execute.
- Typed audit lookup red: 45 pass, 1 fail (`audit-cause-red.txt`).
- Typed load state red: 46 pass, 2 fail (`load-kind-red.txt`).
- Persisted drift classification red: 46 pass, 2 fail (`replay-drift-red.txt`).
- Final: 48 pass, 0 fail, 0 skipped (`tdd-green.txt`).
- `npm --prefix mcp run build`: exit 0 (`build.txt`).
- `git diff --check`: exit 0.

Mutations run using the same Node command plus `--test-name-pattern`:

- W38: replace ordered target indices with submitted indices. The operator-authorized `[legacy-retire, fact]` library fixture fails (`W38-red.txt`, exit 1); restore passes (`W38-green.txt`, exit 0). Required `[fact, fact]` second-target conflict test also remains present and green.
- W44: replace the first refresh failure cause with `halted-by-earlier-target`. The causal test fails (`W44-red.txt`, exit 1); restore passes (`W44-green.txt`, exit 0).

## Historical contract limitation (resolved by rev 3.2 below)

Reassert audits contain only an opaque SHA256 key, target reference, actor, activity and recorded time. They do not persist a recoverable command/target/baseline witness. An exact key can be checked, but the same command reused with a fresh baseline cannot be recognized as reuse from this data. Executed probe (`reassert-reuse-limitation.txt`): reassert C at v1 applies; source advances; C at fresh v2 classifies not-replay; existing library applies and creates a second audit. New audit witness format needs operator authorization and is not implemented here. This blocks claiming the full replay contract complete. No schema, audit payload, clinical code or unrelated behavior was changed.


## Rev 3.2 reassert command witness

New reassertion audits now also carry `urn:odos:finding-command:v1` with SHA256 of the literal `commandId|target`. Mutation audit payloads remain unchanged. Replay classification searches the witness across all audit pages: matching audit key and target confirms exact replay; a witness without the requested audit key rejects changed-baseline reuse. If no witness exists, the previous exact-key fallback still handles old audits. Audit lookup errors remain typed `audit-lookup`.

Changed assertion mapping (base `1184b904`, no original A2a assertion changed):

| File:line after change | Before | After | Contract mapping |
|---|---|---|---|
| `mcp/tests/currentFindingWriter.test.ts:411` | Reassert audit exists, source later changes: `not-replay` | Same submitted baseline with the new witness's exact key: `exact-replay` | W-h, V12; rev 3.2 expressly classifies by the witness and audit key. Fresh-baseline reuse is separately rejected by W45. Old audit fallback retains the previous drift result. |

Verification:

- `witness-tdd-red.txt`: 50 tests, 48 pass, 2 fail before implementation.
- `witness-green.txt`: 50 tests, 50 pass, 0 fail/skipped.
- W45 library guard: mutate witness-with-different-key rejection into ordinary fallback; assertion returns `not-replay` instead of `reused-with-different-content`, exit 1 (`W45-red.txt`). Restored: exit 0 (`W45-green.txt`). Handler HTTP 409 guard is parent work.
- `git diff --check`: exit 0.
- Standalone MCP build reports the existing initial-load closure-narrowing error at writer line 56. The parent already fixed it in `a8921e9d`; this isolated branch deliberately does not duplicate that parent change. Integration must run the build after cherry-pick. The earlier blanket build-success statement above is superseded by this explicit result.

The previous two-audit counterexample is resolved for newly written tagged audits at the prevalidation classifier. Direct writer reuse behavior and compatibility of historical untagged audits are preserved as required. No current witness blocker remains. NOT EVALUATED.
