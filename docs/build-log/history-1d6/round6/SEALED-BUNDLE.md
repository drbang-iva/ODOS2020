# History 1d-6 Round 6 — server-known freeze outcome

## Summary

Round 6 implements the final-round decision at `performance-od` main `1e5c71f4e491fc4616a0035feac502e78a85f55c` on top of PR head `632cf914fcb7523bdafee097b6bf48b00d963d92`.

The server now persists one target-free coded `Basic` lock before the first bulk answer unit. The lock contains gesture, encounter/section context, patient, actor, time, and `in-flight`/`released` state, but no intended or completed targets. Server request accounting exposes an in-flight lock only while the owning request is active; quiescence releases it even if the browser never receives the response. Targets remain derived from the click's live `unansweredTargets`, conditional answer creates, and the final server reread. There is no resume, replay, stored target list, or progress UI.

The browser transfers its section lease to the server lock when a response is lost or truncated. It rereads server state until the lock disappears, then applies the persisted answers and releases editing. A page reload reacquires the section lease from the same server lock. Socket disconnect, truncated response, reload, and normal held-response controls all prove that Yes cannot be written before the original act settles.

Completed-act replay now locates Provenance by a deterministic gesture-derived tag. A missing row is conditionally repaired; a duplicate or incorrectly paired row is refused. The real FHIR transport probe proves both paths: a visible partial act is compensated (`500 → 409 → 409`, one delete, zero acts), while a lost partial response is repaired (`500 → 200 → 200`, one act, two total Provenance rows).

The evaluator-named live assertions are restored: zero-negative/no-act, concurrent answer-unit versus act Provenance, 44px touch size, partial-failure and completion clear re-enablement, server reread, and header-button disabled state.

## Files

- `mcp/src/clinical-graph/hpi-endpoint.ts`: target-free durable lock lifecycle, quiescence exposure, server-side negative reread, and paired act-Provenance repair/validation.
- `mcp/src/authz/roles.ts`: criteria-fenced lock `Basic` read/write grant for chart-capable roles.
- `ui/src/components/charting/useHistoryItemReview.tsx`: unknown-outcome lease transfer, lock polling, reload hydration, and final answer reconciliation.
- `ui/src/components/charting/HistoryRosSection.tsx`: reconciles answers after quiescence while retaining the header disabled contract.
- `mcp/tests/historyRosHttp.test.ts`: lock, Provenance, zero-negative, concurrency, and server-reread guards.
- `ui/tests/historyRosBrowser.test.tsx`: four outcome variants plus restored visible and interaction assertions.
- `mcp/tests/helpers/historyRosFixture.ts`, `mcp/tests/historyItemReview.test.ts`, `mcp/tests/historyRos.test.ts`: tagged Provenance persistence/search and transaction fullUrl resolution in test FHIR stores.
- `mcp/tests/schedulingRbacGrants.test.ts`: exact coded `Basic` grant allowlist.
- `docs/build-log/history-1d6/round6/`: executable mutation/browser/transport instruments, logs, screenshots, result summaries, and this bundle.

No ODOS decision was added, so `decisions/INDEX.md` was not changed. No medical terminology, external FHIR artifact URL, regulatory citation, or other Mandate 14 subject was introduced. The new code is an ODOS-local code under the existing ODOS history-review system, so no Mandate 14 ledger row applies.

## Verification

- Focused History and grant tests: 76 passed / 0 failed / 0 skipped.
- Real FHIR partial-act transport: 2 / 0 / 0. Visible response: `500 → 409 → 409`, one compensation delete, zero acts. Lost response: `500 → 200 → 200`, zero deletes, one act, repaired paired Provenance.
- Full MCP with this worktree's isolated PostgreSQL fixture enabled: 4,221 / 0 / 43; 4,264 total. Forty-one named live-stack tests remain credential-gated; two other non-slice integration lanes remain skipped.
- Full UI with test concurrency 2: 1,243 / 0 / 0.
- Browser file five consecutive final-tree runs: 7 / 0 / 0 on runs 1, 2, 3, 4, and 5.
- MCP `tsc --noEmit` and build: exit 0, no diagnostics.
- UI production build: exit 0; 313 modules transformed; only the existing large-chunk warning.
- Preflight: exit 0; shipped CPT guard clean; 46 FHIR resource types; 841 read/write operations; 0 warnings; 0 hard blocks.
- `git diff --check`: exit 0.
- Visual proof: `bulk-busy.png` shows the ROS header, rows, and clear controls frozen; `bulk-complete.png` shows editing restored with explicit positive answers preserved.

Initial RED evidence was observed before implementation: missing target-free lock/grant 0/1, lost-Provenance replay 0/1, socket/reload freeze 0/2, and mismatched paired Provenance 1/1. Their final guards are green above.

## Mandate 17

Sixteen standing and Round 6 pairs were applied independently. Every mutant produced 0 passed / 1 failed / 0 skipped; every exact-byte restoration produced 1 / 0 / 0.

| Pair | Mutation | Guard |
| --- | --- | --- |
| 1 | oversize an answer unit | derived entry-limit test |
| 3 | use intended targets for the act | concurrent-positive exclusion |
| 4 | remove answer conditional create | concurrent-positive exclusion |
| 5 | remove completed-act short circuit | byte-stable replay |
| 6 | restore the retired `{method}` summary token | unknown-token rejection |
| 11 | bypass the shared legacy bulk contract | every-door contract |
| 14 | remove the ROS row freeze | held-request browser proof |
| 15 | restore a divergent HTTP door | every-door contract |
| 18 | restore stale targets across clicks | live-target browser proof |
| 19 | unconditionally release a lost owner's lease | lost-owner browser proof |
| 20 | derive act targets from the client list | concurrent-positive exclusion |
| 21 | bypass server negative revalidation | pre-act server-reread proof |
| 22 | release after an unknown client outcome | truncated-response proof |
| 23 | hide the durable lock after reload | reload proof |
| 24 | skip completed-act Provenance repair | lost-Provenance replay proof |
| 25 | reduce the header disabled expression to `!ready` | permanent header guard |

The executable matrix and complete RED/restored logs are `mutations.mjs`, `results.json`, and the numbered log files. Five-run browser evidence is `browser-five.mjs`, `browser-results.json`, and the five browser logs.

## Risks and follow-up

- The 41 credentialed live-stack skips mean author-side tests cannot prove the new coded `Basic` grant against a running Medplum AccessPolicy. Static policy compilation and the exact criteria allowlist are green; live enforcement remains an evaluator/operator limitation.
- The accepted independent-writer race after the final server reread is unchanged. This round closes the narrower known-writer uncertainty window by retaining the section freeze until server quiescence.
- Released target-free lock records remain as local audit-shaped facts. They are not progress ledgers and cannot resume or replay a gesture.

## Status

Round 6 implementation and author-side evidence are complete. PR #536 remains non-draft and must stop for Astra independent evaluation at the exact final head. This bundle is not an independent verdict. If that evaluation is not PASS, the recorded hard stop applies: close PR #536 unmerged and do not start Round 7.
