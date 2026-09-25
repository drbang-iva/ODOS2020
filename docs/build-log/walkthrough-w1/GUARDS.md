# W1 guard and suite evidence

Author proof at base `f21c44fa6affc9d6581b954c81577a9cf080f614` plus this PR diff. **NOT EVALUATED.** All mutations restored. The portable command completed with exit 0; the styled browser recapture also exited 0.

## Live guards

Fresh-stack healthcheck: **attempt 12/90**, interval 2 seconds, byte-identical base URL. Smoke **12/12**, integration **218/218**, authorization **78/78**; zero failures, cancellations, skips, or todos.

G1 exact probes:

```text
GET /weno/pharmacies/search?searchType=local-retail&state=SC&zip=29646&all=true
GET /weno/drugs/search?q=latanoprost
```

```text
g1-baseline: pharmacies search=200
g1-baseline: drugs search=200
g1-pharmacy-red: pharmacies search=500
g1-pharmacy-restored: pharmacies search=200
g1-drug-red: drugs search=500
g1-drug-restored: drugs search=200
```

The other search stayed 200 during each mutation. These are real registered MCP routes and a dedicated Postgres with a runtime-generated, non-default password. The two earlier incomplete pharmacy probes returned 400 and are not guard reds.

G7 is a regression guard, as amended in A2; no root-cause fix was needed on this stack. Both baseline and restored runs exited 0:

```text
provider accept=200 code=none error=none row=already-ordered
composite accept=200 code=none error=none row=already-ordered
provider: ServiceRequest=1 plan-action=1 accepted-charge=1 row=already-ordered diagnosis-match=true
composite: ServiceRequest=1 plan-action=1 accepted-charge=1 row=already-ordered diagnosis-match=true
```

Injected order-write failure: live lane exit 1, ordinary 200 success assertion failed:

```text
provider accept=502 code=accept-failed error=The test could not be accepted. row=none
follow-up accept failed: encounter=1baa23e6-6e6f-4a9d-99be-1f4b58466c9e orderable=fundus-photography step=order status=503 message=W1 injected order write failure
```

A1 checks passed before each run: both invites 200; one User and one ProjectMembership per caller; stored profile present; policy binding 200; provider access true for both; admin false for provider-only and true with admin access for composite. The exact `invited.ok || invited.status === 409` check remains in the committed harness.

## Unit/registered-route mutation summaries

Every red below exited 1 with only the intended new guard failing. Every restored run exited 0. No existing assertion was changed. All had zero cancellations, skips, and todos.

| Guard | Mutation / observed red | Red tests / pass / fail | Restored tests / pass / fail |
| --- | --- | --- | --- |
| G2 | Remove configured drug constructor argument | 1 / 0 / 1 | 93 / 93 / 0 |
| G3 | Remove self-address derivation; 400 instead of 201 | 2 / 1 / 1 | 2 / 2 / 0 |
| G4 | Fabricate address from empty home; 201 instead of 400 | 2 / 1 / 1 | 57 / 57 / 0 |
| G5 | Remove alert immediately above Create patient | 1910 / 1909 / 1 | 1910 / 1910 / 0 |
| G6 | Collapse write failure into loadFailure; old load body replaces accept-failed | 2 / 1 / 1 | 2 / 2 / 0 |

G4 restored asserts 400, the established mailing-address error, and zero writes. G6 executes the production Accept route registration, limiter and handler over loopback HTTP with injected authentication/FHIR fixtures; its two unchanged assertions distinguish the write body/log from the established read-failure body. It is not an AccessPolicy test; G7 supplies live policy enforcement.

## Final-run commands and counts

The one-command runner invokes these commands from the repository root. `mcpTests` below abbreviates `npm --prefix mcp test --`; all paths following it are relative to `mcp/`.

| Lane | Command / files | Tests / pass / fail | Exit |
| --- | --- | --- | --- |
| Smoke + integration | `npm --prefix mcp run test:live-integration` | 12 / 12 / 0; 218 / 218 / 0 | 0 |
| Authorization | `npm --prefix mcp run test:live-authz` | 78 / 78 / 0 | 0 |
| G2 restored + source parsers | `mcpTests tests/wenoIndexPostgresWiring.test.ts tests/diagnosisWriteGate.test.ts tests/r10A3McpGuards.test.ts` | 93 / 93 / 0 | 0 |
| G3 restored | `mcpTests tests/walkthroughSelfRegistration.test.ts` | 2 / 2 / 0 | 0 |
| G4 restored + registration | `mcpTests tests/walkthroughSelfRegistration.test.ts tests/patientRegistrationAuthz.test.ts tests/guarantorRegistrationAttach.test.ts` | 57 / 57 / 0 | 0 |
| G6 restored | `mcpTests tests/walkthroughFollowUpAcceptFailure.test.ts` | 2 / 2 / 0 | 0 |
| Full UI restored | `npm --prefix ui test` | 1910 / 1910 / 0 | 0 |
| Related MCP | `mcpTests tests/followUpAccept.test.ts tests/guarantorRegistrationAttach.test.ts tests/wenoSearchRoutes.test.ts tests/diagnosisWriteGate.test.ts tests/r10A3McpGuards.test.ts` | 146 / 146 / 0 | 0 |
| Accept + queue | `mcpTests tests/walkthroughFollowUpAcceptFailure.test.ts tests/followUpAccept.test.ts tests/followUpQueueEndpoint.test.ts` | 42 / 42 / 0 | 0 |
| MCP build | `npm --prefix mcp run build` | build | 0 |
| UI build | `npm --prefix ui run build` | build | 0 |

Every MCP suite used dedicated W1 Postgres via `ODOS_POSTGRES_URL`. Unit suites ran with both operator files moved aside. UI used the package command. These are focused MCP suites, not a claim that the entire MCP default suite ran.

Browser capture and styled recapture each reported:

```text
Browser G5: /patient/new, real NewPatient, injected 400, adjacent alert=1, registration POST=1
```

The browser uses the real served route and component but an injected registration response and synthetic preference/config responses. The screenshot proves adjacent placement; registered-route G3/G4 prove transaction behavior separately.

## Cleanup review fixback

CodeRabbit identified early cleanup exceptions preventing later operations. Only the harness cleanup and its new fault test changed after the full live run at `e38f685c12e840b681413af94cc3f99a4bfed378`; product, G1–G7 fixtures and expectations are byte-identical to that verified commit.

`node --test docs/build-log/walkthrough-w1/w1-cleanup.test.mjs` executes the runner's actual finally block with synthetic operations. It covers success plus failures in source restore, MCP stop, stack down, operator-file removal, summary write, and credential deletion. Every case checks that later cleanup, both original operator restores, and final docker ps are attempted; failures remain nonzero.

- Original sequence: 7 tests, 1 pass, 6 fail.
- Fixed sequence: 7 tests, 7 pass, 0 fail, exit 0.
- Restore old cleanup as a mutation: 7 tests, 1 pass, 6 fail, exit 1.
- Restore fix: 7 tests, 7 pass, 0 fail, exit 0.

All four had zero skips, cancellations and todos. A second review fix preserves the walkthrough error together with cleanup errors, and rethrows the identical original error if cleanup succeeds. Added two cases: green 9/9; remove both primary-error propagation paths → 9 tests, 7 pass, 2 fail, exit 1; restore → 9 tests, 9 pass, 0 fail, exit 0. Zero skips, cancellations and todos in all three. Final error propagation is outside finally. The one-command runner includes this nine-test check. This cleanup-only fixback does not require repeating live product requests.

## Earlier runs retained for honesty

These counts are earlier attempts, not additional final-head coverage. They are not summed because many tests repeat.

| Earlier lane | Tests / pass / fail |
| --- | --- |
| Original W1 standalone smoke | 12 / 12 / 0 |
| Original W1 live integration and authz | 12 / 12 / 0; 218 / 218 / 0; 78 / 78 / 0 |
| Original related MCP baseline | 146 / 146 / 0 |
| Original G2 red / green | 1 / 0 / 1; 93 / 93 / 0 |
| Original G3 red / B2 green | 2 / 1 / 1; 57 / 57 / 0 |
| Original G5 two red runs / green | each red 1910 / 1909 / 1; green 1910 / 1910 / 0 |
| Original G6 direct-handler red / green | 2 / 1 / 1; 14 / 14 / 0 |
| A2 setup attempt 1 | 12 / 12 / 0; 218 / 218 / 0; then missing repair CLI argument |
| A2 setup attempt 2 | 12 / 12 / 0; 218 / 218 / 0; authz 35 / 28 / 7 fixture setup errors |
| A2 corrected attempt | 12 / 12 / 0; 218 / 218 / 0; 78 / 78 / 0; G7 red/green; incomplete G1 query 400 |
| A3 completed attempt | 12 / 12 / 0; 218 / 218 / 0; 78 / 78 / 0; G7 red/green; incomplete G1 query 400 |
| A4 pre-relocation attempt | 12 / 12 / 0; 218 / 218 / 0; 78 / 78 / 0; G7 red/green; both G1 baselines 200; then harness target mismatch |

All listed earlier suites had zero skips, cancellations and todos. The seven A2 errors were missing operator fixture credentials, not authorization assertion failures; that attempt was not green. An aborted A3 setup run has no completed suite summary. Earlier MCP build exited 0. See README Rule 15 for each harness repair.

## Cleanup

Runner and styled-recapture MCP processes stopped. `docker-compose down -v` exited 0. Final `docker ps --format 'table {{.Names}}\t{{.Status}}'`:

```text
NAMES               STATUS
vf-prac1b-walk-db   Up 6 days
```

No `odos-w1-*` containers remain running. The unrelated VisionForge and N0 containers were not stopped by this task. Runtime credentials were generated and removed; no `.odos/` file is committed.
