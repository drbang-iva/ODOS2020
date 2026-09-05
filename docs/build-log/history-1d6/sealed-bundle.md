# History 1d-6 bulk denial

## Summary

The Review of Systems surface now offers one `Mark unanswered No` gesture. The HTTP boundary accepts bulk requests only with a UUID gesture identity and valid unanswered ROS targets. The handler creates a coded `Basic` progress ledger first, writes at most seven conditional-create answers plus one Provenance per transaction, checkpoints confirmed persistence after every unit, writes the immutable bulk review act from only confirmed negative answers, and marks the ledger complete last.

Interrupted gestures remain visible as `N of M recorded` and can be resumed. The display disappears after completion. A concurrent explicit Yes survives and is excluded from the bulk act. Replaying a completed gesture returns the same response without a write.

## Shipped behavior changed

Before this slice, the HTTP endpoint returned 400 for every `method: "bulk"` item-review request and the ROS UI had no bulk-denial control. After this slice, the endpoint and UI perform resumable unanswered-only negative capture under the persistence contract above. Clinical summary text is unchanged and still rejects the retired `{method}` token.

## Files

- `mcp/src/clinical-graph/hpi-endpoint.ts`: bulk endpoint, chunking, conditional answer writes, progress ledger, resume, persisted-target act.
- `mcp/src/authz/roles.ts`: criteria-fenced provider/staff access to the new coded ledger.
- `data/canonical-extensions/history-bulk-denial-state.json` and `registry.json`: R4 extension definition and registration.
- `mcp/tests/helpers/historyRosFixture.ts`: conditional-create, Basic persistence, transaction-failure, and race behavior.
- `mcp/tests/historyRosHttp.test.ts`: HTTP contract, ordering, interruption, concurrency, replay, registry, and grant guards.
- `mcp/tests/schedulingRbacGrants.test.ts`: repaired canonical Basic grant allowlist.
- `ui/src/components/charting/HistoryRosSection.tsx`: accessible bulk-denial control and transient progress.
- `ui/src/components/charting/HpiSection.tsx`: applies confirmed bulk answers without reposting.
- `ui/src/components/charting/useHistoryItemReview.tsx`: gesture identity, polling, partial-failure state, and resume.
- `ui/tests/historyRosBrowser.test.tsx`: end-to-end interrupted/resumed UI proof.

No new clinical terminology code was introduced. The ledger code and canonical URL are ODOS-local application artifacts, so no Mandate 14 external terminology ledger row was required. No new design decision was made, so `decisions/INDEX.md` was not changed.

## Checks

- `npm run preflight`: exit 0; shipped CPT guard clean, FHIR read grant check PASS (46 resource types), operation coverage PASS (840 operations), 0 warnings, 0 hard blocks.
- `cd mcp && export ODOS_ALLOW_UNGATED_MCP=1 && npx tsc --noEmit && npm test`: exit 0; 4,200 passed, 0 failed, 57 skipped. The harness recorded 41 live-stack skips and explicitly states this does not gate authorization.
- `cd ui && npx tsc --noEmit && npm run build && npm test`: exit 0; 313 modules transformed; 1,240 passed, 0 failed, 0 skipped.
- Focused inherited and new MCP history checks: 63 passed, 0 failed.
- Focused ROS browser checks: 4 passed, 0 failed.
- Captured UI proof: `bulk-interrupted.png` shows 7 of 53 recorded with Resume; `bulk-complete.png` shows the completed section with no progress display and the pre-existing eye-pain Yes preserved.

The credentialed full-suite attempt was not usable as code evidence: the configured admin login returned `User not found`, the worktree lacked `ODOS_OPERATOR_PROJECT_ID`, and 13 live tests failed on environment/project setup while 4,231 passed and 16 skipped. No credential or account state was changed.

## Mandate 17

Each mutation was applied alone, run against its named guard, restored, and rerun.

| Guard mutation | RED | Restored |
| --- | --- | --- |
| Allow eight answers plus Provenance in an eight-entry unit | 0 passed, 1 failed; endpoint returned 413 because the bundle needed 9 entries | 1 passed, 0 failed |
| Skip the per-unit ledger update | 0 passed, 1 failed; durable ledger recorded 0 instead of 7 | 1 passed, 0 failed |
| Build the final act from intended targets | 0 passed, 1 failed; concurrent Yes leaked into the act | 1 passed, 0 failed |
| Remove answer conditional-create semantics | 0 passed, 1 failed; duplicate answer identity caused 503 instead of preserving the concurrent Yes | 1 passed, 0 failed |
| Remove completed-gesture short-circuits | 0 passed, 1 failed; replay changed persisted bytes | 1 passed, 0 failed |
| Re-add `{method}` to the ROS summary | 0 passed, 1 failed with `Unknown history summary token: method` | 1 passed, 0 failed |
| Delete the canonical extension registry entry | 0 passed, 1 failed; active registry count was 0 instead of 1 | 1 passed, 0 failed |
| Delete the coded Basic policy criteria | 0 passed, 1 failed; provider/staff read grant was absent | 1 passed, 0 failed |

## Risks and follow-up

The in-memory and browser suites do not evaluate Medplum AccessPolicy criteria. The coded provider/staff policy is compiled and guarded in source, but a credentialed local-stack authorization run remains required when the operator fixture is configured and the local admin identity is valid.

Independent evaluation at the exact PR head remains required before merge.

## Status

Implementation and executable local verification are complete. Ready for non-draft PR and independent evaluation; do not merge before the evaluator marker is current.
