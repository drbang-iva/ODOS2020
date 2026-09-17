# R10 A3.1 — sealed stop report, rev 2.2

**BLOCKED / NOT EVALUATED.** Coded-by: Codex — GPT-6 Astra, high effort.
Independent evaluator remains Claude Opus. No evaluation marker, PR or merge.

## Summary

Resumed the existing disposable stack under kickoff rev 2.2. Provider G-g passed on a fresh in-progress Encounter.
G-h's production amendment transaction partially persisted: Observation PATCH succeeded, but its Provenance PUT
was forbidden. Stopped at the capability gate, as explicitly required. Application implementation has not begun.

## Exact workspace

Branch: `drbang-iva/r10-a3-1`.
Unchanged base/HEAD: `1706d7c8417b04791471d4332b4ecd712883bf11`.
New files only: `mcp/scripts/r10-a3-preflight.mjs` and `docs/evidence/r10-a3-1/*`, within §4.
No commits or push. No existing application files or assertions changed.

## Server, project and principals

- Compose project: `odos-r10-a3-1`; port 29131; subnet `10.249.142.0/24`.
- Medplum `5.1.30-9b1bd92`, pinned image recorded in `runtime.json`.
- Isolated PostgreSQL 16 (`postgres:16-alpine`) and Redis 7; no shared database used.
- Synthetic FHIR project: `14e0ec2a-cc7f-4ce6-be82-49d9417f3e95`.
- Provider: `r10-a3-1-provider@example.invalid`; `AccessPolicy/95fa2233-96b0-49df-850b-f34981c88326`.
- Staff: `r10-a3-1-staff@example.invalid`; `AccessPolicy/2a64dbb9-ffea-4cbe-9647-b0713f422913`.
- Both stored policies matched canonical compiler output during bootstrap. No policy edits on resume.
- Secrets stay in the ignored private fixture; published evidence contains no passwords or tokens.

## Capability results

| Probe | Role | Result |
|---|---|---|
| G-e | provider | Prior PASS stands: concurrent 201/200, one Condition, replay 200 and same id |
| G-f | provider | Prior PASS stands: concurrent 201/200, one Provenance, replay JSON unchanged |
| G-f | staff | Prior PASS stands: concurrent 201/200, one Provenance, replay JSON unchanged |
| G-g | provider | Fresh PASS: actual version advance, stale PUT 412, whole Encounter unchanged |
| G-h | provider | FAIL: bundle entries 200/403; Observation changed, Provenance missing |

The resumed command executed **2 probes: 1 PASS, 1 FAIL**, exit 1. With accepted prior results,
`gate-results.json` contains **5 probe/role rows: 4 PASS, 1 FAIL**. No staff G-g was run on resume.

### G-g evidence and both prior attempts

`setup-noop-gate-http.json` / `setup-noop-gate-results.json`: initial setup was a no-op, so the supposed stale PUT
was current and changed the old Encounter to finished.
`pre-rev22-gate-http.json` / `pre-rev22-gate-results.json`: provider setup then advanced its version and stale PUT
returned 412; staff setup hit the closed-Encounter policy. Rev 2.2 accepts this diagnosis and makes G-g provider-only.

Fresh final G-g: `Encounter/1d534984-81a4-4aa5-84fa-951413920a7f`, asserted `in-progress`.
Version `cf0bf879-e148-464d-9c14-3a27bfe1abad` → `a7163279-91a3-4b3b-8689-6e1516832c8c` during setup.
Stale PUT returned **412**; readback exactly matched the updated resource. Events 1–4 in `gate-http.json`.

### G-h exact failure and readback

Own fresh `in-progress` Encounter: `Encounter/c52a7cee-75a0-4f58-b68a-a67f33a15fc9`.
Own canonical target: `Observation/b280ae02-bb61-433d-a31e-3fc24d9b4ba1`, starting status `final`.
Used `buildAmendmentTransaction` from `mcp/src/fhir/scribeAttestation.ts` (the production builder used by
`amend_observation`), submitted with the provider login. This capability probe exercised the builder and real FHIR
transaction, **not the complete MCP dispatch or local audit runtime**; full dispatch coverage remains §7/T22 work.

Outer HTTP **200**; transaction-response entries:
1. Observation JSON PATCH: **200**.
2. `PUT Provenance/a109f56b-67e1-4273-bd2e-e1a7904be237`: **403 Forbidden**.

Read-only persistence checks after stopping writes:
- Observation GET **200**, `final` → `amended`.
- Version `e09029ce-0852-4405-8ec5-fab45cd499da` → `25351705-4673-420c-a679-1dd52b8f48b1`.
- `identifier`, every `component` (including R10_CURRENT_META and R10_OPERATION), and every `extension`:
  JSON serialization byte-identical before/after.
- Provenance GET using the bootstrap seeder: **404**.

Thus the field-preservation part succeeded, but the complete production amendment transaction did not.
The server did not roll back the successful Observation entry after the forbidden Provenance entry in this observed
response. No conclusion is claimed about other transaction shapes. No retry or policy workaround was attempted.
Raw request/response: `gate-http.json`, events 5–7. Persisted readback: `gate-h-readback.json`.

## Verification and outstanding work

- `node --check mcp/scripts/r10-a3-preflight.mjs`: exit 0.
- `git diff --check`: exit 0 (no tracked changes; new files remain untracked).
- P1–P26 behavioral verification: **INCOMPLETE**, not resumed after gate failure.
- Full suites, §7 live-authz, mutation guards, T22 registry/census, release checker: **NOT RUN / NOT IMPLEMENTED**.
- No changed existing assertions; no V/W migration rows, no terminology additions or Mandate 14 ledger changes.
- No new design decision; no decisions/INDEX.md update.
- No application files, UI files, roles or policies changed.

## Follow-up boundary

Hand this blocker to **Claude Opus, high effort** for adjudication of the amendment Provenance write and gate scope.
The observed failure is at the production builder's Provenance PUT; do not assume policy root cause beyond the
recorded 403. §4 forbids roles.ts/policy changes. Resume needs a concrete ruling for this gate failure before the
library and consumer build proceeds. No request for an evaluated-label override.

## Shutdown

Executed `docker ps -q --filter "name=^odos-r10-a3-1-" | xargs -r docker stop`.
Stopped, not removed:
- `odos-r10-a3-1-medplum-1`
- `odos-r10-a3-1-redis-1`
- `odos-r10-a3-1-postgres-1`

Prior reports and both prior gate runs are preserved. Status: **BLOCKED; NOT EVALUATED; no PR**.
