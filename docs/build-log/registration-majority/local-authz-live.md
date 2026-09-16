# Age-of-majority live authorization proof

Executed against the task-owned loopback Medplum fixture at port 29160. The bootstrap synthetic project was isolated from the registration proof project. Canonical policies were built by `buildMedplumAccessPolicy` for provider, staff, and admin; a synthetic ContractSearch patient and a separate privileged operator client supplied fixture setup. Policy-bound disposable clients exercised the persisted rules.

Command: `node --import tsx --test mcp/tests/ageOfMajorityAuthzLive.test.ts`

Result: 4 tests passed, 0 failed, 0 skipped; process exit 0. Exact TAP output is in `local-authz-live.txt`.

Assertions: all three roles can read and search the coded singleton; Provider create/update return 403; Staff and Admin create return 201 and update return 200. Test-created clients, memberships, and config resources were cleaned. The outer setup's three policies, patient, operator client and membership were cleaned afterward. Containers were running at this proof stage; they were subsequently [stopped and retained](../registration-guarantor/fixture-stopped-final.txt). No changes to registration proof project identities.

This local execution does not replace the required final-head CI live authorization lane.
