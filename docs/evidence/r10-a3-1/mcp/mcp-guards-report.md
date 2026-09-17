# R10 A3.1 §3.13 MCP guards — author evidence

Base: 1706d7c8417b04791471d4332b4ecd712883bf11. No commits. NOT EVALUATED.

## Files

- `mcp/src/clinical-graph/shared-finding-write-guard.ts` (new): shared classification guard; scoped canonical/panel lifecycle preflight, pre-rebuild refusal, target-filtered audit repair.
- `mcp/src/index.ts`: guard every generic Observation-producing MCP dispatch path before associated writes; preserve session check before lifecycle preflight; preserve attestation/amendment builders; forward custom capture response headers.
- `mcp/tests/r10A3McpGuards.test.ts` (new): 54 SDK in-memory MCP dispatch cases.
- `mcp/tests/r10A3CustomCaptureRoute.test.ts` (new): real route registration extraction and 428 Cache-Control forwarding.

## Behavior and boundaries

Generic tools refuse canonical facts, valid panels, negative acts and shared legacy snapshots with “Shared findings are charted in the finding doors.” All batch entries and both eye-growth output Observations are validated before any associated persistence. Questionnaire and meibography construction now occurs before related QuestionnaireResponse/DocumentReference writes; persisted references are substituted afterward. Existing builder files and roles are unchanged.

Canonical/panel attest/amend verifies real clinician/session equality, reads the target's Encounter and patient scope, loads effective stored definitions via findingDefinitionStore.list(), refuses pre-rebuild encounters, repairs only the selected Observation's owed audit, and then uses unchanged Binary PATCH builders. Finished Encounters are allowed. Identity, operation components and extensions are retained. Legacy targets, mismatching session practitioners, and mismatched audits refuse before lifecycle writes. No policy mutation or credential flow was used.

Custom-section POST now forwards `result.headers` before serializing its response, preserving the §3.4 legacy-request `428` plus `Cache-Control: no-store` result. The capture implementation owner supplies optional headers in the handler return type.

## Tests and mutation evidence

- Initial feature red: `mcp-guards-red.tap`: 39 tests, 1 pass, 38 failures (the already-enforced session check was the passing control).
- Final feature suite: 54 tests, 54 pass, zero failures/skips/todos.
- Related regression command: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/r10A3McpGuards.test.ts mcp/tests/v05c-scribe-attestation-amendment.test.ts mcp/tests/dryEyeMeibography.test.ts mcp/tests/eyeGrowth.test.ts`: 91 tests, 90 pass, zero failures, 1 skip (existing `reference-population migration succeeds on fresh and populated Postgres databases`; `ODOS_TEST_POSTGRES_URL` required for its destructive local migration fixture). Output `mcp-guards-regression.tap`.
- `npm --prefix mcp run build`: exit 0 (before header forwarding; capture handler type must land before the next build). Output `mcp-guards-build.txt`.
- `git diff --check` on these files: exit 0.
- Header-forwarding red: 1 test, 1 failure; restored implementation green: 1 test, 1 pass (`custom-capture-header-{red,green}.tap`).

Mutations and restores ran in isolation; each restored run was 54/54 green:

| Guard | Mutation | Red |
|---|---|---|
| W116 | generic classifier refusal disabled | 35 failed, 19 passed |
| W115 | pre-rebuild check disabled | 4 failed, 50 passed |
| W115 | audit repair skipped | 4 failed, 50 passed |
| W115 | target filter omitted | 2 failed, 52 passed |
| W115 | finished encounters incorrectly refused | 8 failed, 46 passed |

Raw files are `.odos/r10-a3-1/W115-*-{red,green}.tap`, `W116-generic-{red,green}.tap`; mutation script `mcp-guard-mutations.py`, counts `mcp-guard-mutations.json`. Guard source was restored byte-exact after every mutation.

## Assertion mapping

No existing test assertion changed or removed. New generic rejection/positive-control/reference tests map to V35/W116; lifecycle scope/status/audit/session/identity tests to V35/W115; header forwarding to V18 and §3.4's explicit 428/no-store wire contract. No Mandate 14 ledger additions: no new terminology codes, regulatory citations, or FHIR artifact URLs.

## Proof limits / follow-ups

The new suite extracts the current production `createServer` registration and executes the real SDK Server/Client through InMemoryTransport. Lifecycle builders and guard/library code are real. Generic builder output seams are injected to force every prohibited Observation shape through each tool's actual write boundary; many fixed-shape tools do not accept arbitrary Observation JSON at their public schema. This is not a process-startup/service-auth proof or live AccessPolicy proof. Parent owns §7 real service-identity dispatch against disposable Medplum, final T22 scenarios, full checks, PR, and independent Opus evaluation.

Initial census reconnaissance and §3.11 plan are in `t22-census-plan.md`. No registry/checker implementation yet.

## Parent verification with PostgreSQL

The same 91-test regression command ran through the private isolated-stack launcher with `ODOS_POSTGRES_URL` and `ODOS_TEST_POSTGRES_URL` pointing to the task's Postgres 16 instance on localhost:29132 (`odos_a3_test`; migration fixtures create/drop their own named temporary databases). Result: **91 tests, 91 pass, 0 fail, 0 skipped, 0 todo**, exit 0. Output: `../mcp-guards-postgres-regression.txt`.

The five mutation variants were also rerun through the shared `run-mutations.mjs` runner, which requires exactly one anchor occurrence and emits `MUTATION ANCHOR MISS` on mismatch, then verifies the designated test failure and byte-exact restoration. All five red exit 1 / restored green exit 0; manifest `mutations.json`, results `mutation-results.log`, raw outputs `../mutations/mcp-W*-{red,green}.txt`.
