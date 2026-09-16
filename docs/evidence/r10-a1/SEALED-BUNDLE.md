# R10 A1 — F1–F4 fixback, NOT EVALUATED

Author: **GPT-6 Astra (Codex), high effort**. Independent evaluator: **Claude Opus**. Prior evaluation at `1838b75b94a22c3c78bef6f25e6778abf49dbddd`: **NEEDS-WORK**. This fixback needs a new independent evaluation. No author evaluation marker, merge or deployment.

PR: [#608](https://github.com/drbang-iva/ODOS2020/pull/608), branch `drbang-iva/r10-a1`, worktree `<repo-root>`. This evidence is sealed by its containing commit; the exact final head SHA is recorded in the PR description and delivery message, avoiding a self-referential commit hash in this file.

## What changed

- **F1:** Every one of the ten completeness captures calls the real private `keyFindingSatisfied` with captured arguments and compares to `c.result`. It also calls that predicate with projected current/history observations and compares again. Captured dates are rehydrated as Date objects. A test-only module loader exposes the actual function; production exports and behavior are unchanged.
- **F2:** P7 now invokes an explicit diagnostic client retry of the original command. The retry reloads and compares the actual Observation and Condition before deciding whether to call the real existing mutation endpoint. Provider sees `already-applied`; staff sees `partial-refused` after the observed Condition 403. Both produce zero FHIR writes and unchanged versions. After the other login changes the Observation, executing the same retry returns `conflict`, produces zero writes, and preserves the intervening version. The separate stale If-Match control returns 412. This proves the diagnostic recovery path; it does not claim an A2 application writer exists.
- **F3:** Removed full-suite TAP, per-suite dumps, duplicate setup/debug logs and obsolete evidence files. HTTP events remain complete, one event per line. Red logs contain only the first failing assertion (or the two role-specific P7 assertions). All retained evidence passes the final publication sanitizer; local filesystem roots/account names are replaced by `<repo-root>` / `<local-account>`. Future JSON evidence goes through the same sanitizer in `r10-preflight.mjs`; `sanitize-evidence` applies it to the entire retained directory.
- **F4:** The capture loader moves a direct declaration's export onto its wrapper. A new child-process test imports and executes both named exported targets and verifies both captures. `R10_RECORD_DIVERGENCES=1` regenerates `parity-divergences.json` in place: **every change requires line-by-line independent review**. Regeneration is not approval of a new difference.

Changed code/test files: `mcp/scripts/r10-preflight.mjs`, `mcp/tests/r10-parity.test.ts`, and `mcp/tests/fixtures/r10/{completeness-predicate.mjs,capture-baseline.mjs,README.md}`. Other changes are confined to this evidence directory. No production library, existing assertion, policy, registry entry, UI, handler or application writer changes in this fixback.

**A1 only READS supports-diagnosis in application code. A2 is the first application writer.** The approved registry entry remains exactly URL `https://odos2020.com/fhir/StructureDefinition/supports-diagnosis`, namespace `clinical-graph`, status `active`, sliceConsumer `r10-a1`.

## Executed F1 / F2 controls

All mutations were applied in a detached scratch worktree and restored. No mutated production code is committed.

| Guard | RED | Restored GREEN |
|---|---|---|
| F1: invert the real private completeness predicate's result | **10 failing completeness assertions**, exit 1 | **10 passed / 0 failed**, exit 0 |
| F2a: force the first retry to call the writer unconditionally | Both roles: **2 FHIR writes != 0**, exit 2 | Both roles: **0 retry writes**, exit 0 |
| F2b: force the retry to write after the intervening edit | Both roles: **2 FHIR writes != 0**, exit 2 | Both roles: **0 conflict-retry writes**, versions unchanged, exit 0 |

Commands: F1 from scratch `mcp/`: `node --import tsx --test --test-name-pattern=keyFindingSatisfied tests/r10-parity.test.ts`; F2 from scratch root: `node --import tsx mcp/scripts/r10-preflight.mjs p7`. Failing assertion excerpts: [F1](guards/F1-red.txt), [F2a](guards/F2a-red.txt), [F2b](guards/F2b-red.txt). Exact mutation descriptions, commands and exits: [guards/results.json](guards/results.json).

The original G1–G10 twelve mutations and registry removal guard remain recorded in the same results file; their production library code is unchanged. Registry removal was **17 pass / 1 fail**, restoration **18 pass / 0 fail**. The source ledger is documentary: **this list is not enforced**; the runtime guards above are executed assertions.

## Live preflight

Only P7 was rerun in the final task worktree: `node --import tsx mcp/scripts/r10-preflight.mjs p7`. P1–P6, including the staff link amendment, were retained without rerunning. The scratch mutant runs use separate synthetic encounters and are represented by their assertion results, not mixed into the published final HTTP trace.

- Final status: **11 PASS / 2 EXPECTED_UNDER_RULING / 2 INFORMATIONAL; stop=false**.
- Provider P7 events **164–187**: already-applied retry, zero writes; staff intervening edit; conflicting retry, zero writes; stale PUT 412.
- Staff P7 events **188–210**: actual Condition 403; partial-refused retry, zero writes; provider intervening edit; conflicting retry, zero writes; stale PUT 412. The partial state is preserved, not called a completed link.
- All **210 HTTP events** retain request/response bodies, statuses, IDs and versions in [preflight-http.json](preflight-http.json). [preflight-results.json](preflight-results.json) identifies current ranges and marks the original P7 results as superseded.
- P1: concurrent create 201/200, one resource, retired reuse 200, duplicated fixture 412. P2: fresh 200/stale 412 and five races per role with one winner each. P3: both retired statuses searchable. P4: history 200 (informational). P5: same identity survives retire/restore/reassert. Provider P6: unrelated evidence retained, fresh 200/stale 412, Provenance 201. Staff P6: Condition 403 expected; finding extension update 200/412.

Runtime: isolated synthetic project `odos-r10-a1`, Medplum `127.0.0.1:29013`, version **5.1.30-9b1bd92**, image digest `sha256:358ab425b29390067b6cb82bfbaeee48580a703f7cc5b730bed2b2ba7184c1de`. See [runtime.json](runtime.json). Real non-admin synthetic logins `r10-provider@example.invalid` and `r10-staff@example.invalid`; effective policies, IDs/versions and memberships in [principals.json](principals.json). No permissions widened. Sessions are reused when valid to avoid repeated-login throttling; no credential or account settings change.

[Mandate 14](mandate-14.md): four protocol/type rows, HL7 R4 plus official Medplum sources, accessed 2026-09-15. The Observation extension is 0..*, valueReference is permitted, and the Condition target restriction is ODOS-local. No new medical code or ledger row needed for this fixback.

## Checks

| Check | Executed result |
|---|---|
| `npm --prefix mcp test` | **5,281 passed / 0 failed / 51 skipped**, 5,332 total; exit 0 |
| `npm --prefix ui test` | **1,560 passed / 0 failed / 0 skipped**; exit 0 |
| `npm --prefix mcp run build` | exit 0 |
| `npm --prefix ui run build` | exit 0; existing chunk-size warning |
| `npm run preflight` | **0 warnings / 0 hard blocks**; exit 0 |
| `node --import tsx --test tests/r10-parity.test.ts` from `mcp/` | **170 passed / 0 failed / 0 skipped**, including the named-export capture test |
| `node --check mcp/scripts/r10-preflight.mjs` | exit 0 |
| `git diff --check` | exit 0 |

MCP skips include **43 general live Medplum tests** and eight other environment-dependent checks. Compared with the previous author's 5,280/0/51 run, the new export-capture test accounts for the one added pass. The identity (15), reader (24) and history-helper (62) tests remain unchanged and pass in the full run.

Pre-existing assertions unchanged. History remains **61/61 byte-identical**; [helper-extraction-proof.json](helper-extraction-proof.json) records unchanged declarations. Original nine suite counts: diagnosisFindings 42, customSectionEndpoint 55, examOverviewProjection 22, findingDefinitionStore 13, diagnosisLinkL1 28, L2 47, L3 4, cupDiscEndpoint 8, glaucoma-suspect-clinical-graph 49. Those suites execute inside the full MCP run.

The full MCP run uses disposable PostgreSQL at `127.0.0.1:29032/odos_r10_tests`, with credentials injected privately and `ODOS_ALLOW_UNGATED_MCP=1`. General live Medplum integration skips are disclosed with the final counts; this full-suite run is not live authorization proof. The separate required P1–P7 evidence above uses real policies and storage. Full TAP logs remain ignored locally and are not published.

## Eight CodeRabbit dispositions

The five privacy comments are addressed together; none was dismissed as a false positive. Replies and resolutions are recorded on the corresponding PR threads after pushing this fixback.

| Thread | Disposition |
|---|---|
| [4021532846](https://github.com/drbang-iva/ODOS2020/pull/608#discussion_r4021532846) | F3: remove dumps, trim assertion evidence, sanitize all retained files |
| [4021532853](https://github.com/drbang-iva/ODOS2020/pull/608#discussion_r4021532853) | F3: remove dumps, trim assertion evidence, sanitize all retained files |
| [4021532854](https://github.com/drbang-iva/ODOS2020/pull/608#discussion_r4021532854) | F3: remove dumps, trim assertion evidence, sanitize all retained files |
| [4021532857](https://github.com/drbang-iva/ODOS2020/pull/608#discussion_r4021532857) | F3: remove dumps, trim assertion evidence, sanitize all retained files |
| [4021532859](https://github.com/drbang-iva/ODOS2020/pull/608#discussion_r4021532859) | F3: remove dumps, trim assertion evidence, sanitize all retained files |
| [4021532863](https://github.com/drbang-iva/ODOS2020/pull/608#discussion_r4021532863) | F2: execute retry and both write-count guards |
| [4021532888](https://github.com/drbang-iva/ODOS2020/pull/608#discussion_r4021532888) | F4: preserve and test named exports |
| [4021532893](https://github.com/drbang-iva/ODOS2020/pull/608#discussion_r4021532893) | F1: execute captured/projected completeness predicate |

## Evidence inventory

Retained **24 files / 3,996 lines**, down from approximately 186,496 evidence lines at the reviewed head. Full dumps remain only in ignored local storage.

- `SEALED-BUNDLE.md`
- `guards/F1-red.txt`
- `guards/F2a-red.txt`
- `guards/F2b-red.txt`
- `guards/G1-red.txt`
- `guards/G10-red.txt`
- `guards/G2-red.txt`
- `guards/G3-red.txt`
- `guards/G4a-red.txt`
- `guards/G4b-red.txt`
- `guards/G4c-red.txt`
- `guards/G5-red.txt`
- `guards/G6-red.txt`
- `guards/G7-red.txt`
- `guards/G8-red.txt`
- `guards/G9-red.txt`
- `guards/results.json`
- `helper-extraction-proof.json`
- `mandate-14.md`
- `preflight-http.json`
- `preflight-results.json`
- `principals.json`
- `runtime.json`
- `validation.txt`

No local account name, workstation path, credential or private-key block remains in the published evidence. Paths in raw HTTP such as `/fhir/R4/Observation` are protocol request targets, not workstation filesystem paths, and are retained unchanged.

## Cleanup, risks and status

The detached fixback mutation worktree was removed after restoring the predicate and retry mutations. The task worktree is retained. Stopped, not removed, with `docker ps -q --filter "name=^odos-r10-a1-" | xargs -r docker stop`:

- `odos-r10-a1-test-postgres 15142aa32c1d exited`
- `odos-r10-a1-medplum-1 16332e771c42 exited`
- `odos-r10-a1-postgres-1 1d721efacf0f exited`
- `odos-r10-a1-redis-1 911cda9c3276 exited`

Zero task containers are running. Other services were untouched.

The five declared retired-option overview divergences remain: transformed views have no safe aggregate FHIR ID, so A2/A3 must adapt consumers together with writers. Carry attribution remains explicit/unknown; negative acts remain raw. The separate staff diagnosis-action gate is outside this slice. The source function used by P7 still has the documented staff half-write; this probe does not repair it.

**NOT EVALUATED.** Request independent Claude Opus re-evaluation at the final PR head. No author verdict, evaluated label, merge or deployment. No new decision was created, so no `decisions/INDEX.md` update.
