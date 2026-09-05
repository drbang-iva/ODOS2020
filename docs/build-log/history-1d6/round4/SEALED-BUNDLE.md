# PR #536 — Round 4 fixback

This is an author bundle for the fixback of `9a3b7a8a900d3f59bfd9ce32e745221586bb40c5`. A new independent Astra evaluation must bind its verdict to the updated PR head before merge.

Base checkout: `origin/main` refreshed at `1ab029d87627481ebfbb9ca271d570b2a397731d`. Fixback branch: `drbang-iva/ros-bulk-round4`, created separately from the exact PR head. The existing PR branch receives a normal fast-forward push.

## Resulting behavior

ROS answers, review ticks, row clears, and notes become read-only while the section has a bulk request in flight. Editing returns after completion or interruption; interruption retains Resume. The same page disables Clear History and Clear chart while ROS is busy. Other sections remain editable. Pending autosaves finish before bulk starts, and confirmed answers are applied before the busy guard releases. Requests that lose their component/encounter owner cannot apply their late response.

This is a real shipped behavior change: a clinician must wait for an active bulk request to finish or interrupt before editing that section. The scope is the current browser page. The guard does not provide server transaction atomicity, coordinate another browser tab, or stop a direct API writer. The transaction-bundles flag was not changed.

## Invariants and mechanisms

| Invariant | Implementation and regression evidence |
| --- | --- |
| I1 — surface excludes competing edits while bulk is busy | A section write lease covers autosave draining, the POST, and final answer application. ROS uses a disabled fieldset; row clears and broader clear controls share the lease. The browser first holds an explicit-answer autosave and proves no bulk POST starts before it finishes. It then holds the last answer unit, the act transaction after its final reread, and final History responses. Every row editor remains disabled through all three holds; attempted UI clears do not remove any of the 53 attested negatives. Rows and clears are enabled after interruption and completion. A separate held response loses its encounter owner and applies zero stale answers. |
| I2 — one contract at every HTTP door | Legacy item-review requests delegate to `handleHistoryItemReviewRequest`. Valid bulk requests use the same ledger path, and multi-target individual requests are rejected by both doors. The old patient-history no-change action remains separate. Reusing a gesture with a changed method is refused before any ledger/answer write; an interrupted ledger reserves its gesture before an act exists. |
| I3 — a committed gesture reaches a terminal state | Resume looks up the immutable act before rebuilding targets. An already committed bulk act completes its ledger using its original target set, even after answer or section clear. An incompatible historical act ends the gesture as `cancelled` with an explicit explanation. Recovery neither replaces nor recreates the act. |
| I4 — creation participates in recovery | Initial ledger creation is inside the recovery boundary. 409/412 and unknown create responses reload durable state; concurrent callers converge on one ledger and exactly two Provenance rows for the one-unit fixture. Retry recursion is bounded; continuing storage failure returns resumable 503 instead of looping forever. |

Code commits: `57677199` (shared act lookup, first caller verified) and `c05cb64d` (I1–I4 implementation). The evidence commit adds the pending-autosave hold and seals these outputs.

## Files changed in Round 4

- `mcp/src/clinical-graph/hpi-endpoint.ts`: shared immutable-act lookup, converged HTTP dispatch, initial-create recovery, terminal reconciliation, and pre-write gesture reservation.
- `mcp/tests/historyRos.test.ts`: the retraction-retry fixture now uses the existing bulk-review service helper with an explicit gesture ID; all assertions and the two retained HOLDS setups remain intact.
- `mcp/tests/historyRosHttp.test.ts`: seven I2–I4 cases, including both HTTP doors, method changes before/after ledger creation, lost act response followed by answer/section clear, incompatible act cancellation, and initial 409/412/unknown response.
- `ui/src/components/charting/encounter-edit-context.tsx`: shared page-local section write lease.
- `ui/src/components/charting/ClearControls.tsx`: section/chart clear respects the lease and checks again after confirmation.
- `ui/src/components/charting/HpiSection.tsx`: flush pending saves before bulk; serialize ROS row clear; keep History mounted while ROS is busy.
- `ui/src/components/charting/HistoryRosSection.tsx`: disabled ROS fieldset, busy explanation, callbacks applied under the lease.
- `ui/src/components/charting/useHistoryItemReview.tsx`: request ownership and lease lifetime through final answer application.
- `ui/tests/historyRosBrowser.test.tsx`: extends the existing bulk scenario; keeps four scenarios and the original held-final-unit bulk-button assertion.
- This bundle, screenshots, and executable mutation/output records.

No clinical terminology or canonical artifact was added. No new decision was made; the implementation follows the operator's Round 4 record, so no Mandate 14 ledger row or `decisions/INDEX.md` change is required. The existing author-retention, stale-progress, fresh-gesture, malformed-ledger and HOLDS fixes were not reopened.

## Executed checks

- `cd mcp && node --import tsx --test --test-name-pattern='I2|I3|I4' tests/historyRosHttp.test.ts`: **7 passed, 0 failed, 0 skipped**.
- `cd ui && node --import tsx --test tests/hpiSection.test.tsx tests/encounterVoid.test.tsx`: **54 passed, 0 failed, 0 skipped**.
- `cd mcp && npx tsc --noEmit --pretty false`: **exit 0**.
- `cd ui && npm run build`: **exit 0**, 313 modules transformed.
- `npm run preflight`: **exit 0**, 0 warnings, 0 hard blocks.
- `cd ui && node --import tsx --test tests/historyRosBrowser.test.tsx`: five consecutive runs of the final test/source bytes, each **4 passed, 0 failed, 0 skipped**. Full logs are adjacent; [source-sha256.json](source-sha256.json) binds the instrument and implementation bytes.

| Run | Passed | Failed | Skipped | Time |
| --- | --- | --- | --- | --- |
| 1 | 4 | 0 | 0 | 30.564 s |
| 2 | 4 | 0 | 0 | 30.274 s |
| 3 | 4 | 0 | 0 | 30.891 s |
| 4 | 4 | 0 | 0 | 30.769 s |
| 5 | 4 | 0 | 0 | 30.470 s |

Exact-head CI completion and job links are recorded in the PR description after the push; this committed bundle records the local evidence. No full local UI rerun was used to chase unrelated mount flakes.

The initial implementation probes were RED: the new backend group showed 1 passed/5 failed before recovery/convergence, and the row-freeze browser scenario showed 0 passed/1 failed. The added method-reservation case also failed with `200 !== 409` before the pre-write refusal was added.

## CI-discovered fixture correction

The first fixback CI at `aad819d7` passed the full UI suite (**1,240 / 0 / 0**) but failed MCP (**4,225 / 1 / 44**). The sole failure was `historyRos.test.ts:116`: the retraction-retry fixture created a two-target `individual` act through the legacy HTTP door. I2 now correctly rejects that setup with 400.

That fixture now uses the existing `bulkReview` service helper, with an optional explicit gesture ID so the same identity-reuse checks remain meaningful. No assertion was removed or relaxed. Local reproduction was **0 passed / 1 failed**; corrected setup is **1 passed / 0 failed**. The final UI/source bytes are unchanged from the five consecutive browser runs.

Because the fixture changed, its guard was demonstrated independently: replacing `const saved = match(existing)` with `const saved = {}` in `persistHistoryItemAct` allows a retraction retry to change its target and makes this test fail (**0 / 1**); restoring the implementation passes (**1 / 0**). Run `node docs/build-log/history-1d6/round4/retraction-fixture-guard.mjs`; the adjacent JSON and TAP files record this supplementary fixture check. It does not rerun or alter the thirteen standing mutation records.

## Mandate 17

The [thirteen standing mutation records](https://github.com/drbang-iva/ODOS2020/blob/9a3b7a8a900d3f59bfd9ce32e745221586bb40c5/docs/build-log/history-1d6/sealed-bundle.md) remain the accepted historical evidence at `9a3b7a8a900d3f59bfd9ce32e745221586bb40c5`; they were not rerun or edited. Their original test contracts are historical: the legacy-door refusal is superseded by I2's common HTTP contract. The following four new pairs extend that record.

Run `node docs/build-log/history-1d6/round4/mutations.mjs` from the repository root. The runner applies one mutation, preserves real output, restores the exact source bytes in `finally`, and reruns its guard. Full commands/counts are in [results.json](results.json); the eight adjacent logs contain the real TAP output.

| Pair | Removed guard | RED | RESTORED |
| --- | --- | --- | --- |
| 14 | ROS row freeze | 0 passed / 1 failed / 0 skipped | 1 passed / 0 failed / 0 skipped |
| 15 | Common contract at the legacy HTTP door | 0 / 1 / 0 (`individual` with two targets was accepted) | 1 / 0 / 0 |
| 16 | Terminal reconciliation after a committed act | 0 / 1 / 0 (`409 !== 200` after answer clear) | 1 / 0 / 0 |
| 17 | Initial-create 412 recovery | 0 / 1 / 0 (one concurrent request rejected) | 1 / 0 / 0 |

## Evidence limits and next authority

The browser uses the real History component and HTTP handlers over a synthetic in-memory FHIR fixture. It proves the controls, request ordering, and persisted fixture state; it does not prove an atomic database commit or exclusion of other clients. A page reload also creates a new page-local lease registry. No code claims those stronger guarantees.

The cancellation path preserves previously written answers and explains that no new bulk act was created. It does not erase clinical history to resolve an identity collision. Storage outages remain resumable errors until storage returns.

Status: implementation prepared for the existing non-draft PR. **NOT EVALUATED.** Stop after final checks and PR update; Astra must independently re-evaluate the new head. Do not merge.
