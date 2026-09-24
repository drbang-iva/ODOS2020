# Corrected claims go through the interpretation hold — author evidence (#666 follow-up)

Status: **NOT EVALUATED**. Claude (Opus 5.5) authored this change; Codex must evaluate the exact PR head before merge.

Branch: `drbang-iva/correction-claims-interpretation-hold`
Base: `8884b6a62b275ba17ee1308ef7a7405e169fd792` (#666 head; kickoff R0 stacks this slice on #666)
Kickoff: performance-od `decisions/2026-09-24-odos-correction-claims-interpretation-hold-kickoff.md`

## Result

- **Corrections** (`intent: "correct"`) now run the #661 interpretation hold before anything is written or sent. If
  any line is held, ODOS refuses the whole correction with `409 { code: "correction-lines-held", heldLines }`. No
  ChargeItem or Claim is written, nothing is transmitted, the original Claim is not touched, and the refusal is
  audited as `claim.submit.failed`.
- **Voids** are unchanged and never held.
- **Ordinary submit** is unchanged. Its hold block was extracted to `evaluateClaimLineHold` (read-only; stored lines
  are judged by their FHIR copy) and submit was migrated first, as its own commit (`c6330af1`), with zero behaviour
  change. The correction caller came second (`a9137462`). Each endpoint owns its policy: submit drops held lines, a
  correction refuses.

The mechanic lives in `claimmd-handlers.ts` beside its two callers rather than in `interpretation-hold.ts`, because it
reads stored ChargeItems and throws the handlers' own `ClaimSubmissionValidationError`.

## Premises (re-verified at `8884b6a6`)

- P1 holds. `handleStediClaimResubmissionRequest` picked its source at `:387` (`revisedClaim` for a correction, the
  snapshot for a void), validated diagnosis pointers, persisted ChargeItems, created the Claim and transmitted it, with
  no call to `loadClaimHoldContext`, `loadClaimEvidence` or `holdLines`.
- P2 holds. The existing resubmission tests are in `mcp/tests/claimHandlers.test.ts` (from `:585`). None were edited,
  and all stay green.
- P3: there are only two call sites that transmit a claim: ordinary submit (`submitProfessionalClaim` for Claim.MD and
  Stedi) and this resubmission path. There is no Claim.MD correction path: ordinary submit rejects any
  `claimFrequencyCode` or `claimControlNumber` with "Corrected and voided claims must use the Stedi resubmission
  endpoint."

## Guards

C1–C5 at the real handler, with break → red → restore → green outputs in [`GUARDS.md`](GUARDS.md).

## Checks

Each full run used its own PostgreSQL 16 container (`odos-corr-base`, `odos-corr-head`) with `ODOS_POSTGRES_URL` set,
over the CI mcp file set built with `find` (451 files), using `node --import tsx --test --test-concurrency=1`.
`.odos/operator.env` and `.odos/operator-identity.json` were absent.

| | tests | pass | fail | skipped |
|---|---|---|---|---|
| base `8884b6a6` | 6481 | 6422 | 0 | 59 |
| head | 6485 | 6426 | 0 | 59 |

Delta: +4 tests, +4 pass (C1–C4; C5 is held by existing tests). No known flake fired.

- mcp `npx tsc --noEmit`: exit 0 at base and head.
- `npm run preflight`: `0 warning(s), 0 hard block(s)`, exit 0 at base and head.
- Containers stopped; `docker ps` lists no `odos-corr-*` container.

No query, AccessPolicy or write path was added. The hold reuses submit's existing reads (ChargeItem read, fee
schedule, charge proposals, Encounter/Media/DiagnosticReport by encounter) under the same staff token, so there is no
new live-authorization surface.

## Risks and follow-ups

- **A "correction" of a claim the payer never accepted** goes out as frequency 1 (a fresh original), and it is also
  refused whole. There is no recoupment risk there, so dropping the line like ordinary submit would also be
  defensible. The ruling is keyed on intent, and refusing is the conservative reading. Flagged for the operator.
- **Stacked on #666.** After #666 merges: `git rebase --onto origin/main 8884b6a6`, retarget the PR to main, re-run
  the checks, and get a fresh evaluation at the new head (kickoff R0).
- **No UI.** Whatever screen sends corrections will now receive a 409 with `heldLines`. How that is shown to the biller
  is out of scope.
