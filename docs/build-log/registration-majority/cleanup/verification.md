# Authorization fixture cleanup correction

At source `af7d08a0c4611e14957f32c818c1faa371b300de`, CI reported all three role subtests passing and the outer test failing on three ProjectMembership DELETE responses with HTTP 403. The operator seeder is not the metadata administrator.

The corrected test uses the caller administrator token for disposable ClientApplication and ProjectMembership cleanup, and the operator seeder for Basic config resources. Both cleanup groups are attempted and every rejection is retained; no skipped cleanup and no production grant changes.

Local command: `node --import tsx --test mcp/tests/ageOfMajorityAuthzLive.test.ts`.
Local result after correction: 4 passed, 0 failed, 0 skipped. Exact output: `local-green.txt`.

LIMIT: this local run used the fixture bootstrap project and does not reproduce CI's metadata permission boundary. Explicitly restricting the temporary seeder's policy still left the old code green locally, so this is a regression check, not a local reproduction of the CI failure. Final-head CI must confirm the correction.

All seven outer setup resources were cleaned, along with the test-created clients, memberships and configs. Containers remain running; registration project was not changed.

## CI-equivalent metadata boundary reproduced

A fresh synthetic project C was created on the same owned loopback fixture, separate from both the bootstrap project and registration project A. The caller Practitioner membership was admin=true with no attached policy. The distinct operator ClientApplication membership was admin=false with empty access and no accessPolicy, matching `operatorMembershipVerification.ts`'s actual predicate. Targeted updates addressed only these newly created membership IDs; FHIR PUT refreshed the resource after the indexed SQL update.

With that non-admin unbound operator, the original `af7d08a0` test reproduced the CI failure exactly: 3 role subtests passed, the outer test failed on three ProjectMembership DELETE HTTP 403 responses; 4 tests, 3 passed, 1 failed, process exit 1. The corrected source passed: 4 tests, 4 passed, 0 failed, 0 skipped, process exit 0. Exact output is in `nonadmin-operator-red.txt` and `nonadmin-operator-green.txt`.

The prior bootstrap-project and admin=true operator greens were unsuitable controls: neither reproduced the actual operator metadata boundary. The non-admin run above supplies the missing reproduction.

Ten outer setup resources were cleaned. The three memberships left behind by the deliberately failing original test were explicitly deleted with the fixture service token (HTTP 200). No project A identities or settings were changed. Containers remain running.
