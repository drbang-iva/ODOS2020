# ODOS-HISTORY-1D-5 — coder bundle

Status: operator clarification applied. The retired assertion is replaced, the original coverage/positive guards remain, and the endpoint bulk-refusal guard is unchanged. Independent evaluation has not run; not ready to merge.

Branch: `drbang-iva/history-slice-1d5`. Freshly fetched base: `2468ac519a0839d4f38fd17222a5473e282a804b`. Open PR scope check found only #522 (`docs/install.md`) and #507 (`ui/package-lock.json`); neither overlaps.

## What shipped behaviour does this change?

The composed ROS note and fold/overview summary lose `Review method: individual` / `Review method: bulk`. The `N of 54 items reviewed` counter leaves the interface. Stored review methods, item dates, stale flags, coverage, ROS Charted rules, and the legacy ROS boundary remain unchanged. Bulk and individual methods produce byte-identical text for identical coverage.

Social gains explicit item review/date controls and the tobacco documentation reminder. A review act changes the last-asked date but cannot clear the reminder. Only a live tobacco selection answer dated in the encounter's calendar year clears it, including an answer from a prior encounter. Clearing the answer reopens the reminder; review-only Social entries remain clearable. Social completeness is unchanged: tobacco, driving, alcohol-drugs, and home-safety answers are required; occupation is optional. No Social `charted_when` is declared.

## Files touched

- `mcp/src/clinical-graph/history-template-engine.ts`: ROS summary template, Social review declaration, nudge contract and declaration.
- `mcp/src/clinical-graph/history-subject-projection.ts`: patient-scoped, answer-only period evaluation.
- `mcp/src/clinical-graph/hpi-endpoint.ts`: publishes evaluated reminders with the History record.
- `ui/src/components/charting/HistoryRosSection.tsx`: removes the counter and reuses review loading/gestures/date formatting.
- `ui/src/components/charting/useHistoryItemReview.tsx`: shared existing review mechanics and Social item controls. ROS was converted and its 3 browser tests passed before adding the Social caller.
- `ui/src/components/charting/HpiSection.tsx`: Social controls/reminder and clear refresh, while retaining its existing editors/completeness.
- `mcp/tests/historyRos.test.ts`: operator-authorized repair of the retired assertion plus a new parity guard.
- `mcp/tests/historySocial.test.ts`, `ui/tests/historySocialBrowser.test.tsx`: new slice checks. Only the expressly retired assertion in `historyRos.test.ts` is removed from the pre-existing tests. A named byte-identical summary guard is added; the three neighboring guards and `historyRosHttp.test.ts` remain unchanged.
- `mcp/scripts/prove-history-ros-surface.ts`: optional Social proof on the actual app route, explicit disposable proof port, preserved default ROS scenarios.
- `data/code-bindings/v0.6-verification-ledger.md`: row 64, primary URLs and access date.
- This directory: synthetic before/after captures and local test/mutation evidence.

## Checks and real counts

- `npm --prefix ui test`: **1,239 passed, 0 failed, 0 skipped**. After the final clear wiring, focused `node --import tsx --test tests/historySocialBrowser.test.tsx tests/hpiSection.test.tsx tests/hpiDeltaBrowser.test.tsx tests/historyRosBrowser.test.tsx` from `ui/`: **29/29 passed**.
- `node --import tsx --test mcp/tests/historySocial.test.ts`: **7/7 passed**.
- Non-credentialed full MCP lane (`ODOS_ALLOW_UNGATED_MCP=1`, isolated PostgreSQL, `npm --prefix mcp test`): **4,250 tests; 4,205 passed; 0 failed; 45 skipped**, exit 0. This rerun follows the authorized assertion repair. This run does not prove live authorization.
- Existing regression counts: HPI endpoint **37/37**; template engine **12/12**; answer Observation **3/3**; pagination unit **15/15**; item review **23/23**; item definitions **2/2**; ROS **26/26** after the authorized repair; ROS definitions **2/2**; ROS HTTP **1/1**. Exact commands and counts are in `regression-counts.txt`.
- Unchanged live pagination test: **1/1 passed** on the isolated stack. Observed 600, 1,001, and 5,000 answers returning 200; 25 review acts; ROS category exclusion; 5,001 answers returning 409 with the 11-page ceiling message. See `pagination-live.txt`.
- Fresh stack bootstrap/search smoke: **12/12 passed**.
- `npm --prefix mcp run build` and `npm --prefix ui run build`: **exit 0**. UI retains its existing large-bundle warning. `git diff --check`: **exit 0**.
- UI source search for `MIPS|Q226|QM226`: **zero matches**. Changed History UI search for `credit`: **zero matches**.
- Proxy census: **24 route families, 27 entries; all covered**, advisory.

An earlier full credentialed run against the shared 18103 stack was unsuccessful: **4,249 tests; 4,207 passed; 38 failed; 4 skipped**, with missing installation/seeder configuration and FHIR quota exhaustion. A targeted pagination attempt also hit 429. The task subsequently created its own disposable stack on **18503 / 15832 / 16779**, with separate named volumes. Its large fixture needed `defaultFhirQuota: 1000000`; that override is confined to a gitignored test config. No shared service was restarted or reconfigured. A targeted test invocation from the repo root used the wrong UI working directory; the proper `ui/` invocation is reported above.

## Mandate 17 — original six plus the replacement assertion

All mutations were applied locally to production code or the ledger, then restored. Each restore ran the full 7-test slice suite.

| Mutation | RED result | Restored |
|---|---:|---:|
| Restore `{method}` to ROS template | 2 failed / 7 | 7/7 |
| Append a marker for bulk | 2 failed / 7 | 7/7 |
| Give Social a one-review Charted rule and remove the ROS-only guard | 2 failed / 7 | 7/7 |
| Let an item-review act clear the reminder | 1 failed / 7 | 7/7 |
| Let an out-of-window answer clear it | 2 failed / 7 | 7/7 |
| Delete ledger row 64 | 1 failed / 7 | 7/7 |

Adding only Social's declaration initially left behavior protected by the existing ROS-only engine gate. The final mutation disabled both defenses; the new test also expressly rejects a Social `charted_when`. Full local outputs are the `*-red.txt` and `*-restored.txt` files.

The new named guard in `historyRos.test.ts` uses the same partial Eyes coverage (3/8) and positive eye-pain answer for both methods. Appending ` · bulk` to the summary builder made that exact assertion fail: **1 test / 0 passed / 1 failed** (exit 1). Restoring the builder produced **1 test / 1 passed / 0 failed** (exit 0). The complete ROS + HTTP test run then passed **27/27**, including the unchanged bulk endpoint 400 refusal. See `partial-positive-parity-red.txt`, `partial-positive-parity-restored.txt`, and `ruling-focused.txt`. Production code is byte-unchanged by this follow-up.

## Live and visual proof

`HISTORY_SOCIAL_PROOF=after HISTORY_PROOF_PORT=15135 HISTORY_ROS_CAPTURE_DIR=docs/build-log/history-1d5 node --import tsx mcp/scripts/prove-history-ros-surface.ts` with synthetic local Medplum credentials: **PASS**, actual App `/clinic` route. See `live-surface.txt`.

The corresponding before captures used a separate detached worktree at the exact base, port 15136, unchanged application/backend code, and only the extended capture harness. Both image pairs are 1600×1000. The fixture supplies a provider identity and limited ancillary catalog reads; it is not a constrained-role AccessPolicy verdict. All patients and chart content shown are synthetic.

## Rulings, ledger, follow-ups, and blockers

Implemented the existing accepted PerformanceOD rulings `2026-09-05-odos-ros-review-method-is-not-clinical-documentation.md` and `2026-09-04-odos-history-1d-rescope.md`. No new strategy decision was authored; the companion `decisions/INDEX.md` was not changed. Row 64 documents the source-date calendar-year convention and fallback when encounter start is absent; it asserts no measure outcome. Two agreeing primary sources with URLs and access date are present, and row deletion is test-enforced.

Cross-slice follow-up: 1d-6 must not reintroduce a bulk marker. Bulk gestures, Family History, and Quality Measures screens remain outside this slice.

**Clarification resolved:** refreshed companion main is `818ee8763b7960a54561fba654db23f50ca38358`, containing “Clarification — DoD 9 vs Part A.” The operator authorized removal of exactly the retired `/bulk/` assertion and required byte-identical summaries. That repair is applied; no further operator decision is needed. The separately invoked evaluator must review the final head before merge.

CI run count and PR review state are reported in the PR description; this local bundle does not claim a CI or independent verdict.

⚠️ NOT EVALUATED — hand to Fable/Opus in Claude for the independent eval before merge. I wrote it; I can't be the judge.
