# G-2a base regression inventory

Base: `9cdc65f73c6767d0546d8c5b9625e0efed1c0129`. Tests ran from a clean `git archive HEAD` snapshot because application edits were already underway in the worktree. Snapshot used installed dependencies via symlinks. No baseline source files were changed.

Each focused command: `node --import tsx --test tests/<suite>.test.<ts|tsx>` from its package directory.

| Suite | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| commsSuppression | 49 | 49 | 0 | 0 |
| commsApi | 99 | 99 | 0 | 0 |
| commsConfig | 32 | 32 | 0 | 0 |
| patientRegistrationAuthz | 29 | 29 | 0 | 0 |
| guarantorPerson | 11 | 11 | 0 | 0 |
| patientRegistration | 20 | 20 | 0 | 0 |
| demographicsConcurrency | 3 | 3 | 0 | 0 |
| patientPhoneForm | 17 | 17 | 0 | 0 |

Full UI: `npm --prefix ui test` — exit 0; 1449 tests, 1449 passed, 0 failed, 0 skipped; 190701.925541 ms.

Full MCP: `npm --prefix mcp test` with task-owned `ODOS_POSTGRES_URL` — 4704 tests, 4656 passed, 0 failed, 48 skipped; 78989.550042 ms. Harness exit 1 because 41 skips are tracked live-stack tests and live credentials were deliberately not configured for this regression run. This run does **not** gate authorization. No `ODOS_ALLOW_UNGATED_MCP` override was used. Initial environment probes exposed missing PostgreSQL at the default port and a root-level `tsx` loader expected by `disasterRecoveryCredentials.test.ts`. The clean archive uses the task-owned disposable PostgreSQL through `ODOS_POSTGRES_URL` and a root dependency symlink. The loader focused recheck passed 11/11. No application source changes were needed.

Raw local logs are under `.odos/guarantor-g2a/baseline/`; they are not committed.
