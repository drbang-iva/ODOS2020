# Deliberate guard mutations

Every mutation was restored before the green rerun. Operator files were moved aside. MCP commands used dedicated S0 Postgres via ODOS_POSTGRES_URL.

Command pattern: `node --import tsx --test --test-name-pattern=<guard> <test file>`. A1-A7: `mcp/tests/encounterAbandon.test.ts`; A9: `mcp/tests/threeRoleModel.test.ts`; A10: `mcp/tests/r10A3ReleaseChecker.test.ts`; A11: `ui/tests/encounterAbandon.test.tsx`.

| Guard | Broken | Restored |
|---|---|---|
| A1 | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-Observation | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-Condition | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-Procedure | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-DiagnosticReport | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-DocumentReference | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-Media | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-QuestionnaireResponse | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-ServiceRequest | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-MedicationRequest | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-MedicationStatement | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-MedicationAdministration | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-DeviceRequest | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-CarePlan | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-ChargeItem | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-ChargeProposal | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A2-PlanActionInstance | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A3 | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A4 | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A5 | `# tests 2; # pass 0; # fail 2; # skipped 0` | `# tests 2; # pass 2; # fail 0; # skipped 0` |
| A6 | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A7 | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A8 live Provider policy removed before fresh installation | signed raw PATCH returned 200 rather than 403; `# tests 1; # pass 0; # fail 1; # skipped 0` | fresh R6 policy installation, signed raw PATCH refused 403 and unsigned raw PATCH succeeded 200; `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A9 | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A10 | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A11 | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |

## R3 existing-guard corrections

The authorized edits were each deliberately broken, the affected existing test went red, and restoration went green. All three files were restored before the full suites.

| Guard | Broken | Restored |
|---|---|---|
| Composite signed-status constraint removed | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| New UI client shared import removed | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| First moved grant-scanner exclusion restored to stale line | `# tests 1; # pass 0; # fail 1; # skipped 0`; no longer matches a real ungranted call site | `# tests 1; # pass 1; # fail 0; # skipped 0` |

## R4 abandon confirmation

| Guard | Broken | Restored |
|---|---|---|
| A13 counter changes after confirmation opens; restore silent return | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| A13 visit id changes during confirmation; remove navigation check | `# tests 1; # pass 0; # fail 1; # skipped 0` | `# tests 1; # pass 1; # fail 0; # skipped 0` |

## Review finding: abandon route limit

CodeQL flagged the new write route for missing rate limiting at `e41dfb87`. With the newly added middleware removed, the 121st request returned 401 rather than the required 429: `# tests 1; # pass 0; # fail 1; # skipped 0`. Restored, the test reported `# tests 1; # pass 1; # fail 0; # skipped 0`; the first 120 requests reached authentication and the 121st did not.

## Independent-evaluation fixback at `e73a0130`

| Guard | Broken | Restored |
|---|---|---|
| A6 finished migrated Encounter; move migrated check below closed check | `# tests 1; # pass 0; # fail 1; # skipped 0` (`encounter-signed` rather than `encounter-migrated`) | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| Retracted Condition has `verificationStatus` and no `status`; remove the Condition branch | `# tests 1; # pass 0; # fail 1; # skipped 0` (409 rather than 200) | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| Abandon route failure logging; remove the log call | `# tests 1; # pass 0; # fail 1; # skipped 0` (empty log) | `# tests 1; # pass 1; # fail 0; # skipped 0` |
