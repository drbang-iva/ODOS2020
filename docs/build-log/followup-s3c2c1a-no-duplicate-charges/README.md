# S3c-2c-1a author evidence

NOT EVALUATED. Coder: Codex. Runtime model and effort are not exposed; recommended routing was Sol, high effort. Independent evaluator requested: Claude Opus 5. Do not merge before independent evaluation of the exact PR head.

Base fetched and verified: `4f05122857458aab412fddfe84fc4c1048987868`. Branch: `drbang-iva/followup-s3c2c1a-no-duplicate-charges`.

Manual create and removed-to-accepted revival refuse a same-concept live proposal on the same encounter. The exported helper counts staged, accepted, and finalized proposals from every origin. Check and write use the default protocol encounter lock. The 409 response uses `duplicate-charge` and the fee schedule display.

## Premises and scope

All read using `git show origin/main:<file>` after `git fetch origin`, never from the root checkout:

- P1: create checks chart.write, active coded non-visit fee, generated manual identity; baseline checks only that identity and saves accepted with principal diagnosis pointers.
- P2: PATCH supports accepted/removed, diagnosis pointer and laterality; manual identity and finalized guards are present; removed can revive.
- P3: default ProtocolService instances share the unexported encounter lock; commit and item-add run under it, including protocol staging's live-concept deduplication. Only the export declaration changed in protocol-service.ts.
- P4: procedureChargeApi forwards response errors through clinicalGraphResponseError; only concurrent-edit 409 maps to reload text; ProcedureChargeList renders procedure-charge-error. VisitChargesSheet embeds ProcedureChargeList.
- P5: both specified fixtures seed gonioscopy before a manual gonioscopy. Shared fixture seeds no proposals. The visit-only test remains unchanged.

Mechanical comparison confirms all pre-existing server test text is unchanged except these three calls in the two granted fixtures; UI tests are append-only; protocol-service is export-only:

```diff
# procedure lifecycle leaves the visit and every protocol proposal byte-identical
-protocolProposal("protocol-one")
+protocolProposal("protocol-one", { procedureConceptKey: "visual-field-threshold" })
-protocolProposal("protocol-two", { state: "accepted" })
+protocolProposal("protocol-two", { state: "accepted", procedureConceptKey: "visual-field-threshold" })
# behavioral acceptance: one visit and three procedure charges stay isolated through claim build
-protocolProposal("protocol-acceptance")
+protocolProposal("protocol-acceptance", { procedureConceptKey: "visual-field-threshold" })
```

No existing assertion changed. No production billing code, fee or concept changed. Synthetic proof reuses SYNTHA/SYNTHB and existing concepts. No Mandate 14 ledger addition applies. No new strategy decision was made, so decisions/INDEX.md was not changed. No outside-allowlist source change was needed.

## Guards

See [guard-results.txt](guard-results.txt) for every red and restored-green summary and [mutations.py](mutations.py) for reproducible mutations. Each red run had exactly one failed test; each restored run had one passed test. No cancellation or skip occurred.

| Guard | Deliberate break | Red observation | Restored |
|---|---|---|---|
| G1 | Skip create live check | 201 != 409 | pass 1, fail 0 |
| G2 | Skip revival live check | 200 != 409 | pass 1, fail 0 |
| G3 | Bypass create lock | 2 live != 1 | pass 1, fail 0 |
| G4 | Use another lock instance | 2 live != 1 | pass 1, fail 0 |
| G5 | Count only accepted | 201 != 409 for staged | pass 1, fail 0 |
| G6 | Map every 409 to reload | reload text != exact refusal | pass 1, fail 0 |
| G7 | Return concurrent-edit | concurrent-edit != duplicate-charge | pass 1, fail 0 |

G1-G5/G7 mutate only manual-procedure-charge-endpoint.ts. G6 uses the temporary UI-client grant and restores its original bytes in a finally block. G3 yields a test-local FHIR read; G4 pauses a completed empty live-charge read, starts a real default ProtocolService commit, then releases the read. Changing the lock produces two real stored proposals in each race guard.

```text
git diff 4f051228..HEAD -- ui/src/lib/clinical-graph-client.ts
(no output)
```

## Live proof

[Full synthetic responses](live-responses.txt), [runner](live-proof.ts), [disposable compose](compose.yml), and [browser preview](duplicate-charge.png).

- First Gonioscopy POST: 201, accepted, units 1.
- Duplicate POST: 409, `{"code":"duplicate-charge","error":"Gonioscopy is already charged on this visit."}`.
- Remove first: 200, removed. Re-add: 201, accepted.
- Add Fundus photography once: 201, accepted.
- Production sign-cleanup handler: 200, `{"abandoned":0,"materialized":2,"finalized":2}`.
- The same encounter-status transaction builder used by EncounterHeader finishes the encounter.
- Fresh real FHIR search: `{"encounterStatus":"finished","chargeItemCount":2,"amounts":[45,75],"totalUSD":120,"units":[1,1]}`. One-unit proof suffices because these endpoints write units 1.
- Chromium drives the actual ProcedureChargeList and procedureChargeApi against registered production manual routes backed by disposable Medplum. Duplicate click shows the exact sentence and retains one row. The screenshot is a component preview with fixture styling, not proof of the complete app route or live AccessPolicy enforcement. The endpoint fixture supplies a provider identity and uses a synthetic privileged FHIR client.

Reproduction from repository root (container names are project-prefixed; use an unused localhost port if needed):

```sh
npm run generate-medplum-signing-keys
docker-compose -p odos-s3c2c1a-live -f docs/build-log/followup-s3c2c1a-no-duplicate-charges/compose.yml up -d
# Wait for localhost:18103/healthcheck HTTP 200.
CAPTURE_PREVIEW=1 node --import tsx docs/build-log/followup-s3c2c1a-no-duplicate-charges/live-proof.ts
docker-compose -p odos-s3c2c1a-live -f docs/build-log/followup-s3c2c1a-no-duplicate-charges/compose.yml down -v
```

## Suite accounting

See [suite-summaries.txt](suite-summaries.txt). Full suites were run once on the unchanged base and once with the implementation and added tests. Every MCP full and focused run, including mutations, used `odos-s3c2c1a-postgres` and ODOS_POSTGRES_URL. PostgreSQL 16 was listening on localhost:25439. The live proof stack used its own separate Postgres.

| Suite | Base | Added | Head |
|---|---:|---:|---:|
| UI tests / passed | 1839 | 1 | 1840 |
| MCP tests | 6242 | 6 | 6248 |
| MCP passed | 6187 | 6 | 6193 |
| MCP skipped | 55 | 0 | 55 |
| Assertion failures | 0 | 0 | 0 |

UI exited 0. MCP wrapper exited 1 on both runs because 47 credentialed tests were recorded as unavailable (55 total skips). Do not describe the MCP wrapper or live-authorization gate as green. The targeted disposable live proof above is separate evidence; it does not convert skipped suites into executed coverage.

Commands (same on base and head):

```sh
npm --prefix ui test
ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:25439/medplum npm --prefix mcp test
npm run typecheck:scripts
npx --prefix mcp tsc --noEmit -p mcp/tsconfig.json
npx --prefix ui tsc --noEmit -p ui/tsconfig.json
npm run preflight
```

All three typechecks exited 0 at base and head. Both preflights: `0 warning(s), 0 hard block(s)`. Focused head files: server 37/37, UI 6/6. An initial UI focused invocation from repository root failed before assertions with `React is not defined`; running from ui/, as the suite does, passed without source changes. First browser preview attempt raced Vite dependency reload; waiting for network idle fixed the capture runner only.

## Cleanup, limitations and follow-ups

All task-owned containers and volumes stopped/removed. Final command/output:

```text
docker ps --format '{{.Names}}\t{{.Status}}'
vf-prac1b-walk-db    Up 2 days
```

The VisionForge container was not changed. This lock protects the existing one-MCP-process deployment; it is not a distributed lock. This slice does not repair previously stored duplicates.

Explicitly NOT DONE: Accept and any Follow-up tab change (1b); the staged protocol charge never becoming accepted gap; any manual visit-charge change. The exported helper is available for 1b. Independent Claude Opus 5 evaluation is outstanding. No merge authorized or performed.

Status: needs-review.
