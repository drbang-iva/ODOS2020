# Administrative membership cleanup with a constrained caller

Compared original `e3528920` against the corrected test on owned loopback Medplum port 29160, in a fresh synthetic project separate from registration project A and the superadmin bootstrap project.

The caller Practitioner membership had admin=true AND the canonical composite AccessPolicy produced by `buildMedplumCompositeAccessPolicy(["staff", "admin", "provider"])`, matching CI's repaired role grants. The separate operator ClientApplication membership had admin=false, empty access and no accessPolicy. Both identities were created for this proof only. The membership admin indexed field was set by exact-ID SQL and the corresponding FHIR resource refreshed by PUT.

Command: `node --import tsx --test mcp/tests/ageOfMajorityAuthzLive.test.ts`.

- Original FHIR metadata cleanup: 4 tests, 3 role subtests passed, 1 outer failure, exit 1; three ClientApplication DELETEs returned HTTP 403 under the composite caller. Exact output: `composite-caller-red.txt`.
- Administrative membership endpoint cleanup: 4 tests passed, 0 failed, 0 skipped, exit 0. Exact output: `composite-caller-green.txt`.

The corrected test deletes memberships through DELETE `/admin/projects/{projectId}/members/{id}` with the caller's project-administrator token before deleting their ClientApplications. Basic and ClientApplication cleanup uses the non-admin operator seeder. All cleanup failures remain collected alongside any original body failure. Production authorization grants are unchanged.

Re-ran `node docs/build-log/registration-majority/cleanup-errors/callback-harness.cjs`: original+cleanup errors retained; removing capture fails; restoration passes.

All 11 outer setup resources were cleaned; project A was not changed. Containers remain running. Final-head CI remains a separate requirement.
