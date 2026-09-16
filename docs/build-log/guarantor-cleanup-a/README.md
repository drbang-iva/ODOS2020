# Guarantor cleanup A — revision 3 author bundle

**NOT EVALUATED.** Codex authored this fixback. A separate Claude Opus session must evaluate the final PR head. No evaluator marker or operator override is supplied.

PR #612; branch `drbang-iva/guarantor-cleanup-orphans`. Evaluated predecessor: `9ea7ef411118515baea58d141e5adaab8e20027b`. Implementation commit: `23e0249b` (full SHA in `rev3/provenance.json`). Freshly fetched `origin/main`: `6a3ad04abf623d4e2602b0239a658c575c43827f`. Cleanup B #610 touches separate production files. Contract: [CL-A revision 3](https://github.com/drbang-iva/performance-od/blob/main/decisions/2026-09-16-odos-guarantor-arc-cleanup-codex-kickoff.md); [evaluation](https://github.com/drbang-iva/ODOS2020/pull/612#issuecomment-5696333379).

## Summary and dispositions

| Finding | Result |
|---|---|
| N1 | The inactive-destination refusal now awaits `Run.pause()`. Complete checkpoints the stored Task phase as `destination-inactive` and writes its pending audit row. It makes no additional Person/RelatedPerson write. X1 checks the response, stored Task, status endpoint, audit count, and unchanged ownership. |
| N2 | Eligibility scans only `status=in-progress` guarantor-operation Tasks. Terminal history no longer hides unused Persons or consumes the Task search cap. The real-writer terminal matrix passed before narrowing the scan; final coverage also proves eligible terminal orphans are listed and discardable. |
| N3 | Person search sends `link:missing=true` to Medplum. The loopback query returned exactly the seeded unlinked Persons. With 1,001 linked Person rows, the list returns 200 and includes the orphan; removing the filter returns 409. Caps were not changed. |
| M1 | X7 directly reaches the attach rebuild. A simulated service-level inactivation lands after fencing and causes the attaching write's version conflict. Removing only the rebuild refusal reproduces an inactive Person with a link. This is a low-level engine boundary probe, not a claim that the discard endpoint bypasses its in-progress-Task refusal. Actual discard interleavings are covered by live X1. |
| M2 | A secondary `recordAudit` failure is logged after a landed discard and returns the discard result. Live O14 confirms 200, an inactive Person, and the existing authoritative pre-write audit row containing the staff actor and reason. The write-level audit boundary is unchanged. |
| M3 | Replaced workstation prefixes in retained evidence, including compressed full-suite logs, preserving assertions and stack-frame suffixes. `sanitize-evidence.py` is the shared preparation step. The workstation-path scan has zero matches. |

Production changes: `mcp/src/clinic/guarantor-link-operation.ts`, `mcp/src/clinic/guarantor-search.ts`. Tests: `mcp/tests/guarantorUnused.test.ts`, `mcp/tests/guarantorScreensFixture.ts` (the shared fake now recognizes Task status; it intentionally still ignores the new Person parameter). Remaining changes are sanitized evidence and proof runners in this directory.

## Guards — exact output and mutants

`rev3/guards/summary.json` records 25 independent green/red/restored runs. Every source mutation was verified on disk, restored in a detached worktree, and followed by a clean-tree check and restored run. Each row has the exact command, output, exit code, and mutant diff. Counts below are passed/failed.

| Guard | Green | Red | Restored |
|---|---:|---:|---:|
| O1, O2, O3, O4, O6, O7 (each) | 1/0 | 0/1 | 1/0 |
| O5 fields / audit / version (each) | 1/0 | 0/1 | 1/0 |
| O9 draft / preview / confirm × attach / Move / Join | 9/0 | 0/9 | 9/0 |
| O9 initial registration | 1/0 | 0/1 | 1/0 |
| X1 + X6, and X1+ durability (each, three kinds) | 3/0 | 0/3 | 3/0 |
| X2, X4, X5, X7 (each) | 1/0 | 0/1 | 1/0 |
| O11 terminal orphan listing/discard, three kinds | 3/0 | 0/3 | 3/0 |
| O12 1,001 real terminal Tasks | 1/0 | 0/1 | 1/0 |
| O14 secondary audit failure | 1/0 | 0/1 | 1/0 |
| O15 terminal matrix | 12/0 | 9/3 | 12/0 |
| O8 UI call | 27/0 | 25/2 | 27/0 |
| U1 textable preview | 27/0 | 26/1 | 27/0 |
| U2 reopened search reset | 27/0 | 26/1 | 27/0 |
| Service-write inventory | exit 0 | exit 1 | exit 0 |

Loopback mutations are separate in `rev3/live-guards/summary.json`:

- **O13:** green 200 with the orphan present → remove only the server-side filter → red 409 → restore → 200. Exact requests, response IDs, result, and output are saved for all three states. The fake is not used.
- **O8 browser Cancel:** green, two completed scenarios → remove the Cancel discard call → red, persisted Person remains active → restore → green, two scenarios. All three stages use the real components, production Settings RouteSwitch in a synthetic shell, actual staff authentication and loopback Medplum. This is not full App startup proof.

O2b is the layered retained-Move/Undo regression. O10 is the no-break live regression: raw staff Person.active PUT is 403. X3 proves existing Undo resolves the discarded-destination operation and releases its claims. X6 checks the no-inactive-linked-Person invariant and goes red when X1/X7 are broken.

## Terminal matrix and loopback query

O15 covers attach/transfer/consolidate × completed, corrected after completion, corrected before linking, and reachable claim-conflict failure: **12/12**. All Tasks are produced by the real operation writers. Each named Person is linked, inactive, or active/zero-link with all terminal Complete/Correct attempts refused without writes. Every active/zero-link result is listed and discarded. Restored output includes the terminal Task status and Person state for every case. Removing `withoutLinks` deactivation makes three matrix cases fail. No stop condition was reached.

`live/rev3-query.json` records four real seeded Persons: omitted link, empty link, RelatedPerson link, and Patient link. Query: `Person?_id=<four seeded IDs>&link:missing=true&_count=100`. Medplum returned exactly the first two IDs. The scale proof additionally uses the production list handler, its normal practice-scoped pagination, and unchanged 1,000-row bound. See `rev3/live-guards/O13-*-resources/` for the exact query sequence and output. Medplum runtime is loopback `127.0.0.1:28860`, image/version already pinned by `live/live-runtime.json`.

The real HTTP operation proof in `rev3/live/operation-proof.json` and `operation-http.json` passed **9 scenarios, 105 assertions, 0 failures**. It covers the three X1 race kinds, stored pause/status/pending audit, X2 opposite order, existing Undo, retained Move/Undo, O10, attach-undone-before-link listing/discard, and O14's persisted primary audit. HTTP requests and resource snapshots are retained. Existing Undo can update fence metadata while preserving the discarded destination's inactive/unlinked state.

## Regression and provenance

- Named MCP regressions: `node --import tsx --test mcp/tests/guarantorUnused.test.ts mcp/tests/guarantorLinkOperation.test.ts mcp/tests/guarantorOwnedRecovery.test.ts mcp/tests/guarantorAttachOperation.test.ts mcp/tests/guarantorRegistrationAttach.test.ts mcp/tests/guarantorSearchScreens.test.ts`: **133 passed, 0 failed** (`rev3/focused-mcp.txt`).
- Named UI suites, run from `ui/`: `node --import tsx --test tests/guarantorSearchScreens.test.tsx tests/unusedGuarantorsSettings.test.tsx`: **27 passed, 0 failed** (`rev3/focused-ui.txt`).
- Full MCP, `ODOS_ALLOW_UNGATED_MCP=1 npm test` from `mcp/`, using the task fixture's separate test database: **5,437 tests; 5,385 passed; 0 failed; 52 skipped; exit 0** (`rev3/mcp-full.txt.gz`). This acknowledges ungated local live lanes; it does not replace final-head CI/live-authorization evidence.
- Full UI, `npm test` from `ui/`: **1,626 passed; 0 failed; 0 skipped** (`rev3/ui-full.txt.gz`).
- `npm --prefix mcp run build`: exit 0. `npm run preflight`: **0 warnings, 0 hard blocks**. Front-door coverage: **25 backend route families, 28 proxy entries, every family covered**. Exact output is in `rev3/`.

`source-sha256.json` and `rev3/provenance.json` bind the tested source and tests. Live proofs also store before/after source hashes. Revision 2 evidence remains available and sanitized; the revision 3 results above supersede its counts and disposition. Final-head CI, CodeRabbit commit statuses, PR-Agent checks, and the settled review-thread count are recorded in the PR delivery state after the final push, rather than claiming a pending bot wave is clean.

## Final bot-wave adjudication

The review at `62e8d72a` raised three additional findings. The sanitizer now handles macOS, Linux and Windows paths with fixed literal patterns; five representative cases pass (`rev3/sanitizer-check.txt`).

The proposed later activity checks were not added: the real discard attempted immediately after the attaching write returns 409, the destination stays active/linked, and the Task completes. This is recorded as `post-attach-discard-refused` in the nine-scenario live proof. Raw staff inactivation is already refused by the separate O10 policy check. A privileged external writer directly changing an already-linked Person to inactive would violate G1 at that write; later reads cannot retroactively enforce G1 for such an out-of-contract write.

**Remaining scale limitation, explicitly carried to Opus:** inactive zero-link Persons still consume the 1,000-row zero-link candidate bound. The bot's proposed `Person?active=true` and the contract-preserving candidate `active:not=false` were both executed on loopback and returned **400, Unknown search parameter: active**. Exact requests and responses are in `live/rev3-active-query.json` and `rev3/query-capability.txt`. Neither unsupported query was put into production. `active=true` would also change the contract's treatment of an absent active field. Further exclusion of inactive candidates needs a separately designed search/index contract; the approved zero-link filter, caps and fail-closed behavior remain unchanged.

## Limits and handoff

The bounded search still refuses if its server-filtered zero-link candidates or in-progress Tasks exceed 1,000. Inactive zero-link candidates are excluded by application eligibility after the server query; no new cap or unbounded pagination was introduced. Task scan/write are not atomic; G1 remains enforced by the engine and version conditions. No permissions or AccessPolicies changed. No new clinical codes, canonical FHIR artifact URLs, or regulatory assertions: Mandate 14 ledger rows added **0**. No new design decision: companion `decisions/INDEX.md` unchanged. Cross-repo follow-up is the separate Claude Opus evaluation of the final head against revision 3.

Iris is untouched; nothing merged or deployed. All three `guarantor-cleanup-a-live` fixture containers are stopped with exit code 0, not removed (`rev3/containers-stopped.txt`).
