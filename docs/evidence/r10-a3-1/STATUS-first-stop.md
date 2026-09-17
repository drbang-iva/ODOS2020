# R10 A3.1 — BLOCKED / NOT EVALUATED

Coder: Codex — GPT-6 Astra, high effort. No implementation or evaluation verdict.

## Workspace

Branch: `drbang-iva/r10-a3-1`.
Base and unchanged HEAD: `1706d7c8417b04791471d4332b4ecd712883bf11`.
Fetched ODOS origin/main: `c742b2e4b543e0706b24f66aec6883a82f0d18a3`.
Fetched PerformanceOD origin/main: `c6e6543067bb044dce704a3b60acecf753ccdbc7`.
No commit, push or PR. Held-open implementation has not begun.

## Capability results

Disposable project `odos-r10-a3-1`, port 29131, subnet 10.249.142.0/24.
Medplum `5.1.30-9b1bd92`; isolated PostgreSQL 16 and Redis 7.
Project `14e0ec2a-cc7f-4ce6-be82-49d9417f3e95`.
Provider login `r10-a3-1-provider@example.invalid`, policy `AccessPolicy/95fa2233-96b0-49df-850b-f34981c88326`.
Staff login `r10-a3-1-staff@example.invalid`, policy `AccessPolicy/2a64dbb9-ffea-4cbe-9647-b0713f422913`.
Both stored policy resources matched the canonical compiler output. Passwords and tokens remain in gitignored private fixtures.

| G-e | provider | PASS |
| G-f | provider | PASS |
| G-f | staff | PASS |
| G-g | provider | PASS |
| G-g | staff | FAIL |

The second run executed five probe invocations: four passed and one failed during setup.
G-e: concurrent 201/200, one Condition, third response 200 with the same id.
G-f: provider and staff each concurrent 201/200, one Provenance, replay 200 with the JSON extension unchanged.
Provider G-g: 412 and full resource equality after the rejected stale write.
Staff G-g: **INCONCLUSIVE**, setup PUT returned 403 before a stale version was tested.
G-h: NOT RUN, due to the explicit stop-on-failure/inconclusive instruction.

### Harness defect and interpretation

The first G-g setup PUT was a no-op (`status: in-progress` on an in-progress Encounter), so its version did not advance.
The purported stale PUT was consequently current and returned 200, changing the synthetic Encounter to finished.
That attempt is preserved in `setup-noop-gate-http.json` and `setup-noop-gate-results.json`.
The setup was corrected to change `period.start` and assert version advancement. Provider G-g then passed.
However, the same Encounter remained finished from the first attempt; staff setup returned 403.
This is **not proof that Medplum fails stale If-Match enforcement**, nor proof that staff cannot update an open Encounter.
The run stopped without changing policies or continuing to G-h.
A resumed gate must use a fresh, in-progress Encounter per role/probe and verify its status before testing stale writes.

Raw results: `gate-http.json`, `gate-results.json`, per-probe JSON, `principals.json`, `runtime.json`.

## Premise verification limits

Comparison against the contract's checked head `9f58d5fc7a0d3cd98228d6af5e28fab53c377528` found no changes in
mcp/src, mcp/scripts, mcp/tests, the release UI test file or CI workflow. UI source changes were confined to
DiagnosisFindingsTable.tsx and DiagnosisWorkspace.tsx. Runtime census confirmed 47 definitions and 405 catalog rows.
The release source census confirmed 16 MCP declarations, four UI declarations and missing UI T4/T5/T6/T21/T22,
consistent with P19. **Full P1–P26 behavioral re-verification is not complete.** Source equality is not a substitute
for the contract's executable premises; no all-premises-PASS claim is made.

## Files and checks

Only new capability script `mcp/scripts/r10-a3-preflight.mjs` and evidence in this directory.
No existing assertions changed or removed. No application or UI files changed.
No V/W assertion migration, mutation guards, full suites, live-authz lane or release checker run completed.
`git diff --check` exited 0 for tracked changes; new files remain untracked.
No new clinical terminology or FHIR artifact claims; no Mandate 14 ledger changes.
No new design decision or decisions/INDEX.md change.

## Container shutdown

Stopped, not removed, using the requested project-filtered docker stop command:
- odos-r10-a3-1-medplum-1
- odos-r10-a3-1-redis-1
- odos-r10-a3-1-postgres-1

## Next boundary

Correct isolated probe setup and re-run G-e–G-h before application work. Finish P1–P26 re-verification.
All implementation, checks, mutation evidence, PR creation and independent Opus evaluation remain outstanding.
NOT EVALUATED. No evaluation marker posted. No merge.
