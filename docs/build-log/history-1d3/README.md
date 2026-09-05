# History 1d-3 — author evidence

Base: `ee651dcc6cdf6e9d1b2bfdbf49a52b31f4693b87` (freshly fetched `origin/main`).
Branch: `drbang-iva/history-slice-1d3`.
Scope: accepted companion decision `decisions/2026-09-04-odos-history-1d-rescope.md`, section 1d-3.

## What shipped behaviour does this change?

Nothing user-facing yet. The legacy reviewed-no-change builder, identity, carried-answer requirements, patient-only review constraint, and retirement logic are unchanged. The read response adds `lastReviewed: Array<{target, lastReviewed}>`; no UI consumes it yet.

The existing review endpoint additionally accepts `action: "items-reviewed"`, a client UUID `gestureId`, `method: "individual" | "bulk"`, and enumerated `targets`. This is the storage mechanism, not a bulk-answer gesture. Targets are checked against the section declaration/catalog, including eye requirements; tobacco and text have no option code. No ROS declaration, reminder, retraction, or UI was added.

Each new act has Observation code `history-item-review`, action value `items-reviewed`, and identifier `encounterId:sectionKey:gestureId` under the existing identifier namespace. Retries return the persisted actor/date/targets without any write. Reusing an ID with different targets or method refuses with 409. A new conditional PUT includes a fresh unobserved UUID version precondition to prevent overwriting a concurrent winner. Medplum can return either a 400 resolved-ID conflict or 412 version conflict; both paths re-read and compare the immutable winner. Other failures propagate.

Patient-wide item and legacy searches use `searchAll(..., {maxRows: 5000})`. A single reduction compares timestamps as instants and uses exact section/option/eye identity. Legacy dates are applied only through their explicit `derivedFrom` answer references. Current-encounter legacy completeness still filters by encounter. Answer capture still writes no item acts and retires only legacy acts.

## Checks and counts

Commands run from this worktree, except UI tests run from `ui/` so its JSX configuration applies.

| Check | Actual result |
| --- | --- |
| Baseline MCP History/search regressions | 76 passed, 0 failed, 0 skipped |
| Initial new-contract RED | 20 tests: 8 passed, 12 failed (missing new endpoint/read behaviour) |
| `npm --prefix mcp test -- tests/historyItemReview.test.ts` | 23 passed, 0 failed, 0 skipped |
| Final restored new + existing History/search tests | 99 passed, 0 failed, 0 skipped |
| Untouched `historyAnswerObservation.test.ts` | 3/3 |
| Untouched `historyTemplateEngine.test.ts` | 12/12 |
| Untouched `hpiEndpoint.test.ts` (includes 1a/1b/1c and 1d-1 guards) | 37/37 |
| Untouched `hpiPagination.test.ts` | 15/15 |
| Untouched `fhirSearch.test.ts` | 9/9 |
| Untouched UI `hpiSection.test.tsx` + `hpiDeltaBrowser.test.tsx` | 25/25 (24 component cases + 1 browser case) |
| `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` | 4,212 tests: 4,155 passed, 0 failed, 57 skipped; explicitly not a live-authz verdict |
| `npm test` from `ui/` | 1,235 passed, 0 failed, 0 skipped |
| `npm --prefix mcp run build` | exit 0, `tsc` |
| `npm run typecheck:scripts` | exit 0 |
| `npm run preflight` | 0 warnings, 0 hard blocks |
| Proxy coverage census | all 24 backend families covered by 27 proxy entries; advisory |

`checks.txt` preserves actual command-output tails. The first UI invocation from the repository root failed because it used the wrong JSX configuration; the correct unchanged package-directory invocation above passed.

## Mandate 17: five break/restore results

Each mutation was applied to real production source, the named behavioural test was executed, the source restored byte-for-byte, and the same test rerun. `mutations.txt` includes each patch and full RED/GREEN output.

| Mutation | RED | Restore |
| --- | --- | --- |
| Drop gestureId from act identifier | A-then-B fails, exit 1 | pass, exit 0 |
| Append a new UUID on every retry | Idempotent retry fails, exit 1 | pass, exit 0 |
| Apply legacy date to every answer in its section | Exact derivedFrom coverage fails, exit 1 | pass, exit 0 |
| Emit an item act during answer save | Zero item acts assertion fails, exit 1 | pass, exit 0 |
| Include item acts in answer-edit retirement query and predicate | Stored act immutability fails, exit 1 | pass, exit 0 |

After all five restores, 99/99 focused tests passed. The existing 1a/1b/1c/1d-1/1d-2 test files have zero diff from base.

## Live proof

`node --import tsx mcp/scripts/prove-history-item-review.ts` ran against local synthetic Medplum with a synthetic patient and encounters; see `live-proof.txt`. Seven scenarios cover A/B dates, unchanged retry versions, refusal of changed targets, answer create/edit leaving acts unchanged, later answer date, 26 acts over two encounters with page size 20, exact legacy reference coverage, and an additional deliberately synchronized race (200/409, one added act). The scenario count groups answer-date/immutability and retry/refusal checks.

The existing `historyPaginationMedplum.test.ts` ran untouched: 1/1 live test passes, including 600/1001/5000 answers, 25 legacy acts, indexed exclusion of 600 encounter answers, and the 5001-row refusal with 11-page count (`pagination-live.txt`).

The item proof first passed on the existing contract stack at `18103`. The larger untouched 5001-answer fixture hit that stack's 429 quota during seeding. The untouched pagination test and final item proof then passed on the already-running History test stack at `18403`; neither service nor quota configuration was modified. The old bind-mounted config path had been removed with its prior worktree, so this session makes no fresh configuration claim about that process.

This proves persistence against real local Medplum using the synthetic admin identity. It does not prove constrained-role AccessPolicy enforcement, a deployed release, or a future UI consumer.

## Files and follow-ups

Production: `mcp/src/clinical-graph/history-answer-observation.ts`, `mcp/src/clinical-graph/hpi-endpoint.ts`.
Verification: new `mcp/tests/historyItemReview.test.ts`, `mcp/scripts/prove-history-item-review.ts`, this build-log directory, and Mandate 14 ledger rows 60–61 in `data/code-bindings/v0.6-verification-ledger.md`.

No new design decision was introduced, so the companion `decisions/INDEX.md` was not changed. The accepted 1d-3 scope remains authoritative. Ledger rows are documentary and are not enforced registries. No medical terminology codes were added.

Status: author evidence only. A separately invoked evaluator must review the final head before merge. This session does not post an evaluation marker or apply an operator override label. CI and bot status are reported at the final PR head in the handoff, not frozen here as a completion claim.
