# CI lane skip comparison

The clean non-live run has 53 skipped tests versus 52 at base 1706d7c8417b04791471d4332b4ecd712883bf11. [All task names and reasons](task-skips.txt), [all base names and reasons](base-skips.txt), [machine comparison with both full lists](skip-comparison.json).

The one additional test is **R10 A3 Ocular Health saves and lifecycle enforce stored role policies and real MCP dispatch** (`mcp/tests/r10OcularHealthDoorAuthzLive.test.ts`). It requires Medplum credentials and belongs to the credentialed `test:live-authz` lane. It is registered in that package command. CI's non-live Node step supplies only PostgreSQL and ODOS_REAL_WEASYPRINT_TEST; its separate live authorization step supplies synthetic Medplum admin/bootstrap and operator identity. This is a lane-specific credential skip, not a skipped A3 obligation: the unchanged test executes **4/4**, including its three subtests, in the fresh **73/73, zero skips, zero TODOs** [live authorization run](live-authz.txt). No skip or TODO was added to evade this requirement.

There is also a renamed existing carry test (one at each head, no count increase):

- Base: `live ordinary-clinician policy persists and reads diagnosis carry while preserving atomic conflict rollback`.
- Task: `live ordinary-clinician policy persists standalone carry and resumes an Encounter link conflict`.

The changed name reflects the accepted standalone carry / retry contract, not a lost test. It executes as `ok 111` in the [credentialed live integration run](../rev26/full-checks/live-integration.txt). That lane has zero skips; its six unrelated profile-validation failures are reproduced at base in the identical environment. Assertion changes are mapped in the [audit](../assertion-audit/REPORT.md).

Environment details and the exact CI/local differences are in [the environment record](../rev26/environment.md). No MEDPLUM_PROJECT_ID or derived operator environment was supplied to the non-live suite. The dedicated local stack is Medplum 5.1.30, while the checked-in CI compose image is 5.1.8; both local comparison heads use the same required 5.1.30 stack.
