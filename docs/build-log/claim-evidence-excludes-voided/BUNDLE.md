# Claim evidence excludes voided Encounters — author evidence (#661 follow-up, A11)

Status: **NOT EVALUATED**. Claude (Opus 5.5) authored this change; Codex must evaluate the exact PR head before merge.

Branch: `drbang-iva/claim-evidence-excludes-voided`
Base: `477f82b06e57346caced6f161f4cc0c253a6c3ce`

## Result

`claimServiceEncounters` (`mcp/src/claims/interpretation-hold.ts`) now also drops Encounters whose `status` is
`cancelled` or `entered-in-error`. It is the only same-day Encounter collector for claims, so one filter covers both
consumers: interpretation evidence (`loadClaimEvidence`, used by the draft builder and the submit handler) and the
same-day pair advisory candidates in the draft builder. Every other status keeps its current behaviour.

No query, policy, or write changed. The filter is in memory on the existing `Encounter?subject=` read, so there is no
live-authorization lane to run for this slice.

## Premises (re-verified at `477f82b0`)

- P1: `claimServiceEncounters` is at `interpretation-hold.ts:93-97` and filters by subject and service day only. Callers:
  `loadClaimEvidence` (`:100`, called from `claim-draft.ts:179` and `claimmd-handlers.ts:213`) and `claim-draft.ts:191`
  (`sameDayIds`). No other caller.
- P2: `claim-draft.ts:83` requires the claim's own Encounter to be `finished`, so the filter never removes it.
- P3: per-file counts at head (pass/fail) match the kickoff sweep, plus the new tests: `claimAmountContract` 7/0,
  `claimHandlers` 80/0 (79 + V3), `claimDraft` 13/0, `claimInterpretationHold` 22/0 (18 + V1, V2, V4, V5),
  `claimSearchHandler` 3/0, `clearinghouseAdapter` 5/0, `diagnosisDemotionImpact` 8/0, `diagnosisOrder` 8/0,
  `paginationHandlers` 7/0, `reportingRoutes` 5/0, `submitClaimsClearinghouse` 11/0, `procedure-charge-laterality` 14/0.
  No existing assertion changed.

## Guards

V1–V5 are exercised at the real handlers: `handleClaimDraftRequest` (V1, V2, V4, V5) and `handleSubmitClaimRequest`
(V3). Break → red → restore → green outputs are in [`GUARDS.md`](GUARDS.md).

## Checks

Each full run used its own dedicated PostgreSQL 16 container (`odos-a11-base`, `odos-a11-head`) with
`ODOS_POSTGRES_URL` set, and ran the CI mcp step's file set (`src/__tests__`, `tests`, and the nine `../tests/*`
directories — 451 files) with `node --import tsx --test --test-concurrency=1`. `.odos/operator.env` and
`.odos/operator-identity.json` were absent.

The file list was built with `find` rather than `**`, because macOS `/bin/bash` 3.2 has no `globstar`. A first attempt
with `shopt -s globstar` silently expanded `src/__tests__/**` to 5 of 20 files and `../tests/smart/**` to 7 of 8. Those
counts were discarded.

| | tests | pass | fail | skipped |
|---|---|---|---|---|
| base `477f82b0` | 6476 | 6417 | 0 | 59 |
| head | 6481 | 6422 | 0 | 59 |

Delta: +5 tests, +5 pass (V1–V5). No known flake fired.

- `npx tsc --noEmit` (mcp): exit 0.
- `npm run preflight`: `0 warning(s), 0 hard block(s)` at both base and head; head exit 0.
- Containers stopped at the end; `docker ps` lists no `odos-a11-*` container.

## Risks and follow-ups

- **Scope is deliberately narrow.** Migrated Encounters, other statuses (`planned`, `arrived`, `triaged`, `onleave`,
  `unknown`), and the scoped proposal query remain as they were, per the ruling.
- **Advisory proposals are still loaded practice-wide** (`loadClaimAdvisoryProposals`) and narrowed by `sameDayIds`.
  That narrowing is now also status-aware. The scoped proposal query is tracked separately and not touched here.
- **Status is read from the same row the day filter uses.** An Encounter voided after the claim is drafted but before
  it is submitted is excluded at submit time too, because submit re-reads evidence.
