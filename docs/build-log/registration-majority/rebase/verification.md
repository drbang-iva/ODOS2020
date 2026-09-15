# Rebased majority configuration proof

Source head: `befd48ef2888acf796ad82be7091b09f2b9a17b7`, rebased onto `40c19a9e` with the sibling claim fence preserved.

- Command: `node --import tsx --test mcp/tests/ageOfMajorityConfig.test.ts mcp/tests/schedulingRbacGrants.test.ts`. Green and restored: 16 tests passed, 0 failed.
- D8: renamed the age-of-majority canonical extension registry entry; `node --import tsx --test --test-name-pattern D8 mcp/tests/ageOfMajorityConfig.test.ts`: 1 failed, 0 passed. Restored exact registry bytes.
- D9: replaced seed `if (options.apply)` with `if (true)`; `node --import tsx --test --test-name-pattern D9 mcp/tests/ageOfMajorityConfig.test.ts`: 1 failed, 0 passed. Restored exact source bytes.
- Command: `node --import tsx --test mcp/tests/ageOfMajorityAuthzLive.test.ts`. Owned loopback Medplum at port 29160: 4 passed, 0 failed, 0 skipped, exit 0. Provider read/search allowed and create/update denied; Staff/Admin read/search/create/update allowed.

Live setup used canonical writer-built policies and a synthetic patient in the isolated bootstrap project. Own policies, patient, operator client and membership were removed afterward; test clients and config resources were cleaned by the test. Registration proof project identities/settings were not modified. Containers remain running for the root task. This local proof does not substitute for final-head CI.
