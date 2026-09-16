# CI live-policy fixture correction

At PR617 head346d0b8bb5c1227d9c5913945810e8f78d6e08f4, CI's main MCP suite and credentialed integration lane succeeded; the new diagnosis live suite failed before any clinical operation because it selected2 policies per role instead of1. The extra match is a composite policy carrying both Staff and Provider tags. Existing live suites correctly require exactly one practice-role tag.

Only the new diagnosis live fixture changes: canonicalRolePolicies now requires one matching role tag, matching existing clinicalWriteAuthzLive/encounterUndoLedgerAuthzLive selection. The assertion that exactly one policy exists and the deep comparison of its entire resource array with canonical compiler output are unchanged. No production policy, grant, endpoint or workflow changed.

New regression uses the real canonical and composite policy builders. The previous any-matching-tag selector returns both composite and canonical names:1 test,0 pass,1 fail,exit1. Restored singleton-role selector:1 test,1 pass,0 fail,exit0. This is also the mutation guard: restoring the broad selector is red; the strict selector is green. Evidence: composite-policy-red.tap and composite-policy-green.tap.

Assertion mapping: the two new role-selection assertions map V1/W7 and §7's canonical-policy requirement. No existing assertion changed or was removed; only the fixture selection feeding existing assertions was corrected. The added top-level unit test increases total live-authz test count from68 to69 and full MCP count by1. Diagnosis-specific total is now4 (unit selection, live parent, staff and provider).

CI failure source: https://github.com/drbang-iva/ODOS2020/actions/runs/35127819522/job/104901213111 . Canonical policy content remains verified rather than accepting whichever role-tagged policy happens to appear first.

## Teardown identity correction

CI at93733d90 passed both staff/provider clinical subtests but failed the parent cleanup assertion:the caller identity could delete ProjectMembership, but canonical policy denied FHIR ClientApplication DELETE (two403 responses). The private local caller had broader project rights, hiding this difference. Existing ageOfMajorityAuthzLive routes non-membership resource cleanup to the privileged seeder. The diagnosis suite now does the same:only ProjectMembership uses callerAccessToken; ClientApplication and clinical resources use seederAccessToken. No grant, role policy, application code or assertion changed; cleanup remains strict. Mapping:W7/§7 live fixture identity. Real CI red and local restored lane are cleanup-ci-red.txt and cleanup-live-green.tap. Final-head CI must independently confirm the CI-specific correction; final results are recorded in the PR description.

## Both cleanup passes always run

CodeRabbit thread4029420785 found that sequential awaits could skip membership cleanup if the preceding resource cleanup failed. Cleanup now attempts memberships first and remaining resources second, collecting errors from both before throwing AggregateError. Both strict cleanup calls and their filters remain. No existing assertion changed. W7/§7 fixture guard executes the actual finally block extracted from before/after TypeScript with four injected outcomes (neither/first/second/both passes fail):before0/4,exit1;after4/4,exit0. Commands from repo root:node docs/evidence/r10-a2b1/ci-fixback/check-cleanup.mjs --before; then omit --before. Red/green outputs and the restored69/69 live lane are adjacent. These4 checks are separate from Node suite counts.

CI confirmed the cleanup identity correction at6ddfb82a:run35133838890 succeeded, including all69 live-authz tests (zero skips/failures). Exact per-lane counts:ci-6ddfb82a-counts.txt. The subsequent cleanup-flow hardening retains the same identities and strict assertions; final-head CI/bot status is recorded in the PR description.
