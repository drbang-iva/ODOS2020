# R10 A3.2 disposable served route harness

Run from the task checkout. Requires Docker, Docker Compose (`docker compose` or `docker-compose`), Node with installed repo dependencies, and Caddy. Browser proofs also require an installed Chrome/Chromium executable. Set `R10_CHROME=/absolute/path/to/chrome` for Linux or a custom installation; all four browser proof scripts honor it. The default is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS. This harness never reads the checkout's `.env` files into its processes.

```
node scripts/r10-served-route/stack.mjs prepare
node scripts/r10-served-route/stack.mjs up
node scripts/r10-served-route/stack.mjs build
node scripts/r10-served-route/stack.mjs serve
```

`prepare` refuses to overwrite an existing isolated identity. `up` reuses its own containers and persisted synthetic project. `serve` stays running; wait for its ready line before browsing. It checks the real MCP finding endpoint's unauthenticated 401, then signs in as the synthetic provider and requires served findings and quick-list GETs to return 200 before announcing readiness. An early process failure or termination stops, but does not remove, the project's containers. Use a separate terminal for proof commands.

```
node scripts/r10-served-route/stack.mjs stop-app  # preserve database for switching app roots
node scripts/r10-served-route/stack.mjs stop      # stop every harness container at final completion
```

Do not stop this stack while another task is running tests against its dedicated PostgreSQL. Coordinate with the task owning those tests first.

Runtime files live under `.odos/r10-a3-2-served/`, gitignored and mode 0600 for files containing credentials. Never copy `credentials.json`, `service.json`, `operator.env`, signing keys, or the generated Medplum config into evidence.

- Compose project: `odos-r10-a3-2-served`; subnet `10.249.147.0/24`. Volumes are project-scoped, with no shared volume names.
- App: `http://127.0.0.1:28090`; Medplum: `http://127.0.0.1:28103` (pinned `5.1.30`). PostgreSQL: `25433`; Redis: `26380`; MCP: `23334`; response proxy: `23335`; local drop control: `23336`.
- `credentials.json` contains synthetic admin/provider/staff email/password pairs, project ID, practitioner references, policy references, and a separate project-scoped runtime-service client credential. The runtime-service client has no clinical role policy, is a project admin for the runtime caller-role membership resolver, and is different from the privileged fixture seeder. Provider and staff are ordinary user logins bound to canonical role policies and the synthetic patient compartment.
- `fixture.json` names the synthetic patient and current/prior/closed/preRebuild encounters. The browser proof must place legacy data into the preRebuild encounter; its name alone does not make it pre-rebuild.
- `operator.env` and `operator-state.json` come from the existing verified operator bootstrap; use those for fixture writes. Constrained staff/provider identities must perform clinical proof operations.
- `bootstrap-identity.json` contains only synthetic IDs and references. `identity.json` records app head, dirty flag, MCP built entrypoint SHA-256, PID, served JS/CSS SHA-256 values, Caddy source hash, and Medplum image digest. A dirty build is development evidence; rebuild and reseal after the final commit.
- MCP uses its compiled `dist` entrypoint. `build` stages the existing `data/` artifacts into `mcp/dist/data/` because tsc does not copy the runtime ledgers/migrations.
- Generated Caddyfile is derived from `deploy/frontdoor/Caddyfile`; only bind/upstream ports change. `node scripts/r10-served-route/check-caddy.mjs` verifies the actual generated file and reports a line for any other difference.

To drop one response after its upstream request has completed:

```
curl -X POST http://127.0.0.1:23336/drop-next \
  -d '{"method":"POST","path":"/clinical-graph/encounters/REPLACE/previous-exams"}'
curl http://127.0.0.1:23336/status
```

Selectors use an exact method and path, excluding the query string. A second arm is refused until the first is consumed. Logs record request method/path, response status, time, and whether dropped; never headers or payloads.

For the before proof, create a separate detached checkout at exact #619 head `1706d7c8417b04791471d4332b4ecd712883bf11`. Coordinate stopping the current app with `stop-app` (database remains running), then use `build --app-root /absolute/before/checkout` and `serve --app-root /absolute/before/checkout`. Build and serve roots must match. Return to this checkout with the same commands without `--app-root`.

Checks:

```
node --test scripts/r10-served-route/harness.test.mjs
python3 docs/evidence/r10-a3-2/harness/mutate-caddy.py
```

The mutation command edits the actual generated Caddyfile, runs the CLI guard to a failing exit with a line diagnostic, restores in `finally`, and reruns to exit 0. It does not reload Caddy.

The isolated synthetic project uses Medplum 5.1.30 `userFhirQuota=5000000` and `totalFhirQuota=50000000` weighted FHIR units per minute. The default 50000-unit user quota interrupted the real Ocular Health route with HTTP 429. `seed-ui.ts` sets and reads back only these project settings, preserving both caller AccessPolicies byte-for-byte; limits remain enabled. No service or database restart was needed. `synthetic-fhir-quota.json` records the verified settings.

For proof after the final commit, set `R10_EVIDENCE` to an absolute directory under the gitignored `.odos/` folder. All browser scripts then write their evidence below that directory, preserving a clean checkout while `identity.json` records the final PR head with `dirty:false`. Keep that head fixed through CI and review; attach the final bundle to the handoff. Run `node scripts/r10-served-route/sse-proof.mjs` against the running harness to verify the real MCP SSE endpoint and JSON-RPC initialization response through Caddy and the response proxy.
