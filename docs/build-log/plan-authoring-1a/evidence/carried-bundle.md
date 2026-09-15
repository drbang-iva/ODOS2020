# Item 8a-d author validation bundle

## Scope and behavior

- Whole-apply and unapply conditional application conflicts return 409.
- Follow-up confirmation checks liveness inside the encounter lock and returns typed 404 when a concurrent undo removed the action.
- Undo preserves a clinician's resolved follow-up flag and timing; it drops the undone plan alternative and removes alternatives when all remaining plan timings agree with the clinician.
- Projection rollback captures the revoke response version for ServiceRequest, Observation, and CarePlan. Restore uses If-Match, refuses a missing version, and reports a resource-labelled rollback failure without retrying blindly.

Branch: `drbang-iva/plan-carried`, based on `bac7cd14`. No push or PR. Production scope is only `protocol-service.ts` and `protocol-endpoint.ts`.

## Tests and fidelity changes

New `mcp/src/__tests__/plan-carried.test.ts` exercises real route handlers with synthetic FHIR storage enforcing versions and If-Match. Tests cover concurrent whole applies; an unapply conditional-save loss; confirm queued behind a real unapply holding the encounter lock; clinician 4-month and matching 6-month decisions; newer projection edits during rollback for all three resource types; successful conditional restoration; and missing revoke-version refusal.

`helpers/plan-authoring-fhir.ts` update is bound as an arrow method to match the production client calling convention. The existing `protocol-phase5.test.ts` EndpointFhir helper now maintains a projection-version sidecar, returns server versions on API responses, and enforces conditional writes. Its stored domain snapshots retain their existing representation so legacy deep-equality assertions remain unchanged. Every existing test body and assertion is unchanged in this commit.

## Executed checks

- `npm --prefix mcp run build`: exit 0, `tsc`, no diagnostics (`carried-build.txt`).
- `npm --prefix mcp test -- src/__tests__/plan-carried.test.ts`: 10 tests, 10 pass, 0 fail (`carried-green.txt`).
- `npm --prefix mcp test -- src/__tests__/plan-carried.test.ts src/__tests__/plan-materialization.test.ts src/__tests__/plan-offered.test.ts src/__tests__/plan-seeding.test.ts`: 23 tests, 23 pass, 0 fail (`carried-focused.txt`).
- `npm --prefix mcp test -- src/__tests__/protocol-phase5.test.ts`: 129 tests, 128 pass, 1 fail (`carried-phase5.txt`). The sole failure is `shared rollback endpoint: finding revocation rollback preserves original FHIR IDs and statuses`: the v2 fixture no longer emits Observation. Parent task owns the permitted v1 setup correction, outside this agent's test-body scope. The action rollback test passes with the new conditional restoration.

## Mandate 17 raw evidence

Final test suite on original production source: 10 tests, 0 pass, 10 fail (`carried-red.txt`). Mutation runner `carried-mutations.py` restores production files in a finally block.

| Mutation | Red results | Restored results |
| --- | --- | --- |
| Remove apply 409 mapping | 9 pass / 1 fail | 10 pass / 0 fail |
| Remove unapply 409 mapping | 9 pass / 1 fail | 10 pass / 0 fail |
| Move confirm liveness before encounter lock | 9 pass / 1 fail | 10 pass / 0 fail |
| Undo re-raises resolved clinician flag | 9 pass / 1 fail | 10 pass / 0 fail |
| Drop restore If-Match | 6 pass / 4 fail | 10 pass / 0 fail |

Raw outputs: `carried-mutation-*.txt` and corresponding `carried-restored-*.txt` beside this report. Each red is the intended guard failure, not a setup or compilation error.

## Limits and handoff

Author validation only, not independent evaluation. No live AccessPolicy or server-concurrency proof is claimed; these are real handlers over version-aware synthetic storage. A failed rollback deliberately stops and reports the projection conflict, leaving the newer projection untouched; it does not claim the whole operation recovered atomically. Parent task owns full suite, UI 8e proof, test-body AST preservation record, PR, and cross-model evaluation. No new decision or medical-code/FHIR-artifact constant introduced; no decisions index or Mandate 14 ledger changes in this subtask.

Status: implementation ready for parent integration; legacy finding setup correction and independent evaluation remain with parent.
