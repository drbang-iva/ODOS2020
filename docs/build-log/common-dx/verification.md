# Common diagnosis starter and 20-row list — author evidence

NOT EVALUATED. Independent evaluation is required before merge.

Base: `a13fc1ea6322d29fa38216fbc06d03dffd079175`. Branch: `drbang-iva/common-dx`.
`source-hashes.json` binds these results to the exact production and test file contents.

## Behavior

The Common projection returns at most 20 rows, with pins first in saved order and usage filling remaining places. Stored pin lists are preserved, including lists longer than 20; only their first 20 eligible rows appear in Common.

New pick-created tallies carry `pinState: unset`; starter application writes `seeded`; explicit saves write `custom`, including empty saves. Legacy missing pin fields read as unset. Legacy empty arrays without state remain unchanged automatically. Starter application preserves counts and uses conditional writes; retries preserve concurrent custom saves. An empty save also persists custom intent when it loses conditional creation to a diagnosis pick.

`npm run reseed-common-diagnosis-pins` is dry-run by default. `npm run reseed-common-diagnosis-pins -- --apply` changes only ambiguous unmarked empty tallies. It shares starter resolution with the endpoint, reports unavailable starters, and refuses stale versions. It reuses the existing operator-script client and credential resolver. The apply option was exercised only with the in-memory transport, never against a server. After merge and deployment, applying the script remains an operator action.

## Checks

- `npm install`, `npm install --prefix mcp`, `npm install --prefix ui`: completed in the task worktree; no lockfile changes.
- `npm --prefix mcp test -- tests/diagnosisQuickList.test.ts`: 28 passed, 0 failed, 0 skipped.
- `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test`: 4,734 tests; 4,674 passed, 0 failed, 60 skipped; exit 0. The explicit opt-out acknowledges 41 credential-dependent live skips. This suite run does not gate live authorization. Its PostgreSQL target was this task's isolated synthetic database.
- `npm --prefix mcp exec tsc -- --noEmit -p mcp/tsconfig.json`: exit 0, no diagnostics.
- `npm run typecheck:scripts`: exit 0, no diagnostics.
- `npm run preflight`: 0 warnings, 0 hard blocks; exit 0. Run after the suite: its grant-check tests temporarily write source probes.
- `git diff --check`: clean.

The initial unconfigured suite had six failures (five tests plus their file hook) from PostgreSQL connection refusal at the default port. BASE had the same six failures: 4,722 total, 4,656 passed, 60 skipped. Configuring the task's own PostgreSQL removed those failures without changing application code.

Exact final check tails: [checks.txt](checks.txt).

## Mandate 17

Each test uses the real tally store and/or quick-list handlers. Legacy-format fixtures start with a real-store write and remove only the fields absent from that historical format; they are not hand-authored tally JSON. Mutants ran in a separate disposable worktree and were restored byte-for-byte before each green run.

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| G1 | Count 20 → 15 | 1 failed, exit 1 | 1 passed, exit 0 |
| G2 | Remove initialization of existing unset tallies | 1 failed, exit 1 | 1 passed, exit 0 |
| G3 | Remove missing-field compatibility state | 1 failed, exit 1 | 1 passed, exit 0 |
| G4 | Seed whenever pin arrays are empty | 1 failed, exit 1 | 1 passed, exit 0 |
| G5 | Merge starter into doctor's pins | 1 failed, exit 1 | 1 passed, exit 0 |
| G6 | Remove chart-write seed permission check | 1 failed, exit 1 | 1 passed, exit 0 |
| G7 | Seed ambiguous legacy empty arrays | 1 failed, exit 1 | 1 passed, exit 0 |
| G8 | Write during dry run | 1 failed, exit 1 | 1 passed, exit 0 |
| G9 | Remove script eligibility/idempotency skip | 1 failed, exit 1 | 1 passed, exit 0 |

Four additional mutations also went red/green: remove endpoint conditional-write header; remove script conditional-write header; accept an empty conditional-create result without recording custom intent; accept malformed pin-state arrays. Exact replacements and TAP output: [guard-results.txt](guard-results.txt), [mutations.json](mutations.json).

## Real Medplum proof

Medplum 5.1.30 on a fresh local synthetic stack, loopback port 19913; separate BASE and HEAD worktrees. Each flow creates a synthetic Practitioner, Patient, Encounter, and finding; POSTs a diagnosis pick through the real pick handler; then GETs the real quick-list handler. All FHIR reads and writes reach real Medplum. HTTP is a small handler harness with a fixed synthetic provider context: it does not prove the production router, login flow, or real AccessPolicy enforcement.

| Measurement | BASE | HEAD |
|---|---:|---:|
| Diagnosis pick status | 201 | 201 |
| Quick-list status | 200 | 200 |
| Starter pins | 0 | 14 |
| Common rows | 1 | 15 |
| Pick's usage count | 1 | 1 |

Exact outputs: [live-base.json](live-base.json), [live-head.json](live-head.json).

The actual operator CLI dry run against that same isolated instance listed one ambiguous tally, skipped two seeded tallies, and reported zero conflicts and zero unavailable starters. Before/after reads proved all three complete tally resources, including versions, unchanged. No server apply was executed. Outputs: [script-dry-run.json](script-dry-run.json), [script-dry-run-verification.json](script-dry-run-verification.json).

## Scope and follow-up

No pin UI, Findings table, plan sets, medical codes, FHIR artifact URLs, auth rules, or dependency changes. No new Mandate 14 ledger rows are needed. The operator's existing compatibility amendment supplies the decision; no new decision or decisions index entry was authored.

Pending: independent evaluation at the final PR head, merge, deployment, and the operator's one-time apply. The code intentionally preserves ambiguous legacy empty arrays until that separately authorized operation.
