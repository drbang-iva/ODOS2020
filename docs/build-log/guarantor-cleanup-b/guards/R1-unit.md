# R1 age-of-majority grant unit guard

Source: isolated mutation worktree at `05bb880b`. The mutation restored `AGE_OF_MAJORITY_CONFIG_WRITE_RULE` to `SCHEDULING_RESOURCE_RULES` while leaving the Admin-specific rule; `rg` verified occurrences at the declaration, shared scheduling list, and Admin list. Both direct and composite policies were built with the real writers.

`node --import tsx --test --test-name-pattern='age-of-majority (create|update) (is|requires) Admin' tests/ageOfMajorityConfig.test.ts` from `mcp/`:

```text
not ok 1 - age-of-majority create is Admin-only on direct grants
    staff create
    true !== false
not ok 2 - age-of-majority update is Admin-only on direct grants
    staff update
    true !== false
not ok 3 - age-of-majority create requires Admin in composite grants
    provider+staff create
    true !== false
not ok 4 - age-of-majority update requires Admin in composite grants
    provider+staff update
    true !== false
1..4
# tests 4
# pass 0
# fail 4
```

After removing the restored scheduling write:

```text
1..4
# tests 4
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

The changed policy rule is `Basic` with criteria `Basic?code=https://odos2020.com/fhir/CodeSystem/age-of-majority-config|odos-age-of-majority-config`, interactions `create` and `update`. The Staff policy and composites without Admin, including Provider+Staff, lose those two rules; their read/search/history/vread remain. Admin and composites containing Admin retain the criteria-fenced write. This is unit policy generation only; the live Medplum authorization mutation and final policy-sync diff are separate integration obligations.
