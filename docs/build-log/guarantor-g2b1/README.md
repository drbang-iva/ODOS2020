# G-2b-1 author evidence bundle

**NOT EVALUATED.** Application head: `158c9e67b91f16fdfa20f22ad20577ebef9d5d7a`, branch `drbang-iva/guarantor-g2b1`. Later evidence-only commits retain this implementation. Independent Fable/Opus evaluation and a green final-head CI run are required before merge.

The service implements preview, transfer/consolidate creation, status, Complete and Correct. Each operation records its immutable plan and individual write intents in a service-authored Task. Sorted RelatedPerson claims, conditional Person fences, detach-before-attach, one destination generation, and release-after-verification make interrupted operations recoverable through explicit staff actions. Late definite responses update the current Task journal without resurrecting cancelled operations or repeating completion audits. A refused journal checkpoint is reported, never replayed.

The patient demographics editor recognizes pending claims before deciding that an unowned child is missing. It names the affected patients, disables Save/Repair, and exposes Complete/Correct. Existing Save keeps its loaded version after the new claim-only fresh read; Repair checks the claim after its existing fresh read. The two scoped write constraints protect operation Tasks and Person ownership links. The five audit events, revocable action, exact service-write inventory entries and canonical extension entries accompany the service.

## Boundaries

This is not atomic. Bounded fresh-state recovery after 412 is implemented exactly as required: one further recovery write, and at most three cancellation attempts on the original Task. An original phase-1 claim conflict has no retry. Each attempt has its own intent; definite responses resolve it. No background completion or compensation exists. A later destination edit after verification is ordinary editor drift; already released children are not reclaimed from later transfers.

Registration changes export its two existing project helpers only. Insurance, statements, communications, lab code, registration bundles, transaction-bundles and G-2b-2 search/attach/move/join surfaces are unchanged. The only edited existing test bodies remain the allowed guarantor Person P7 constraint pin and paymentAudit migration filenames; no existing staff Task constraint pin required editing.

## Verification

| Check | Actual result |
|---|---|
| Full MCP baseline | 4,722 tests: 4,655 passed, 7 failed, 60 skipped |
| Full MCP at final application head | 4,783 tests: 4,715 passed, 8 failed, 60 skipped; see failure disposition below |
| Full UI | 1,496 passed, 0 failed, 0 skipped; baseline 1,485 passed |
| Named regressions | 221 passed, unchanged counts in all 12 named files |
| Core/route/reader/fixture checks | 41 passed, 0 failed |
| MCP typecheck and UI production build | Both exit 0; UI retains its existing large-chunk advisory |
| Preflight | 0 warnings, 0 hard blocks |
| Route/proxy census | 25 backend families, 28 proxy entries; every family covered; advisory check |
| Local mutations | 47 core/registry, 18 policy/audit/client, 3 scanner and 8 editor controls: all green, red after removal, green after restore |
| Real operation HTTP proof | 13 schedules, 115 assertions, 0 failures; 2,025 exchanges, 297 transaction calls, 833 persisted audit rows including 39 operation events |
| Real AccessPolicy proof | 58 positive assertions passed; 12 expected red assertions across 3 policy controls; restored policies passed; 360 exchanges and 62 audit rows |
| Real patient-route browser proof | Complete/Correct clicks, four pending children, disabled write attempts, four preserved identities, zero direct browser FHIR PUTs; two disabled-handler controls red, restored capture green |

[GUARDS.md](GUARDS.md) names every mutation and its failing test. [guard-results.json](guard-results.json) and [guard-transcripts.txt](guard-transcripts.txt) retain counts and actual output. L22 is explicitly a non-mutation/decorative regression; L23's post-verification destination edit is documented later drift. Neither is misrepresented as a mutation guard.

[regression-results.json](regression-results.json) records baseline and final named counts; [regression-output.txt](regression-output.txt) contains actual output excerpts. The full MCP invocation is `npm --prefix mcp test`; UI is `npm --prefix ui test`; builds are `npm --prefix mcp run build` and `npm --prefix ui run build`; preflight is `npm run preflight`. Full UI source bytes are unchanged between its full-suite run and the final application head.

The eight full-MCP failures are six existing `claimReadModelStore` local PostgreSQL connection/teardown failures and two inventory-count pins (34 expected, 37 actual after the three required service-write entries). The seventh baseline environment failure was missing root `tsx` for the DR child test; installing locked root dependencies removed that failure. The separately invoked existing live audit-schema tests passed 2 and failed 4 because their migration list/latest-validator pin excludes the new required migration. Their real database output is [live-audit-schema-tests.json](live-audit-schema-tests.json).

The exact filename/count-only exception is prepared in [test-pins-proposed.patch](test-pins-proposed.patch) and is **not applied**. The contract's existing-test allowlist does not include these two files. No behavior assertion is removed by the proposal. Until the operator approves that exception, these are real outstanding failures; this bundle does not claim a green regression gate.

## Live evidence and limits

[Operation schedules](live-operation-proof.md), [policy constraints](live-policy-proof.md), and [patient-route Chromium proof](browser/README.md) link the actual HTTP, resource snapshots, Task journals, audit rows, runtime and screenshots. They use only the disposable loopback Medplum 5.1.30-9b1bd92 stack, two synthetic practice Projects, real service/staff/composite identities and the repository policy sync. Transaction-bundles is absent. Capture files record source digests before and after each run. These are author-side observations, not an independent verdict or production deployment.

The extra late journal-checkpoint collision has local persistent-store regression and mutation evidence. An optional additional live capture of that case was not executed after the tool's automatic review flagged it; it is outside the contract's required live schedule list. The required operation and policy suites were executed at the committed application head.

The browser harness serves the real patient route and actual guarantor/clinic/desk registrars. Unmounted Office, communications preference, Series Tracker and clinical graph background requests return 404; the report and full-route screenshot disclose those notices. Guarantor requests succeed. The screenshots are workflow previews at one implementation, not an invented base/after comparison.

## Risks and follow-ups

- **Pre-existing lab parent validation gap, separately filed; lab code untouched.** The unchanged manual submit handler accepts any supplied Task ID as the clinical-order parent. The synthetic in-memory [probe](reader-lab-probe.json) returned 200, created one distinct lab-transmission Task based on the supplied operation-shaped Task, left that parent unchanged, and exposed only the transmission on the board. This proves the validation gap, not normal UI reachability, live staff access or external delivery. [Probe source and limits](premises.md) retain the exact scope. S5 filters by operation code system and service authorship; foreign-code service-authored lab Tasks are ignored in the unit guard and real HTTP L3 schedule. Removing the code filter makes the guard red.
- Complete/Correct remain staff actions; no automatic repair or completion is promised. Later writes after claim release can create ordinary drift and are not reversed by recovery.
- Six local database failures are preserved as the named environment baseline; the two count pins and four isolated migration pins require the narrow operator exception. CI remains authoritative and must be refreshed at the eventual final PR head.
- The author cannot supply the independent evaluator marker. No merge or `evaluated` label is authorized by this bundle.

## Premises and Mandate 14

[premises.md](premises.md) and [task-reader-census.md](task-reader-census.md) record the base anchors, complete Task reader disposition and accepted lab ruling. The final fetch found `origin/main` at `ddf6ba4a4f5e06efb13c59759d4941159fe49d0a`; its diff from `a13fc1ea` across the specified implementation anchors is empty. No open PR overlap remained at that refresh.

[guarantor-g2b1-ledger.md](../../../data/code-bindings/guarantor-g2b1-ledger.md) contains six Mandate 14 rows with two primary sources and access dates for the required FHIR typing and empty-operand semantics. It is documentary, not an enforced allowlist. The three actual registries have deletion controls. No new clinical codes or dependency versions are introduced. The companion decision repository remains read-only; this implementation creates no new decision or INDEX entry.
