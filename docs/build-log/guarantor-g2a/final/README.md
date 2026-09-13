# G-2a final author verification

Commands ran against the completed source working tree based on `9d1ccf9ee32629dac89c0a2f0a3a25d592b76579`. Application changes were uncommitted when the commands started; this is author verification, not an independent evaluation or a committed-head verdict.

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
| guarantorPropagation | 15 | 15 | 0 | 0 |
| guarantorEditor (final fixbacks) | 8 | 8 | 0 | 0 |

Focused command: `node --import tsx --test tests/<suite>.test.<ts|tsx>` in each package.

Both builds exited 0: `npm --prefix mcp run build` (`tsc`) and `npm --prefix ui run build` (TypeScript and Vite). Vite emitted a large-chunk advisory; the build completed.

Full MCP: `npm --prefix mcp test` with isolated PostgreSQL — 4704 tests; 4656 passed, 0 failed, 48 skipped; 93692.975291 ms. Harness exited 1 because 41 tracked live-stack tests had no credentials. No opt-out override was used. This run does not gate authorization.

Initial full UI: 1468 tests passed; 0 failed/skipped; 190480.503708 ms. This completed before the Q9c structured-classification and component CSS-variable fixbacks.

The earlier UI suite and build rerun use clean application source at `2f7d9471d9fa818e99652f5f26affcee7a27a7da`. Final UI build exited 0. Final `npm --prefix ui test` exited 0: 1468 tests, 1468 passed, 0 failed, 0 skipped; 187756.918917 ms.

Final bot-fixback verification uses clean application source `b4a3cbb0b3eb24d260df7fa7aa3ad6e64882a0a9`. `npm --prefix ui test` exited 0: tests 1472, pass 1472, fail 0, skipped 0, duration_ms 187123.768792. `npm --prefix ui run build` exited 0. Focused editor 8 + propagation 15 + demographics concurrency 3 passed 26/26 with no failures or skips. MCP source is unchanged, so its full suite/build evidence above remains applicable.
