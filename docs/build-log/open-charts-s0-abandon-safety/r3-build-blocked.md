# S0 R3 sealed bundle — blocked

R3's three exact guard corrections are implemented and mutation proven. Full suites, typechecks, preflight, UI build and the credentialed live lane passed. The independent browser proof stopped after confirmation: on a finding-bearing visit, accepting the dialog produced no observed `/abandon` response within 30 seconds. The product request outcome is unresolved. Kickoff rule 15 requires STOP. No PR, push, commit, merge or Iris sync occurred.

## Identity and scope

- Base and HEAD: `18932ecd53463987172f07b768aa9717fa48c671`; branch `drbang-iva/open-charts-s0-abandon-safety`; patch uncommitted.
- PR URL: none. PR #647's branch and files untouched; R1 merge-order requirement remains.
- Source: new `mcp/src/clinical-graph/encounter-abandon-{endpoint,routes}.ts`; `mcp/src/index.ts` (one import, one registration); `mcp/src/authz/roles.ts` (Provider Encounter constraint only); `mcp/tests/fixtures/r10/finding-write-exclusions.json` (one entry); new `ui/src/lib/encounter-abandon.ts`; `ui/src/components/charting/EncounterHeader.tsx` (abandon path only).
- Tests: new `mcp/tests/encounterAbandon.test.ts`, `mcp/tests/encounterAbandonAuthzLive.test.ts`, `ui/tests/encounterAbandon.test.tsx`; `mcp/tests/threeRoleModel.test.ts` (A9 append and R3 composite assertion only); `ui/tests/clinicalGraphRouting.test.tsx` (59→60 only).
- Scanner: `scripts/fhir-read-grant-check.ts` changed only nine `line:` numbers after the two `index.ts` additions. No entry or other field changed.
- Evidence: this directory. No new decision, `decisions/INDEX.md` update, or Mandate 14 ledger row; no new medical code or regulated citation was introduced.

## P1–P7 and R3 guards

P1, P3–P5 and P7 remain as recorded in `preflight-blocked.md`. P2 **live passed** on fresh R3 stack with staff-only human caller: checked-in Appointment → actual Start-exam helper → Encounter `in-progress`, all 16 dependency kinds empty. P6 was corrected per R3: the Admin+Provider composite assertion now pins the exact signed-status constraint and its behavior; criteria and AccessPolicy-read checks remain. The earlier P6 claim is historical and wrong.

[R3 mutation table](mutations.md): composite constraint removed → 1 fail, restored → 1 pass; UI client's shared import removed → 1 fail, restored → 1 pass; first moved scanner entry set to old line → 1 fail with “no longer matches a real ungranted call site,” restored → 1 pass. Each run had zero skips. R3 edits stayed within the exact ruling.

## Checks (baseline → patch)

| Command | Base `18932ecd` | R3 patch |
|---|---|---|
| `cd ui && npm test` | 1865 tests, 1865 pass, 0 fail, 0 skipped | 1867 tests, 1867 pass, 0 fail, 0 skipped |
| CI direct MCP Node runner, with `ODOS_POSTGRES_URL` on dedicated S0 Postgres | 6369 tests, 6314 pass, 0 fail, 55 skipped | 6417 tests, 6360 pass, 0 fail, 57 skipped |
| Root/MCP/UI `npx tsc --noEmit` (UI also `--skipLibCheck`) | all exit 0 | all exit 0 |
| `npm run preflight` | exit 0; 0 warnings, 0 hard blocks | exit 0; 0 warnings, 0 hard blocks |
| `cd ui && npm run build` | not run | exit 0; 341 modules transformed |
| `git diff --check` | — | exit 0 |

The MCP full command is recorded verbatim in `preflight-blocked.md`. The two live tests were skipped in the full unit run, then explicitly enabled and passed below. `.odos/operator.env` and `.odos/operator-identity.json` were absent during all unit runs.

## Live lanes and A1–A12

Fresh stack `odos-s0abandon-r3` on `http://localhost:18103/`, byte-identical server and MEDPLUM_BASE_URL; healthcheck attempt 15/90, polling every two seconds. `npm --prefix mcp run test:live-integration`: smoke 12/12 and integration 218/218, no failures/skips. Role repair and disposable policy sync exit 0; GITHUB_ACTIONS=true applied only to repair. `npm --prefix mcp run test:live-authz`: 78/78, no failures/skips. Staff and Provider test identities each have one role; synthetic admin/service clients only set up or inspect fixtures.

[A1–A7 and A9–A11 mutations](mutations.md) each went red under a deliberate break and green after restoration; A2 covered all 16 kinds, A10 deleted/restored the registry entry. A8 live: signed Provider raw PATCH refused (403), Encounter still `finished`; same Provider's unsigned raw PATCH succeeded (200), Encounter readback `cancelled`: test 1 pass, 0 fail, 0 skipped. A12 live: actual Start-exam empty visit abandoned (200), readback `cancelled` and `reasonCode=abandoned`, caller Provenance found; finding-bearing visit 409 with `Observation:1` and unchanged Encounter; signed visit 409 with unchanged Encounter: test 1 pass, 0 fail, 0 skipped.

A8 deliberate live break remains incomplete. A direct admin AccessPolicy update returned 403; an attempted disposable bootstrap policy sync with the source constraint temporarily removed also returned 403 before any update. The source was restored and the follow-up sync reported every policy MATCH with zero updates. No A8 mutant raw PATCH ran. A fresh pre-install mutation stack is a possible next proof. A12 deliberate break was not run after the browser STOP.

## Browser proof 3 STOP

Actual chart route was served from this worktree and the disposable stack; a Provider-only synthetic browser session loaded an empty visit. The [confirmation screenshot](confirmation.png) shows the required language, and request observation confirmed zero `/abandon` calls before acceptance. On the finding-bearing visit, the browser accepted the dialog, but the capture harness observed no `/abandon` **response** within 30 seconds. It did not record whether a request was emitted or whether the dialog remained mounted; the cause is not established. The app and Medplum health endpoints still responded afterward. This is an S0 product-path ambiguity, so no retry or product edit was made. The 409 screenshot and signed-disabled screenshot remain missing. The direct HTTP live A12 test above does not prove the browser path.

Required ruling: authorize a controlled browser rerun that waits for the Encounter to finish loading and records both request and response events after confirmation. If it still fails, authorize only the resulting named product fix after the failure is identified. No existing assertion change is proposed.

## Harness corrections and limits

R2: checked-in synthetic Appointment gained valid start/end; the Start-exam adapter used the actual UI source argument and correct FHIR search keys. R3: the A8 runner supplied the same synthetic admin credentials as the baseline lane (first run stopped before PATCH); route authentication's service client changed from seeder to caller after a same-query control showed seeder 403 and caller 200, with no S0 request in that failed run. Browser capture normalized dialog whitespace only; a disposable SMART signing key and loopback FHIR proxy let the actual app run locally. No expected value, assertion, or product code changed in those harness corrections.

The dependency check and final transaction are not atomic; intervening writes remain a stated design limit. Deferred: reason list by role, extra audit event beyond Provenance, reopen, board entry points (slice D), raw unsigned FHIR cancellation blocking, PR #661 claim-evidence follow-up. The merged Provider constraint needs separate Iris break-glass policy sync before it is live there. This author patch is NOT EVALUATED; Claude Opus 5.5 independent evaluation remains required.

## Cleanup

Local Vite, MCP and loopback proxy processes stopped. `docker-compose -p odos-s0abandon-r3 -f docker-compose.dr-drill.yml -f .odos/s0-compose-r3.yml down`: exit 0. `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'`:

```
vf-prac1b-walk-db    Up 4 days    127.0.0.1:55481->5432/tcp
```

Synthetic S0 volumes and private gitignored harness files retained; VisionForge container untouched.

blocked
