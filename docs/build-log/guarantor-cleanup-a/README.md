# Guarantor cleanup A — revision 2 author bundle

**NOT EVALUATED.** Codex authored this change. A separate Claude Opus session must evaluate the exact final PR head. No evaluator marker or operator override is supplied.

Base freshly fetched: `6a3ad04abf623d4e2602b0239a658c575c43827f`. Branch: `drbang-iva/guarantor-cleanup-orphans`. Contract: PerformanceOD `decisions/2026-09-16-odos-guarantor-arc-cleanup-codex-kickoff.md`, CL-A revision 2. Original contract anchors were rechecked; no base drift. Cleanup B PR #610 is separate.

## Result

Staff holding `guarantor.link` can list and deactivate unused Person records in Settings. Cancel after a successful create calls the same audited, conditional discard endpoint. Cleanup changes only `active`; it never deletes a Person. The server recomputes eligibility with complete bounded searches and refuses unavailable/partial searches. The Task scan is explicitly a courtesy check; G1 is enforced by the operation engine.

A discarded destination makes Complete pause at `destination-inactive` before further writes. Recovery rebuilds and fence conflict rereads check the same rule. Undo remains exempt and uses the existing flow. Existing-guarantor registration refuses inactive records before identity writes and now displays that reason. A discard after registration's precheck preserves the created patient and reports failed attachment.

Preview shows the selected textable phone. Reopening Attach clears all search keys. Settings visibility uses effective business actions from the existing identity resolver; no role grants or AccessPolicies changed.

## Proof ledger

Exact command output and mutant diffs are in `guards/`; UI mutations are in `ui/`. Each mutation row below has green, red, and restored output. Counts below are passed/failed tests; X6's failing invariant is asserted immediately after the broken Complete.

| Guard | Green | Broken | Restored |
|---|---:|---:|---:|
| O1, O2, O3, O4, O6, O7 (each) | 1/0 | 0/1 | 1/0 |
| O5 fields / audit / version (each) | 1/0 | 0/1 | 1/0 |
| O8 UI call and refusal | 27/0 focused suite | 2 failures | 27/0 |
| O8 actual browser → Medplum | 2 scenarios | persisted active Person; assertion failed | 2 scenarios |
| O9 draft / preview / confirm × attach / Move / Join | 9/0 | 0/9 | 9/0 |
| O9 initial registration | 1/0 | 0/1 | 1/0 |
| X1 + X6 × attach / Move / Join | 3/0 | 0/3 | 3/0 |
| X2, X4, X5 (each) | 1/0 | 0/1 | 1/0 |
| U1 textable number | 27/0 focused suite | 1 failure | 27/0 |
| U2 reset | 27/0 focused suite | 1 failure | 27/0 |

O2 uses a real create and real discard. O3 uses an active zero-link Person and a real in-progress attach Task. O2b is the contract's layered real-Move/Undo regression, not an isolated mutation. O10 is the contract's no-break regression: a raw staff Person.active PUT returns403 on Medplum. X3 is the existing Undo proof obligation: claims released and no owner after a paused attach. X6 checks G1 after scenarios, including the broken X1 state. No red is invented for rows explicitly designated regression/proof obligations.

`guards/X1-broken-premise.txt` reproduces the original **14-write inactive-and-linked result** with the guard removed. `broken-premise.ts` is that original synthetic diagnostic (prototype discard), distinct from the current endpoint tests and loopback proof.

The service-write inventory is enforced: removing the new discard entry makes its check fail; restoring it makes preflight pass (`guards/service-inventory-*.txt`). The shared FHIR fake now models unconditional PUT honestly; a missing If-Match no longer accidentally causes412 and masks X2.

## Live evidence

`live/operation-proof.json` and `live/operation-http.json`: **6 scenarios, 75 assertions, 0 failures**, actual staff authentication, real AccessPolicy, attributed service writes and persisted audit rows. Includes real create/list/discard; real Move retained-source exclusion and Undo; X1 attach/Move/Join interleavings; opposite-order X2; O10; G1 on snapshots. Requests and final resources are retained.

`live/browser-proof.json` and `live/browser-fhir-requests.json`: **2 browser scenarios passed, 13 application requests**. Real GuarantorLinkScreens and Settings RouteSwitch in a synthetic shell, actual staff identity and loopback Medplum. Cancel deactivates its Person. Closing a tab leaves a record that Settings lists and discards with a reason. Screenshots are in `browser/`. This is not full App startup proof; actual production RouteSwitch is exercised.

`guards/O8-live-red-resources/browser-fhir-requests.json` records the actual active Person after the Cancel mutant; restored browser proof is green.

Provenance includes source SHA-256 hashes before/after. Both live proof hash sets were checked against integrated source with zero drift. Git head labels in those artifacts predate the source commit; the hashes bind the exact source bytes. `source-sha256.json` inventories integrated production files.

## Regression and checks

- Full MCP: `ODOS_ALLOW_UNGATED_MCP=1 npm test` from `mcp/`, with this task's disposable PostgreSQL: **5,422 tests; 5,370 passed; 0 failed; 52 skipped; exit0**. The output explicitly warns this mode does not gate the skipped live lanes. An unacknowledged run correctly returned exit1 for the missing live credentials, despite zero executed failures. Exact final output: `checks/mcp-full.txt.gz`.
- Full UI: `npm test` from `ui/`: **1,626 tests; 1,626 passed; 0 failed; 0 skipped** (`checks/ui-full.txt.gz`).
- Named MCP guarantor/registration regressions plus policy guards: **178 passed; 0 failed** (`checks/focused-mcp.txt`). Full runs also cover the broader policy/authz unit suites.
- Preflight inventory suite: **14 passed; 0 failed**. Preflight: **0 warnings, 0 hard blocks**. MCP and UI builds succeeded. UI build reports its existing large-chunk advisory.
- Front-door check: **25 backend route families, 28 proxy entries; every family covered**. This is an advisory static census, not HTTP proof; loopback/browser requests supply the separate HTTP proof.
- Canonical local live-authz setup: **not executed** after the setup was blocked by User404 and the correctly enforced CI-only bootstrap boundary. No guard bypass or permission widening. See `live/authz-lane.md`. Final-head CI must supply the named clinicalWriteAuthzLive/S8/claim-fence lane result.

## Boundaries and handoff

The list labels age as **last updated**, because A2 supplies meta.lastUpdated rather than an authoritative creation timestamp. Under60 minutes is a caution, not a block. The scan can still lose to an in-flight operation, as revision2 explicitly permits; Complete then refuses and Undo resolves it.

Existing Undo changes its fence epoch/version even when the discarded Person stays inactive and unlinked. It preserves demographics and logical link state; it is not byte-for-byte unchanged. No new abort path was added.

No new clinical codes, canonical FHIR URLs or regulatory assertions were introduced; Mandate14 ledger additions: **0**. No new design decision: `decisions/INDEX.md` unchanged. Cross-repo follow-up is independent Claude Opus evaluation of the final SHA against the existing approved contract. Iris untouched; no deployment or merge.

Fixture project `guarantor-cleanup-a-live` is stopped, not removed, at delivery; final delivery reports the verified container state. Source tree and branch are retained for evaluation.
