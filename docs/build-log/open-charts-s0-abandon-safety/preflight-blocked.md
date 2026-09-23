> Historical R1/P2 STOP, resolved by R2. Current status and corrections: [R2 build bundle](r2-build-blocked.md). In particular, its original P6 conclusion was incomplete.

# S0 preflight: blocked before implementation

Base and HEAD: `18932ecd53463987172f07b768aa9717fa48c671`.
Branch: `drbang-iva/open-charts-s0-abandon-safety`.
R1 was read in the companion kickoff and applied. No PR, commit, or product change.

## Premises

- P1: source sweep found the Encounter cancelled write in EncounterHeader's abandon transaction; the named start and finish writers remain present.
- P2: create bundle contains Encounter and Provenance. **Live answer NOT VERIFIED.** The custom harness failed creating its Appointment fixture before Start exam or dependency reads.
- P3: void handler, closed gate, pre-rebuild refusal, route registration, and exported server migration predicate remain present.
- P4: Staff unfinished-only constraint remains; Provider Encounter rule has no constraint; Admin has no clinical write grant. Runtime Basic reads are granted to Staff and Provider.
- P5: section-content helper is narrower than the dependency contract: projected findings, selected image documents, and selected questionnaires. It cannot serve as the complete abandonment dependency check.
- P6: named test sweep found no exact Provider Encounter-rule pin blocking the proposed constraint. Finished-to-finished and diagnosis-edit checks remain intact.
- P7: registry test checks every discovered call site and rejects missing and stale exclusions; the new transaction would require an exclusion.

## Baseline verification

Operator files `.odos/operator.env` and `.odos/operator-identity.json` were absent during unit suites (nothing needed moving). Generated only afterward for the disposable live lane. Every MCP run had `ODOS_POSTGRES_URL` set to the dedicated `odos-s0abandon-base-postgres-1` container.

- `cd ui && npm test`: `tests 1865; pass 1865; fail 0; skipped 0`.
- MCP baseline used CI's direct Node runner: `node --import tsx --test --test-concurrency=1 'src/__tests__/**/*.test.ts' 'tests/**/*.test.ts' '../tests/boundaries/**/*.test.ts' '../tests/observation-status-machine/**/*.test.ts' '../tests/setup-wizard/**/*.test.ts' '../tests/preflight/**/*.test.ts' '../tests/smart/**/*.test.ts' '../tests/cds/**/*.test.ts' '../tests/agentops/**/*.test.ts' '../tests/bulk-data/**/*.test.ts' '../tests/mandate-8/**/*.test.ts'`: `tests 6369; pass 6314; fail 0; skipped 55`. This unit run does not prove live authorization.
- Root `npx tsc --noEmit`: exit 0.
- MCP `npx tsc --noEmit`: exit 0.
- UI `npx tsc --noEmit --skipLibCheck`: exit 0.
- `npm run preflight`: `0 warning(s), 0 hard block(s)`; exit 0.
- Fresh server `baseUrl` and `MEDPLUM_BASE_URL`: both `http://localhost:18103/`.
- Healthcheck every 2 seconds: `Healthcheck passed: attempt 3 of 90`.
- `npm --prefix mcp run test:live-integration`: smoke `tests 12; pass 12; fail 0; skipped 0`; integration `tests 218; pass 218; fail 0; skipped 0`.
- Operator identity, role repair, and disposable canonical policy sync: exit 0 after the harness correction below. `GITHUB_ACTIONS=true` applied only to repair.
- `npm --prefix mcp run test:live-authz`: `tests 78; pass 78; fail 0; skipped 0`.

## Harness findings and STOP

1. This host provides standalone `docker-compose`; replacing the unavailable `docker compose` invocation started the same stack. Volume names were overridden in gitignored harness config to S0-specific names.
2. Initial role repair omitted `MEDPLUM_CONTRACT_BOOTSTRAP=1` and failed on project-invisible User read. Including CI's flag allowed repair; no product source changed.
3. Human invitation using the operator fixture client returned 403. A control with only the caller changed to the synthetic admin returned 200. Provisioning used that admin thereafter; no composite identity was used to claim S0 permission evidence.
4. Synthetic registration hit 429. Bounded backoff retried the same registration request without changing its expected value.
5. **Blocking author error:** the Appointment fixture omitted start/end while specifying `checked-in`. Medplum refused it with HTTP 400 and invariant `(start.exists() and end.exists()) or (status in ('proposed' | 'cancelled' | 'waitlist'))`. Correcting this fixture requires changing the POST Appointment payload. Kickoff rule 15 allows automatic harness fixes only when they change no product request. No correction or repeat was attempted after this failure. Both single-role human identities had been provisioned, but no fresh encounter was created.

Needed ruling: allow the synthetic Appointment fixture to carry valid start/end instants, then resume P2 on a fresh stack in the prescribed lane order. No assertion, expected value, product file, or allowlist expansion is requested.

A1-A12: not run; no red/green claims. No S0 endpoint, UI, or signed-Encounter policy change exists. No screenshots or S0 readback proof. No new Mandate 14 ledger rows or design decisions.

## Cleanup and outstanding scope

`docker-compose ... down`: exit 0. Final `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'`:

```
vf-prac1b-walk-db    Up 4 days    127.0.0.1:55481->5432/tcp
```

All S0 containers stopped; VisionForge container untouched. S0 volumes and private gitignored harness outputs retained. No Iris sync performed. The eventual merged Provider constraint still requires separate Iris policy sync (break-glass) before it is live.

Not done: reason list by role; additional audit event beyond Provenance; reopen; open-charts board entry points; blocking raw unsigned Encounter cancellation; PR #661 claim-evidence follow-up. The dependency-check/write race remains a stated design limit for the future implementation.

Status: blocked.
