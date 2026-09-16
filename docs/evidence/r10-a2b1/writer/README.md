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

## Open contract limitation

Reassert audits contain only an opaque SHA256 key, target reference, actor, activity and recorded time. They do not persist a recoverable command/target/baseline witness. An exact key can be checked, but the same command reused with a fresh baseline cannot be recognized as reuse from this data. Executed probe (`reassert-reuse-limitation.txt`): reassert C at v1 applies; source advances; C at fresh v2 classifies not-replay; existing library applies and creates a second audit. New audit witness format needs operator authorization and is not implemented here. This blocks claiming the full replay contract complete. No schema, audit payload, clinical code or unrelated behavior was changed.
