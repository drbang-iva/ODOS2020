# Disposable served setup evidence

Sources: `scripts/r10-served-route/{stack.mjs,bootstrap.ts,login.ts,seed-ui.ts,caddy.mjs,check-caddy.mjs,response-proxy.mjs,harness.test.mjs,README.md}`.

## Verification

- `npm run typecheck:scripts`: exit 0, raw log `scripts-typecheck.log`.
- `node --test scripts/r10-served-route/harness.test.mjs`: 2 passed, 0 failed, 0 skipped. Checks Caddy route parity and one completed-response drop.
- W146 actual generated Caddyfile: replace exact `handle /clinical-graph* {` with `handle /wrong-path* {`; CLI check exit 1 with line diagnostic. Finally restore original exact bytes; CLI check exit 0. Raw logs `W146-generated-file-red.log` and `W146-generated-file-green.log`; executable `mutate-caddy.py` asserts one anchor and restoration.
- W146 checker mutation: disabling the comparison causes the W146 test to fail (missing expected exception); `W146-red.tap`. Guard restored; full harness 2/2 green.
- `git diff --check`: exit 0 at handoff.
- Runtime readiness: real MCP findings route unauthenticated 401, then actual synthetic provider served findings and quick-list GETs must return 200, then Caddy index and served JS/CSS fetched and hashed. This replaced the insufficient initial check of Caddy index alone.

## Runtime and isolation

Own project prefix `odos-r10-a3-2-served`; subnet `10.249.147.0/24`. PostgreSQL25433, Redis26380, Medplum28103, MCP23334, response proxy23335, drop-control23336, Caddy28090. All long-running services use independent compose-scoped volumes. Medplum5.1.30 digest in development identity evidence.

Synthetic project bootstrap reuses runSetupPractice and ensureLiveOperatorIdentity/loadVerifiedOperatorFhirClient. Provider and staff have real user logins, canonical policies, synthetic patient compartment binding, and recorded practitioner/profile identities. The runtime service is a separate ClientApplication, same project, project admin for caller-role membership reads, without a clinical role policy; it is distinct from the operator seeder. This follows the service-versus-caller split: all clinical authorization proof still uses provider/staff browser tokens. No role/policy source or stored canonical policy was relaxed.

## Setup failures and resolutions

- Docker compose plugin unavailable: use installed docker-compose fallback.
- Constrained practice admin cannot POST fixture Patient: seed via existing verified operator, never relax policy.
- Super-admin membership binding endpoint refused cross-project context: project admin performs the existing admin membership API call for the synthetic principals.
- Compiled MCP missing data ledgers: harness build stages the unchanged repository data directory into mcp/dist/data, preserving compiled runtime imports. No MCP source edit.
- SSE runtime requires SMART signing key: generate one ephemeral mode0600 key within the gitignored harness runtime.
- Constrained practice admin is not the runtime service: lazy tally Basic writes correctly refused. Provisioned separate project-scoped service client; seeded quicklist preferences using operator; provider/staff unchanged.
- The first dedicated runtime client was nonadmin and could not search ProjectMembership for caller role resolution. The harness now reads the actual admin membership endpoint, grants project-admin only to the dedicated synthetic runtime service, refreshes its token, and proves a membership search succeeds; both caller AccessPolicies are byte-identical before/after. The earlier nonadmin claim was incorrect because auth/me omits those membership fields. Current evidence reads the full membership resource.
- Initial SSE failure handler stopped the own database while a root test run was starting; that test run was explicitly invalidated. Parent subsequently reran MCP successfully. Current stop-app uses SIGUSR2 to stop only MCP/Caddy/proxy, preserving DB for baseline/final switching. The first supervisor predating stop-app was replaced by killing only its known supervisor and app child PIDs; containers were left running.

## Handoff

Browser proof agent owns application switching and additional legacy/carry fixtures. Development identity files are explicitly pre-final-head evidence; final proof must rebuild and reseal. At handoff three containers remain running for browser proof/root checks:

- odos-r10-a3-2-served-medplum-server-1
- odos-r10-a3-2-served-postgres-1
- odos-r10-a3-2-served-redis-1

The fourth container, odos-r10-a3-2-served-binary-init-1, exited normally. Final owner must call stack.mjs stop, retaining containers and volumes, and record final stopped state. Never copy private runtime credentials, configs, keys, or operator.env into evidence.

## Preflight repair

The first seed-ui implementation formatted a vendor-specific profile reference outside its allowed boundary. It now uses the existing production client getAuthenticatedProfileReference() and checks it against the observed membership profile. The lint rules are unchanged. Raw preflight-lint-repair.tap records the repaired live-tree test.

The isolated synthetic project uses Medplum 5.1.30 `userFhirQuota=5000000` and `totalFhirQuota=50000000` weighted FHIR units per minute. The default 50000-unit user quota interrupted the real Ocular Health route with HTTP 429. `seed-ui.ts` sets and reads back only these project settings, preserving both caller AccessPolicies byte-for-byte; limits remain enabled. No service or database restart was needed. `synthetic-fhir-quota.json` records the verified settings.
