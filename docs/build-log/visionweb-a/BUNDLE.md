# VW-A offline implementation checkpoint

Status: blocked on the operator-supplied QA env-file path. NOT EVALUATED.

## Summary

Adds VisionWeb configuration, field-sheet serialization, SOAP upload parsing, OAuth/tracking client, write-ahead transmission Tasks, upload-state cancellation/advancement locks, shared read-only helpers, and dispatch construction. Server registration and the environment routing allowlist are unchanged. No real credential document was opened and no order was submitted to VisionWeb.

Branch: `drbang-iva/visionweb-a-adapter`. Base: `4afa0b62c34111ce7b799c16a6a013239e6698a7`. Authoritative kickoff: performance-od `f3852de3`, revision 3. PR: pending L1/V8b. The commit containing this bundle is the offline checkpoint, not an evaluated shipping head.

## Files

- New `mcp/src/integrations/visionweb/{config,visionWebClient,uploadResponse,vwOrderSerializer}.ts`.
- New `mcp/src/lab-orders/lab-transmission-helpers.ts` and `adapters/visionweb-lab-order-adapter.ts`.
- Edited `mcp/src/lab-orders/lab-order-dispatch.ts`.
- New config, serializer, response, client, helpers, adapter and skipped QA test files under `mcp/tests/`.
- Vendor response samples and synthetic test support under `mcp/tests/fixtures/visionweb/`.
- Edited `mcp/tests/labOrderDispatch.test.ts`: only G1 changed among existing lines; one test appended.
- This build-log directory contains the progress record, mutation runner and RED/GREEN summaries.

G1: line 76 `assert.equal(isLabOrderVendorId("visionweb"), false)` becomes `true`. No G2 change. Existing routing rejection remains.

## Premises

P1–P14 reverified. P1, P2, P4–P8, P10–P13 source files are byte-identical to the previously verified cd05d5c9 versions. P3 registration remains at index.ts:5980–5988. P14 has 19 statusReason matches; Communication, Procedure, statement and watcher paths do not address lab transmission Tasks. Watcher actions validate the watcher code before writing.

P9 re-fetched without authentication on 2026-09-26 from `https://services.visionwebqa.com/FileUpload.asmx?WSDL`:

- soapAction: `http://services.visionweb.com/UploadFile`
- namespace: `http://services.visionweb.com`
- request sequence: `username, pswd, filestring, subordid, refid, guid, msgguid, sloid, cbsid, ordtype, filename`; each has minOccurs=0.
- response: `UploadFileResponse/UploadFileResult`, type `s:string`.

## Verification

Dedicated synthetic Postgres named `odos-vwa-visionweb-a-20260926`; its URL supplied through `ODOS_POSTGRES_URL`. No canonical-checkout or other-worktree operator files were moved. This worktree initially had no `.odos/` directory.

| Check | Before | After |
|---|---:|---:|
| `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` | 6493 tests; 6434 pass; 0 fail; 59 skipped; exit 0 | 6516 tests; 6456 pass; 0 fail; 60 skipped; exit 0 |
| `npm --prefix mcp exec -- tsc --noEmit -p mcp/tsconfig.json` | exit 0 | exit 0 |
| `npm run preflight` (serial) | exit 0 | exit 0; 0 warnings; 0 hard blocks |
| Discovered FHIR operations | 972 | 976 |

The suite explicitly reports that live authorization is not gated: 47 live-stack skips are acknowledged with ODOS_ALLOW_UNGATED_MCP=1. The after run adds 23 tests: 22 passing and the disabled QA test. No credentialed Medplum proof is claimed.

`GUARDS.md` quotes RED and restored GREEN summaries for all 18 offline mutations. V8b remains unrun because there is no L1 capture. `mutations.py` restores each changed product file in a finally block, then requires a successful green run.

Harness correction: the first standalone preflight overlapped the suite's intentional RiskAssessment probes. Serial re-execution after the suite passed. No assertions or product expectations were changed to address it. Missing dependencies were installed using locked npm ci in root, mcp and ui; manifests and lockfiles are unchanged.

## Outstanding

- Operator supplies the path to a gitignored file containing VISIONWEB_* settings. Do not paste credentials into chat.
- Run L1 once against the exact QA host, with synthetic data; report HTTP reachability separately from vendor acceptance.
- Save the raw response only after the prescribed secret and ten-digit checks. Implement the captured-response expectation from that observed result, run V8b and the unchanged fixture guard, and repeat affected checks.
- PR, exact-head bot review and independent Claude evaluation remain outstanding. This is not ready for merge.

## Deferred scope and risks

Per kickoff: lab routing/directory, transport stamp, UI lab picker, index registration, routing allowlist and staff-attested cancellation (VW-B); supplier list, catalog download, code mapping, tracking mapper/sync and unknown-outcome reconciliation (VW-C); manual/Ocuco helper migration; vendor cancellation API; production enablement; digital-lens parameters; frame traces.

Concurrent-submit safety is deliberately absent, as ruled in R2. A shared atomic reservation for all three adapters must land before VW-B. Unknown or uploading outcomes block local cancellation and advancement. Missing/unrecognized upload-state codes also block. No live AccessPolicy proof is supplied by the in-memory QA harness or these unit tests.

No new strategy decision was made, so performance-od and decisions/INDEX.md were not edited. No medical terminology codes were added; no Mandate 14 ledger rows were added (data files are outside the allowlist). Custom VisionWeb FHIR identifier/code-system URIs follow the supplied kickoff; they are not claimed as separately published FHIR artifacts.

Author validation is not independent evaluation. Claude must evaluate the eventual final head before merge.

## Cleanup

The task-owned Postgres container was stopped. The unrelated existing service was left running. `docker ps --format '{{.Names}} {{.Image}} {{.Ports}}'` after cleanup:

```text
vf-prac1b-walk-db pgvector/pgvector:0.8.6-pg17 127.0.0.1:55481->5432/tcp
```
