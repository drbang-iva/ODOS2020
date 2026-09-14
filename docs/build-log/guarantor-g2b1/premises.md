# Guarantor G-2b-1 premise evidence

This record describes the **pre-build baseline at `a13fc1ea6322d29fa38216fbc06d03dffd079175`**, collected on 2026-09-14. The operator cleared the Task-reader premise and authorized the build. These baseline results do not report final feature checks, live operation proof, CI, or an independent evaluation.

## Checkout, dependencies, and anchors

The task started in a fresh worktree on branch `drbang-iva/guarantor-g2b1`. The freshly fetched `origin/main` and task HEAD both resolved to the base SHA above. The required scoped comparison exited 0 with an empty diff:

```sh
git diff --stat a13fc1ea origin/main -- mcp/src/clinic mcp/src/authz mcp/src/fhir-client.ts ui/src/lib/guarantor-editor.ts ui/src/components/patient/ResponsiblePartiesControl.tsx scripts/fhir-read-grant-check.ts
```

`npm ci` in `mcp/` and `ui/` exited 0, installing 262 and 150 packages respectively. The open-PR scope check found no overlap with the planned guarantor files. The following are **base-state observations**, not descriptions of the modified implementation:

| Anchor at the base | Observed behavior |
|---|---|
| `mcp/src/clinic/clinic-routes.ts:107` | Patient merge uses `serviceFhir.executeTransactionAsActor` with the staff reference and actor role. |
| `mcp/src/authz/roles.ts:363` and `:1033` | Staff Task and Person write rules have no `writeConstraint`. |
| `mcp/src/authz/roles.ts:1358` | Revoking a baseline business action records the revoke as ignored. |
| `ui/src/lib/guarantor-editor.ts:184` | Save checks the Person generation and writes the loaded child; it does not fresh-read each child before writing. |
| `ui/src/lib/guarantor-editor.ts:204` | Repair fresh-reads each child before checking the Person generation. |
| `mcp/src/fhir-client.ts:525` and `:270` | Ordinary `read()` uses the client headers; extended metadata is requested only when `extendedMode` supplies `X-Medplum: extended`. Default metadata omission was established by the preceding platform evaluation, not re-executed in this baseline run. |
| `mcp/src/clinic/responsible-party-demographics.ts:6` | Projection clones name, telecom, and address; telecom is replaced wholesale. |

## Baseline command results

| Command | Exit | Recorded output |
|---|---:|---|
| `npm --prefix mcp test` | 1 | 4,722 tests; 4,655 passed; 7 failed; 60 skipped; 0 cancelled; 94,333.969208 ms. |
| `npm --prefix ui test` | 0 | 1,485 tests; 1,485 passed; 0 failed; 0 skipped; 0 cancelled; 193,169.856125 ms. |
| `npm run preflight` | 0 | 0 warnings and 0 hard blocks. |
| `npm --prefix ui run build` | 0 | Vite production build completed in 2.34 seconds; existing large-chunk advisory. |

The seven MCP failures were the expected local-environment cases: five `claimReadModelStore` setup failures plus its teardown failure (`ECONNREFUSED 127.0.0.1:5433`), and the `disasterRecoveryCredentials` child-command test because the fresh worktree had no root `node_modules/tsx` loader. The harness separately reported 41 configured-live skips among the total 60. This suite run does not prove real authorization.

Each named file also ran separately with `node --import tsx --test tests/<name>.test.ts[x]` from its package directory. All exited 0:

| Package | File | Tests / passed | Failed / skipped |
|---|---|---:|---:|
| mcp | `guarantorPerson` | 11 / 11 | 0 / 0 |
| mcp | `patientRegistrationAuthz` | 29 / 29 | 0 / 0 |
| mcp | `patientInsuranceHonestSave` | 17 / 17 | 0 / 0 |
| mcp | `statements` | 33 / 33 | 0 / 0 |
| mcp | `commsSuppression` | 49 / 49 | 0 / 0 |
| mcp | `paymentAudit` | 5 / 5 | 0 / 0 |
| mcp | `businessActions` | 11 / 11 | 0 / 0 |
| ui | `guarantorEditor` | 9 / 9 | 0 / 0 |
| ui | `guarantorPropagation` | 22 / 22 | 0 / 0 |
| ui | `demographicsConcurrency` | 3 / 3 | 0 / 0 |
| ui | `engageSheet` | 18 / 18 | 0 / 0 |
| ui | `statements` — additional coverage | 14 / 14 | 0 / 0 |

Named total: **221 tests, 221 passed, 0 failed, 0 skipped**. The six two-source Mandate 14 rows are in [the source-verification ledger](../../../data/code-bindings/guarantor-g2b1-ledger.md).

## Task-reader census and operator ruling

The census found no identified normal worklist, board, or summary workflow that surfaces a newly created guarantor operation Task. It searched production Task references, dynamic read/search/history/version calls, raw FHIR URLs, includes/revincludes, and TypeScript call expressions in `mcp/src` and `ui/src`, then traced caller queries, parsers, returned data, and UI paths. Its AST inventory contained 552 named read/search-family calls, including non-FHIR stores, and 37 Task-literal read/search/helper calls plus education's `resourceInPractice` Task call. This is a static census by that method, not a live exercise of every reader.

| Reader group at the base | Disposition |
|---|---|
| Desk and clinic summaries; claim/ERA read models and worklists; reporting and margin ledger | Domain coding, status, focus, or projection checks exclude the operation from normal rows and counts. The claim projector may load the Task internally before discarding irrelevant signals. |
| Statements, education review, and watchers | Coded queries and domain parsers exclude or refuse it. Existing producer-specific identifiers do not collide with the operation identifier. |
| Lab-transmission board, stored lab exports, and optical lifecycle | Normal coded queries and parsers do not turn the operation into a board row. Direct artificial injection into the lab-board projector can increment its unprojectable count; current callers filter before that point. |
| Generic FHIR search and raw transport helpers | Intentional raw access can return the Task. Generic `fhir_search` visibility was already disclosed in the earlier reader evaluation. |
| Myopia activity expansion | An additional arbitrary CarePlan reference could return the operation as an activity resource. G-2b does not create that CarePlan reference. |
| Lab submit with a caller-supplied parent Task ID | The pre-existing submit validation gap accepts the supplied Task as the order parent and creates a separate lab-transmission Task. See the bounded probe below. |
| Other dynamic readers | Current callers use non-Task resource types or reject the operation through their resource/domain requirements. No automatic operation row was found. |

The operator's premise #4 ruling is **normal workflow surfacing**: a worklist row, board entry, or summary count. Intentional generic FHIR access is permitted. The caller-supplied lab parent is a pre-existing submit validation gap, separately filed and outside this slice; the lab module is not changed by G-2b-1.

The resulting G-2b requirement is explicit: **S5 step 0 must filter `based-on` Tasks by the guarantor-link-operation code system AND service authorship**. A lab-transmission Task based on an operation is ignored. The implementation's `checkCorrections()` performs a coded project search and applies the service-author/code/project predicate; the added guard is named `L24 step 0: foreign-code based-on lab Tasks and foreign-author operations are excluded`. This statement records the required distinction and inspected code; final guard and mutation results are separate implementation evidence.

## Bounded lab-parent probe

The [probe source](reader-lab-probe.mts) invokes the unchanged production manual lab handler and adapter with an injected, synthetic in-memory FHIR transport. It manually supplies a Task bearing the guarantor operation code. This is not a real service-authored operation, a live staff-policy session, or a production database record.

Run from the repository root after installing `mcp/` dependencies:

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs docs/build-log/guarantor-g2b1/reader-lab-probe.mts
```

The [recorded output](reader-lab-probe.json) and assertions show:

- Submit returns **200** and creates exactly **one separate lab-transmission Task** based on the supplied Task.
- The supplied operation-shaped Task remains unchanged.
- The board returns **200** with **one transmission row**; the operation itself is not that row.
- The caller must explicitly supply the parent ID. No network call, live Medplum server, external lab delivery, or real patient data was used.

This probe demonstrates the manual submit-path validation gap only. It does not prove automatic UI reachability, real AccessPolicy access, acceptance by every lab adapter, or any property of G-2b recovery. The Ocuco path was source-inspected during the census but not executed by this probe.
