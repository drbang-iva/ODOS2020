# Authorization fixture cleanup correction

At source `af7d08a0c4611e14957f32c818c1faa371b300de`, CI reported all three role subtests passing and the outer test failing on three ProjectMembership DELETE responses with HTTP 403. The operator seeder is not the metadata administrator.

The corrected test uses the caller administrator token for disposable ClientApplication and ProjectMembership cleanup, and the operator seeder for Basic config resources. Both cleanup groups are attempted and every rejection is retained; no skipped cleanup and no production grant changes.

Local command: `node --import tsx --test mcp/tests/ageOfMajorityAuthzLive.test.ts`.
Local result after correction: 4 passed, 0 failed, 0 skipped. Exact output: `local-green.txt`.

LIMIT: this local run used the fixture bootstrap project and does not reproduce CI's metadata permission boundary. Explicitly restricting the temporary seeder's policy still left the old code green locally, so this is a regression check, not a local reproduction of the CI failure. Final-head CI must confirm the correction.

All seven outer setup resources were cleaned, along with the test-created clients, memberships and configs. Containers remain running; registration project was not changed.
