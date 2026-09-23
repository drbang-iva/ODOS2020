> Historical R2 STOP; current status: [R3 build bundle](r3-build-blocked.md).

# S0 R2 build bundle — blocked

R2 corrected the synthetic Appointment setup and P2 passed live. The S0 endpoint, UI confirmation and signed-Encounter policy guard are implemented locally. Full regression then hit existing assertions; kickoff rule 11 requires STOP. No existing assertion or out-of-scope scanner entry was changed to pass. This report supersedes the historical preflight STOP.

- Base and HEAD: `18932ecd53463987172f07b768aa9717fa48c671`.
- Branch: `drbang-iva/open-charts-s0-abandon-safety`.
- Commit: none; patch uncommitted. PR URL: none. No push, merge, or independent evaluation.
- `mcp/src/index.ts`: exactly one import and one registration added beside void routing. PR #647 branch/files untouched. R1 merge-order rebase requirement remains.

## Precise STOP and requested ruling

1. `mcp/tests/threeRoleModel.test.ts:757`: existing Admin+Provider composite assertion requires `encounterUpdate.writeConstraint === undefined`. Actual is the required signed-status constraint. P6 missed this exact pin at lines 742–759; the earlier conclusion was incomplete. A ruling must authorize replacing this exact assertion with the required constraint while retaining finished-to-finished amendment coverage and all other composite assertions.
2. `ui/tests/clinicalGraphRouting.test.tsx:41`: source client census is now 60, expected 59. A ruling must allow the exact census update for the newly authorized abandonment client, preserving shared routing/authentication assertions.
3. `scripts/fhir-read-grant-check.ts:140–148`: nine existing index.ts call-site exclusions use exact line numbers. The import shifts the first eight by +1 and the registration shifts the last by +2. Scanner fails first at stale `index.ts:3269 fhir.create VisionPrescription`, causing six existing preflight test failures and preflight failure. A ruling must expand the allowlist to refresh those nine source-line references after verifying each unchanged call site. No grant, resource type, callee, or reason change is proposed.

These are existing guard/scope changes, not R2 setup-data repairs. None has been made. No product request failure was bypassed.

## Files touched

- New server endpoint and routes: `mcp/src/clinical-graph/encounter-abandon-endpoint.ts`, `encounter-abandon-routes.ts`.
- Server wiring, Provider Encounter constraint, transaction registry: `mcp/src/index.ts`, `mcp/src/authz/roles.ts`, `mcp/tests/fixtures/r10/finding-write-exclusions.json`.
- UI client and existing header: `ui/src/lib/encounter-abandon.ts`, `ui/src/components/charting/EncounterHeader.tsx`.
- New tests: `mcp/tests/encounterAbandon.test.ts`, `mcp/tests/encounterAbandonAuthzLive.test.ts`, `ui/tests/encounterAbandon.test.tsx`.
- Append-only test addition: `mcp/tests/threeRoleModel.test.ts`.
- Evidence: this directory. No new decision, decisions/INDEX.md edit, or Mandate 14 ledger row; existing coding/provenance helpers reused.

## P1–P7

P1: existing Encounter cancellation writer and named start/finish paths located. P2: **LIVE PASS**, fresh synthetic stack, staff-only human caller through actual Start-exam helper; Encounter `in-progress`, dependency result `[]` across all 16 kinds. P3: existing void/closed/migration guards and registration located. P4: baseline Staff unfinished-only constraint, unconstrained Provider Encounter write, Admin no clinical write, and Basic reads confirmed. P5: section-content helper is too narrow for all dependencies. **P6: FAILED premise; exact composite constraint pin missed initially and caught by regression.** P7: registry enforces missing/stale entries; added entry and deletion mutation demonstrated.

## Verification and counts

Baseline details and full CI Node command are preserved in `preflight-blocked.md`; baseline was unchanged 18932ecd. Unit runs kept `.odos/operator.env` and `.odos/operator-identity.json` absent. All MCP runs set ODOS_POSTGRES_URL to dedicated S0 Postgres, never a shared database.

| Check | Baseline | Current patch |
|---|---|---|
| `cd ui && npm test` | 1865 tests, 1865 pass, 0 fail, 0 skipped | 1867 tests, 1866 pass, 1 fail, 0 skipped; exit 1 |
| MCP CI direct Node runner | 6369 tests, 6314 pass, 0 fail, 55 skipped | 6417 tests, 6353 pass, 7 fail, 57 skipped; exit 1 |
| Root `npx tsc --noEmit` | exit 0 | exit 0 |
| MCP `npx tsc --noEmit` | exit 0 | exit 0 |
| UI `npx tsc --noEmit --skipLibCheck` | exit 0 | exit 0 |
| `npm run preflight` | exit 0; 0 warnings, 0 hard blocks | exit 1; stale service-write exclusion |
| `git diff --check` | — | exit 0 |

New endpoint suite: initial stub 45 fail / 0 pass; implementation 45 pass / 0 fail. New UI suite: before wiring 2 fail / 0 pass; after wiring 2 pass / 0 fail. The final MCP run adds 45 endpoint tests, one policy test, and two skipped live tests; none of the skips proves authorization.

## A1–A12 and live proof

[A1–A7, A9–A11 deliberate red/green outputs](mutations.md): each broken guard failed and each restored guard passed; A2 covers all 16 kinds separately. A10 deleted the new registry entry and restored it. A11 bypassed confirmation to demonstrate first-click protection. All mutations restored before full regression.

A8: not run live; signed raw PATCH refusal and unsigned raw PATCH success unproven.
A12: not run; P2 proves fresh Start-exam emptiness but does not prove abandonment. Live test source is authored, not executed. S0 live success/provenance readback, observation-content refusal/readback, signed refusal/readback and browser screenshots remain outstanding. No production or Iris claim is made.

Fresh R2 stack on localhost:18103, byte-identical MEDPLUM_BASE_URL/server baseUrl. Health: attempt 14/90 at two-second intervals. Prescribed base lane order completed before P2: smoke 12/12, integration 218/218, role repair and disposable policy sync exit 0, authz 78/78 (all zero failures/skips). GITHUB_ACTIONS=true applied only to repair. Commands: `npm --prefix mcp run test:live-integration`, repair/sync harness, `npm --prefix mcp run test:live-authz`, then private P2 harness. Caller was a single-role synthetic staff human, not a composite identity. Synthetic admin only provisioned setup identities/resources.

R2 setup fix: checked-in synthetic Appointment gained valid start/end (`2026-09-23T14:00:00Z` / `2026-09-23T14:30:00Z`). No expected value, assertion, or product behavior changed. Harness adapter used the actual UI transaction source argument and correct FHIR search parameters before execution. Prior harness corrections and exact prior STOP are retained in historical report.

## Cleanup, risks and follow-ups

`docker-compose -p odos-s0abandon-r2 -f docker-compose.dr-drill.yml -f .odos/s0-compose-r2.yml down`: exit 0. S0 containers removed, private evidence and volumes retained. `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'`:

```
vf-prac1b-walk-db    Up 4 days    127.0.0.1:55481->5432/tcp
```

VisionForge container untouched. No Iris sync. The eventual merged Provider constraint requires separate break-glass Iris policy sync before it becomes live there. Dependency-check/write race remains a design limitation. Not done: reason list by role; extra audit event beyond Provenance; reopen; board entry points (slice D); raw unsigned FHIR cancellation blocking; PR #661 claim-evidence follow-up. No screenshot, PR, bot review, or independent evaluation yet. Claude Opus 5.5 independent evaluation remains required after completion.

blocked
