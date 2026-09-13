# INS-1 author evidence — in progress, NOT EVALUATED

Base/head before implementation: `bba0f46068f9ad93bc5b126a7dfe0f98f1f76ab2`.
Branch: `drbang-iva/insurance-ins1`. INS-2 merged first (#589).

## Baseline and operator ruling

`npm ci --prefix mcp` and `npm ci --prefix ui` completed in the isolated worktree.
`npm --prefix mcp test`: 4,637 passed, 8 failed, 60 skipped, exit 1.
The operator ruled these failures pre-existing and environment-only and instructed this slice not to fix the environment or investigate the failures. The operator reports CI `mcp — install + typecheck + tests` green at the base SHA above.

The eight failures, with the file-level failure normalized to a repository-relative path:

1. rebuild is atomic and server-side worklist grouping returns honest untouched facts
2. never-paid-untouched aggregation is performed by payer and month in PostgreSQL
3. reconciliation detects a corrupted money row and a rebuild restores exact FHIR-derived truth
4. an older per-claim upsert cannot overwrite a newer completed rebuild
5. an older rebuild snapshot fails loudly without publishing incomplete FHIR truth
6. mcp/tests/claimReadModelStore.test.ts (file-level failure)
7. B5 only action-holding staff can record an opt-out
8. drill child commands never inherit the persistent Redis password

Failures 1–6: no PostgreSQL at 127.0.0.1:5433. Failure 7: order-dependent, passes alone (99/99) and in CI per operator ruling. Failure 8: missing root tsx dependency. No remediation or investigation belongs to INS-1.

Focused baseline command: `npm --prefix mcp test -- tests/patientInsuranceRoutes.test.ts tests/insuranceBenefitExtensions.test.ts tests/insuranceConfig.test.ts tests/insuranceConfigParity.test.ts`: 11 passed, 0 failed, 0 skipped.

Amended regression requirement (not a CI result): identical eight local failure names and pass count increased by added tests; authoritative CI MCP job must be green at final PR head; focused insurance tests green against baseline 11; zero ui/ files in the diff.

## Implementation and scope

RelatedPerson PUTs require ifMatch and execute alone before Coverage. Every insurance transaction disables the existing transport's compensating-delete default locally; the transport itself is unchanged. Both handlers inspect every returned entry status. Any entry-level 412 returns 409; other entry failures return 502. The response names confirmed successful locations, including the earlier subscriber update if Coverage fails later. The business audit is denied and names failed entries and written locations. No retry or compensation is introduced.

Before any Coverage write, the handler checks current server RelatedPerson resources by _id and Person links with the unchanged staff client. Either imported registration extension (presence, including false) or a Person link blocks with 422. New subscriber POSTs stay with their Coverage so the URN resolves. Entry URL/resource mismatches and noncanonical subscriber references are refused before writes to prevent a request from bypassing this fence. Patient self-subscriber references remain supported.

Scope exceptions:

- registration: two constants exported, no behaviour change (approved by evaluator)
- body role-extension refusal added at evaluator direction (CodeRabbit finding), extends the kickoff's current-resource definition

S5 rejects either submitted role extension on POST or PUT, by presence regardless of boolean value, with 422 "Insurance cannot set responsible-party roles. Use the guarantor editor." before current-resource lookups or transaction submissions. S3 still examines current server resources and Person links. The bundled RelatedPerson must identify Coverage.subscriber before any independent write.

The registration file is verified byte-for-byte against base with exactly the two approved export keywords added. No ui/ file, transport, statements, communications, claims builder, AccessPolicy/role declaration, or existing test body changed. No new terminology or FHIR artifact URL was introduced; the existing registration constants are imported. Mandate 14 ledger additions: none. No new design decision or performance-od change.

## Checks

| Check | Baseline | Current |
|---|---|---|
| npm --prefix mcp test | 4,637 pass / 8 fail / 60 skip | 4,655 pass / 7 fail / 60 skip |
| Focused insurance (same four baseline files plus patientInsuranceHonestSave.test.ts) | 11 pass | 28 pass / 0 fail |
| ./mcp/node_modules/.bin/tsc --noEmit -p mcp/tsconfig.json | not rerun as baseline | exit 0 |
| Scope check | no source drift | exactly two registration exports; zero ui changes; zero existing test edits |

There are 17 added tests. The additional 18th pass in the full suite is pre-existing order-dependent B5 passing this time. The seven remaining failures are a strict subset of the recorded baseline eight. No communications investigation or environment remediation was performed. This differs from the operator's literal exact-eight requirement; acknowledgment was requested. Final-head CI remains authoritative. The previous head efe49561577ca21765c7cd922692bf313c694edf passed the MCP job in CI run 34784702743 (4,670 passed / 0 failed / 47 skipped in the main test step; credentialed integration 12 + 218 passed; authorization 48 passed). That result does not cover subsequent review fixes. Final review-fix head status is recorded in the PR checks and PR body after that run completes.

## Mandate 17

The initial 13-test fixture suite replayed against the base handler fails 13/13. The final suite adds the reviewed subscriber-binding case, I10/I11, and a subscriber-only POST positive control, bringing it to 17 tests. The binding and role-refusal additions each failed before implementation. Restored final code passes 17/17. All per-entry failure fixtures return a transaction-response, not a thrown error. They record submitted bundles and audit rows. Tests also verify compensation is disabled. The pure inspection mechanic was first applied to Coverage and then to vision benefits; the same mechanic serves both callers.

| Guard / failing test | Deliberate break | Green | Red | Restored |
|---|---|---|---|---|
| I10 POST carrying primary role false refuses before server requests | Check submitted role extensions on PUT only | 17 pass | named test fails | 17 pass |
| I11 PUT adding consent authority refuses before current-resource lookup | Remove submitted-role refusal and rely on current-server lookup | 17 pass | named test fails | 17 pass |
| Bundled RelatedPerson must identify Coverage subscriber before any write | Allow bundled RelatedPerson to differ from Coverage.subscriber | 17 pass | named test fails | 17 pass |
| I1 stale subscriber stops before Coverage | Submit subscriber and Coverage together | 17 pass | named test fails | 17 pass |
| I2 mixed create response reports surviving subscriber and denied audit | Ignore mixed Coverage response failure | 17 pass | named test fails | 17 pass |
| I3 unversioned subscriber PUT submits nothing | Remove version requirement | 17 pass | named test fails | 17 pass |
| I4 primary extension alone fences guardian | Recognize consent-authority only | 17 pass | named test fails | 17 pass |
| I5 Person link alone fences guardian | Ignore Person links | 17 pass | named test fails | 17 pass |
| I6 current server extensions cannot be omitted by request body | Use body extensions instead of current server resource | 17 pass | named test fails | 17 pass |
| I7 Coverage-only existing guardian reference is fenced | Fence PUT targets only | 17 pass | named test fails | 17 pass |
| I8 versioned subscriber-only update succeeds before Coverage | Deny the successful positive control | 17 pass | named test fails | 17 pass |
| I9 mixed vision benefits response is denied with written locations | Skip vision response inspection | 17 pass | named test fails | 17 pass |
| Insurance entry URLs cannot disguise a guardian write as Coverage | Remove entry target validation | 17 pass | named test fails | 17 pass |
| Noncanonical subscriber references cannot bypass the guardian fence | Remove canonical-reference validation | 17 pass | named test fails | 17 pass |
| I1 stale subscriber stops before Coverage | Enable transport compensation | 17 pass | named test fails | 17 pass |

I8 is a positive control, also deliberately broken at the success audit. No guard is decorative. See guards/mutations.json, the reproduction runner, and each red/restored TAP output.

## Real-server proof

Disposable Docker project odos-insurance-ins1 has its own database volume and Medplum on 127.0.0.1:19813. Health reports 5.1.30-9b1bd92. Project features are empty, so transaction-bundles is absent. An isolated route server on 127.0.0.1:19811 uses the actual registerPatientInsuranceRoutes, authenticateStaffRoute, staff FHIR client and handlers. This is a production-route composition, not a whole-application browser walk. No UI changes are part of INS-1.

The synthetic staff Practitioner is bound to buildMedplumAccessPolicy(getRoleDeclaration('staff')) without changing that declaration. Current RelatedPerson?_id and Person?link lookups both returned HTTP 200 under that identity. Existing stacks were left untouched.

| Scenario | Handler status | coverage.write audit | New Coverage | Guardian |
|---|---|---|---|---|
| Base stale subscriber PUT | 200 | granted | 1, readable by staff | subscriber-only case |
| Fixed stale subscriber PUT | 409 | denied | 0, confirmed by beneficiary search | subscriber-only case |
| Fixed guardian Coverage-only reference | 422 | denied | 0 | identical resource and version |
| Fixed guardian PUT plus Coverage | 422 | denied | 0 | identical resource and version |

Captures: live/base.json, live/fixed.json, live/fence.json. Before/after use fresh equivalent synthetic subscribers. The original base transport's attempted cleanup is part of the reproduced defect; the fixed handler disables it. Each proof snapshots the audit log before its request and requires exactly one newly appended coverage.write row for the patient. Disabling the handler business audit makes both probe and fence instruments fail even with prior rows present; restoring it restores green. The PUT guardian proof omits role extensions from the submitted body so it proves S3 independently of S5. Audit claims in this table refer to the handler's coverage.write business event, not all lower-level transport trace events.

## Reproduction and limitations

Reproduction instruments are in live/reproduction/ as text. Copy them into .odos/insurance-ins1/ in an isolated worktree. Run provision.mjs, docker-compose -f .odos/insurance-ins1/compose.json up -d, setup.ts and staff.ts with the installed MCP tsx loader, and serve.ts. Run probe.mjs base with the base handler; restart only that proof server with the fixed handler and run probe.mjs fixed and fence.mjs. Keep generated runtime/session/config files gitignored; they contain disposable credentials. setup.ts now imports the approved registration exports, so export those two constants when replaying setup against base; that does not change handler behavior. Never publish runtime/session files.

Successful writes can remain when later entries fail. The handler reports confirmed locations and does not claim atomicity or undo. A connection loss can leave an unknown server outcome; written contains only acknowledged successes. The guardian lookup and subsequent submission are not a cross-resource atomic operation. CI and the independent evaluator remain separate delivery gates. NOT EVALUATED — no evaluator marker has been posted.
