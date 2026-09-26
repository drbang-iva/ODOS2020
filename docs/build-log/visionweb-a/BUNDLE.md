# VW-A sealed author bundle

Status: needs-review. NOT EVALUATED.

## Summary

Adds VisionWeb configuration, field-sheet serialization, SOAP upload parsing, OAuth/tracking client, write-ahead transmission Tasks, upload-state cancellation/advancement locks, shared read-only helpers, and dispatch construction. Server registration and the environment routing allowlist are unchanged. No credential document was opened. Two synthetic submissions occurred under the operator rulings; no further VisionWeb calls were made under R10.

Branch: `drbang-iva/visionweb-a-adapter`. Base: `4afa0b62c34111ce7b799c16a6a013239e6698a7`. Authoritative kickoff: performance-od `f3852de3`, revision 3. The PR head is the commit containing this bundle; the final handoff binds its exact SHA. Authoritative additions: operator R6–R10 in the task.

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
| `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` | 6493 tests; 6434 pass; 0 fail; 59 skipped; exit 0 | 6521 tests; 6460 pass; 0 fail; 61 skipped; exit 0 |
| `npm --prefix mcp exec -- tsc --noEmit -p mcp/tsconfig.json` | exit 0 | exit 0 |
| `npm run preflight` (serial) | exit 0 | exit 0; 0 warnings; 0 hard blocks |
| Discovered FHIR operations | 972 | 976 |

The suite explicitly reports that live authorization is not gated: 47 live-stack skips are acknowledged with ODOS_ALLOW_UNGATED_MCP=1. The final run adds 28 tests: 26 passing and two disabled private/live QA checks. No credentialed Medplum proof is claimed.

`GUARDS.md` quotes RED and restored GREEN summaries for all 18 offline mutations. V8a/V8b, the observed echo guard, and credential boundaries were re-proven under R10; supplemental exact RED/GREEN summaries follow the original 18 in GUARDS.md. `mutations.py` restores each changed product file in a finally block, then requires a successful green run.

Harness correction: the first standalone preflight overlapped the suite's intentional RiskAssessment probes. Serial re-execution after the suite passed. No assertions or product expectations were changed to address it. Missing dependencies were installed using locked npm ci in root, mcp and ui; manifests and lockfiles are unchanged.

## L1 and R6–R10

Transport reachability and acceptance are separate:

| Call | HTTP status | Content type | Result |
|---|---|---|---|
| Attempt 1 upload | 2xx only; exact status not retained | not retained | unreadable response; Task unknown; no retry |
| R9 OAuth token | 200 | application/json; charset=UTF-8 | bearer retained privately only |
| R7 history | 200 | application/json; charset=utf-8 | TotalRecords 0; empty Results for TEST LAST today UTC |
| R8 upload | 200 | text/xml; charset=utf-8 | SOAP service Error; no order identity or acceptance Status |

R9 authorized a new short ODOS-QA- identifier because history showed no trace of attempt 1. The live test persisted OrderId and msgguid before transmission. Exactly one token call, one history call and one further adapter submission occurred. No tracking call: no VWebOrderId was returned. No calls under R10. Q-V6 deduplication remains unanswered because the history did not recover attempt 1's identifier.

The service error is `Error occurred - see log for details.` This proves transport reachability, not vendor acceptance or a definitive order rejection. ERROR_MESSAGE contains no correlated OrderId/SupplierId: the parser returns Error without inventing them; the adapter's identity guard retains queued/unknown and refuses cancellation, advancement and resubmission. This behavior was replayed offline against the real response shape, not claimed as a new live success.

R10 classification (no credential values):

| Variable | Decoded element path | Match | Exact case | Count |
|---|---|---|---|---:|
| VISIONWEB_USERNAME | Envelope/Body/UploadFileResponse/UploadFileResult/(decoded)/ERROR_MESSAGE/LOGIN/@UserName | whole token; text withheld | yes | 1 |
| VISIONWEB_PASSWORD | Envelope/Body/UploadFileResponse/@xmlns | embedded in longer word | yes | 1 |

No other configured credential or bearer match was found in the upload. Reply elements: Envelope, Body, UploadFileResponse, UploadFileResult; decoded ERROR_MESSAGE, LOGIN (UserName withheld, RefID attribute), ERROR. No Status element. The raw upload remains private. Code replaced the whole username occurrence with REDACTED-VISIONWEB_USERNAME; the copy passed whole-token credential and ten-digit checks before becoming qa-upload-response.xml. The token capture correctly fails disclosure checking; history passes; raw upload fails; redacted upload passes. Password/secret/token matching is case-sensitive; username/client ID matching is case-insensitive. Product sanitizeVendorText remains conservative substring redaction.

The R6 test verifies response bytes and status/content-type metadata exist before parsing, with directory mode 700 and files mode 600. Removing the capture write: 1 failed / 1 skipped, exit 1; restored: 1 passed / 1 skipped, exit 0. R10 V10 substitutes a fake sentinel at LOGIN/@UserName and verifies no leakage into Tasks, audits, thrown errors or console output. Deliberately logging the raw reply makes it fail; restoration passes.

No outside-allowlist edits were needed. The existing fixturePhiGuard is unchanged. Bot review and independent Claude evaluation remain required before merge.

## Deferred scope and risks

Per kickoff: lab routing/directory, transport stamp, UI lab picker, index registration, routing allowlist and staff-attested cancellation (VW-B); supplier list, catalog download, code mapping, tracking mapper/sync and unknown-outcome reconciliation (VW-C); manual/Ocuco helper migration; vendor cancellation API; production enablement; digital-lens parameters; frame traces.

Concurrent-submit safety is deliberately absent, as ruled in R2. A shared atomic reservation for all three adapters must land before VW-B. Unknown or uploading outcomes block local cancellation and advancement. Missing/unrecognized upload-state codes also block. No live AccessPolicy proof is supplied by the in-memory QA harness or these unit tests.

No new strategy decision was made, so performance-od and decisions/INDEX.md were not edited. No medical terminology codes were added; no Mandate 14 ledger rows were added (data files are outside the allowlist). Custom VisionWeb FHIR identifier/code-system URIs follow the supplied kickoff; they are not claimed as separately published FHIR artifacts.

Author validation is not independent evaluation. Claude must evaluate the eventual final head before merge.

The first R10 suite hit only the explicitly named educationEnrollmentApi fetch-failed flake (6459 pass / 1 fail / 61 skipped); its authorized file-alone rerun passed 56/56. A final isolated full run passed 6460 / 0 / 61. The initial R10 suite had only old preflight reports in this worktree's .odos directory; those were moved aside before the final full run and restored after serial preflight. No product assertions were changed for either correction.

Fetched origin/main is 8798cf07372f4e0746ecf33c899c39ae63d1bdc1 (unrelated visit-charge change); all cited lab-order premise files remain unchanged from the pinned base. Open-PR scopes were checked and do not overlap this diff. The canonical checkout remained clean and untouched.

## Cleanup

The task-owned Postgres container was stopped. The unrelated existing service was left running. `docker ps --format '{{.Names}} {{.Image}} {{.Ports}}'` after cleanup:

```text
vf-prac1b-walk-db pgvector/pgvector:0.8.6-pg17 127.0.0.1:55481->5432/tcp
```
