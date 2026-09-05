# History 1d-6 Round 5 — delete the durable bulk ledger

## Summary

Round 5 implements the operator decision at `performance-od` main `916162b9f98f7aff41768475491945fe1594513a`: element 2 of the rescope is retired, so the Basic bulk-save ledger and its recovery contract are deleted rather than repaired.

Each click now recomputes the current unanswered ROS targets and creates a new gesture id. The server conditionally persists negative answers in seven-answer units, identifies only answers created by that request, re-reads those answers, keeps only answers still live and negative, and writes the immutable review act last. A partial request writes an honest act for only that request's successful units; the next click is a separate gesture and naturally excludes answers entered in the gap.

The one HTTP contract remains shared by both item-review doors. The deterministic disabled guard, section freeze, entry-limit arithmetic, conditional answer writes, both held-transport windows, completed-act idempotency, and the rejecting `{method}` summary token remain in place. A request that loses hook ownership no longer releases the section lease.

I3 and I4 have no surviving subject: there is no ledger to strand, initialize, recover, reconcile, cancel, or mark complete. Repository searches outside historical build logs find no bulk-ledger state URL, coded Basic ledger, `bulkDenials`, or `bulkProgress` implementation.

## Shipped behavior changed

This deliberately removes two visible behaviors shipped in Round 1: the `N of M recorded` progress display and the `Resume marking unanswered No` control. After a partial failure, the surface returns to `Mark unanswered No`; clicking it starts a new gesture from the answers that are unanswered at that click.

## Files

- `mcp/src/clinical-graph/hpi-endpoint.ts`: removes every ledger read/write and recovery path; retains chunking and one HTTP contract; derives act targets server-side from live negatives created by the current request.
- `mcp/src/authz/roles.ts`: removes the retired coded Basic grant.
- `data/canonical-extensions/registry.json`: unregisters the retired extension.
- `data/canonical-extensions/history-bulk-denial-state.json`: deleted with its subject.
- `mcp/tests/historyRosHttp.test.ts`: deletes ledger-only assertions and adds the two-click per-gesture B3 guard.
- `mcp/tests/helpers/historyRosFixture.ts`: removes Basic-specific ledger behavior while retaining general FHIR fixture operations.
- `mcp/tests/schedulingRbacGrants.test.ts`: removes the retired grant from the criteria allowlist.
- `ui/src/components/charting/useHistoryItemReview.tsx`: removes progress/resume state and polling; creates one gesture per click; releases only while the request still owns the hook.
- `ui/src/components/charting/HistoryRosSection.tsx`: always passes live `unansweredTargets` and removes progress/Resume rendering.
- `ui/tests/historyRosBrowser.test.tsx`: removes the ledger scenario and folds its still-live freeze, transport, intervening-Yes, per-gesture, and ownership guards into the comprehensive browser proof.
- `docs/build-log/history-1d6/round5/`: mutation logs, five-run browser logs, screenshots, and this bundle.

No new decision was made in this repository, so `decisions/INDEX.md` was not changed. No medical terminology, FHIR artifact URL, regulatory citation, or other Mandate 14 item was introduced; the retired ODOS-local extension and grant were deleted, so no Mandate 14 ledger row was added.

## Verification

- PR-head baseline before Round 5: MCP 4,225 passed, 0 failed, 45 skipped; UI 1,240 passed, 0 failed, 0 skipped.
- Final MCP: `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:55436/medplum ODOS_ALLOW_UNGATED_MCP=1 npm test` — 4,213 passed, 0 failed, 45 skipped; 4,258 total in 62.056 seconds. The 41 live-stack skips mean this run does not prove real AccessPolicy enforcement.
- MCP count delta: 13 tests whose only subject was the retired ledger/recovery contract were deleted; one new per-gesture partial-run guard was added. Net: 12 fewer passing tests, with the same 45 skips.
- Final UI: `npm test` — 1,239 passed, 0 failed, 0 skipped in 77.338 seconds.
- UI count delta: the one ledger/resume browser scenario was deleted; every still-live assertion was moved into the comprehensive scenario. Net: one fewer passing test.
- Focused HTTP file: 9 passed, 0 failed, 0 skipped.
- Browser file, five consecutive final-tree runs: run 1 3/0/0; run 2 3/0/0; run 3 3/0/0; run 4 3/0/0; run 5 3/0/0.
- `npm run preflight`: exit 0; shipped CPT guard clean; FHIR read grant check passed for 46 resource types; operation grant coverage passed for 837 operations; 0 warnings and 0 hard blocks.
- `mcp npm run build`: exit 0 (`tsc`).
- `ui npm run build`: exit 0; 313 modules transformed; production bundle built in 1.96 seconds, with the existing large-chunk warning.
- `git diff --check`: exit 0.
- Visual proof: `bulk-busy.png` shows the section and clear controls frozen during the held request; `bulk-complete.png` shows the completed answers with no Resume control or progress display.

### Deletion accounting

Removing the ledger implementation before deleting its tests did not leave the suite green: the focused file produced 4 passed and 18 failed. The failures covered the ledger extension/grants, durable progress and retry, clear/recovery variants, retained author, retry convergence, malformed-ledger read, I3 response-loss/terminal reconciliation, and all three I4 initial-ledger uncertainty cases. Those assertions were then deleted with the retired subject. Thirteen ledger-only tests were removed; the other failures were assertions inside tests that retained a live non-ledger subject and were rewritten to that subject.

## Mandate 17

Every standing pair and all three Round 5 pairs were applied alone, observed RED, restored, and observed green. Each RED was 0 passed / 1 failed; each restoration was 1 passed / 0 failed.

| Pair | Mutation | Guard |
| --- | --- | --- |
| 1 | Allow eight answers plus Provenance in the eight-entry unit | chunking/entry-limit test |
| 3 | Build the act from intended client targets | concurrent-Yes B3 test |
| 4 | Remove conditional-create from answer writes | concurrent-Yes B3 test |
| 5 | Remove completed-act short-circuit | byte-stable replay test |
| 6 | Restore `{method}` to the ROS summary | unknown-token rejection test |
| 11 | Remove the legacy door's shared bulk contract | I2 every-door test |
| 14 | Remove the ROS row freeze | held-request browser test |
| 15 | Restore a divergent HTTP door | I2 every-door test |
| 18 | Restore stale target replay across clicks | intervening-Yes and new-gesture browser test |
| 19 | Restore unconditional lease release | lost-owner browser test |
| 20 | Derive act targets from the client list | concurrent-Yes B3 test |

Pairs 2, 7, 8, 9, 10, 12, 13, 16, and 17 were retired with their only subject: ledger checkpointing, registry/grant presence, resume/author/malformed-ledger behavior, stale progress loads, I3 reconciliation, and I4 recovery. Pair 20 is the stronger Round 5 successor to the live-target portion of pairs 3 and 9; pair 15 is the comprehensive successor to pair 11. Both predecessor guards were nevertheless rerun above while their live contract remains.

Executable evidence is in `results.json`, `1-red.log` through `20-restored.log` for the listed pairs, and `browser-results.json` plus `browser-final-1.log` through `browser-final-5.log`.

## Risks and follow-up

- The full MCP suite used the documented ungated acknowledgement because 41 credentialed live-stack tests were not configured. It does not prove real Medplum AccessPolicy enforcement of the surviving conditional Observation and Provenance writes.
- Partial failure is intentionally not resumable. The already-persisted negatives and their act remain; the operator must click again to create a new gesture for then-unanswered rows.
- A request that loses hook ownership deliberately retains its section lease so an uncertain in-flight commit cannot expose editable ROS rows. The browser probe proves the old request cannot repaint or release that lease.

## Status

Round 5 implementation and author-side verification are complete. PR #536 must remain non-draft and stop here for Astra's independent evaluation at the exact final head. This author bundle is not an independent verdict.
