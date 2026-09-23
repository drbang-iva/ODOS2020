# S3c-2c-2b-4 author bundle

The claim draft and submit path now hold fee-classified imaging lines when no same-service-day interpretation exists. The draft warns about a kept same-day OCT/photo pair, including proposals on another signed encounter. Partial submissions name held lines; all-held submissions return 409 without writes or an adapter call. This is Codex-authored, **NOT EVALUATED**, and must receive independent Claude Opus/Fable evaluation at the final PR head before merge.

Branch: `drbang-iva/followup-s3c2c2b4-claim-hold`, based on `origin/main c61c58832ef12bec46c628d8c9dfe6e40c28c1d9`. The PR URL and final head are in the handoff. No merge or deployment was performed.

## Premises and rulings

P1: At the pinned base, `buildClaimDraft` reads encounter ChargeItems and holds an otherwise billable charge without a confirmed linked diagnosis before return; the handler passes the caller FHIR client. P2: `handleSubmitClaimRequest` previously persisted hand-added ChargeItems before creating the Claim and calling the adapter. P3: materialization writes the proposal identifier, procedure-concept coding and encounter context. P4: the existing `chargeImageType`, literal `serviceDay`, `sameDayWarnings` and fee-schedule snapshot helpers were reused. P5: the practice read inventory includes the required resource types; a **single-role human staff caller** with this synthetic patient's compartment read its charge-proposal Basic (200) and reached the `claims.manage` draft route (200). P6: the existing submit result panel and client mapping were extended; draft warnings already rendered. P7: the three existing warning pins remained unedited and passed; the sole authorized change to `claimDraft.test.ts` kept its exact `deepEqual` search list and added ChargeItemDefinition in the observed running order.

Kickoff §8 rulings were verified at `c61c5883`: the fee snapshot adds an unconditional ChargeItemDefinition search; both audit registries lack `claim.submit.lines-held`; the amount-contract mock supplies no Basic or fee results; provider-only policy permits a patient-compartment DiagnosticReport `final` to `entered-in-error` update. The implementation uses existing `claim.submit.completed` reason for partial holds and `claim.submit.failed` with `Claim/uncreated` and `all-lines-held: <n> lines` for 409. Unloadable proposals fall through to concept, code and not-gated. `claimAmountContract.test.ts` is unchanged and all six cases pass. No audit registry or AccessPolicy changed.

## Tracked files

- New `mcp/src/claims/interpretation-hold.ts` and `mcp/tests/claimInterpretationHold.test.ts`.
- Changed `mcp/src/claims/claim-draft.ts` and `mcp/src/claims/claimmd-handlers.ts` (submit handler only).
- Changed `mcp/tests/claimDraft.test.ts` (one exact search-list assertion) and appended `mcp/tests/submitClaimsClearinghouse.test.ts`.
- Changed `ui/src/lib/submit-claims.ts`, `ui/src/scenes/claims/SubmitClaims.tsx`, and appended `ui/tests/submitClaims.test.tsx`.
- This bundle and three synthetic browser images in `docs/build-log/followup-s3c2c2b4-claim-hold/evidence/`.

No authz, policy, audit registry, sign-gate, slice-3b, schema, index, ledger, deployment, script or CI file was edited. No billing code was added to a production rule; test and live codes were synthetic fee-linked alphanumerics. No new decision or medical code needs a `decisions/INDEX.md` or Mandate 14 ledger entry. PerformanceOD was read-only.

## Suites and guard demonstrations

Every MCP suite and mutation used dedicated `odos-s3c2c2b4-*` PostgreSQL through `ODOS_POSTGRES_URL`, matching CI; `.odos/operator.env` and `.odos/operator-identity.json` were moved aside. An earlier full-suite attempt with those live operator files present was void and produced nine setup failures; the corrected clean rerun below passed. No `.odos/` output is tracked.

Full MCP command, from `mcp/`:

```sh
node --import tsx --test --test-concurrency=1 'src/__tests__/**/*.test.ts' 'tests/**/*.test.ts' '../tests/boundaries/**/*.test.ts' '../tests/observation-status-machine/**/*.test.ts' '../tests/setup-wizard/**/*.test.ts' '../tests/preflight/**/*.test.ts' '../tests/smart/**/*.test.ts' '../tests/cds/**/*.test.ts' '../tests/agentops/**/*.test.ts' '../tests/bulk-data/**/*.test.ts' '../tests/mandate-8/**/*.test.ts'
```

| Check | Base `c61c5883` | Final source |
|---|---:|---:|
| Full MCP | 6342 tests; 6287 pass; 0 fail; 55 skipped; exit 0 | 6362 tests; 6307 pass; 0 fail; 55 skipped; exit 0 |
| `npm --prefix ui test` | 1863 tests; 1863 pass; 0 fail; 0 skipped; exit 0 | 1865 tests; 1865 pass; 0 fail; 0 skipped; exit 0 |
| `mcp/: npx tsc --noEmit` | — | exit 0 after final source edit |
| `ui/: npx tsc --noEmit --skipLibCheck` | — | exit 0; UI unchanged afterward |
| `npm run typecheck:scripts` | — | exit 0; scripts unchanged afterward |
| `npm run preflight` | — | 0 warnings, 0 hard blocks; exit 0 after final source edit |
| `git diff --check` | — | exit 0 |

All changed guards were broken, observed red, restored, and observed green. Entries give `tests/pass/fail/exit`:

| Guard | Red mutation | Restored green |
|---|---:|---:|
| H1 draft holds unevidenced line | `1/0/1/1` | `1/1/0/0` |
| H2 keeps evidenced line | `1/0/1/1` | `1/1/0/0` |
| H3 snapshot beats later answer | `1/0/1/1` | `1/1/0/0` |
| H4 raw ChargeItem concept match | `1/0/1/1` | `1/1/0/0` |
| H5 typed hold before persistence | `2/0/2/1` | `2/2/0/0` |
| H6 all-held 409, zero writes/calls | `2/0/2/1` | `2/2/0/0` |
| H7 unmatched code not gated | `2/0/2/1` | `2/2/0/0` |
| H8 unanswered fee classified/held | `1/0/1/1` | `1/1/0/0` |
| H9 advisory only | `1/0/1/1` | `1/1/0/0` |
| H9 cross-encounter advisory | `1/0/1/1` | `1/1/0/0` |
| H10 byte-identical clean submits | `2/0/2/1` | `2/2/0/0` |
| H11 literal service day at UTC boundary | `1/0/1/1` | `1/1/0/0` |
| H12 held-line UI and 409 | `2/1/1/1` | `2/2/0/0` |
| H13 fee-search pin | `1/0/1/1` | `1/1/0/0` |
| H14 unloadable proposal fallback | `2/0/2/1` | `2/2/0/0` |

H11 used service `2026-09-23T23:30:00-04:00` and an interpretation `2026-09-24T01:00:00Z`; naive UTC-day conversion incorrectly matches, while the literal prefixes differ. H10 compared Claim.MD and Stedi response, persistence and payload bytes against base fixtures. Submit proofs used **handler-level fake Claim.MD and Stedi adapters only**; no real clearinghouse call occurred. Partial holds created no held ChargeItem and sent no held line; all-held produced 409 with zero writes and adapter calls.

## Live and browser proof

The dedicated fresh stack's server `baseUrl` and every lane's `MEDPLUM_BASE_URL` were exactly `http://localhost:18103/`. Healthcheck passed on **attempt 1/90**, polling every 2 seconds. In required order: smoke `12/12 pass, 0 fail, 0 skipped`; integration `218/218 pass, 0 fail, 0 skipped`; role repair with `GITHUB_ACTIONS=true` only on that command created 3 policies; sync matched provider, staff, admin and composite with 0 updates; authorization `78/78 pass, 0 fail, 0 skipped`. All exited 0.

The fixture created a synthetic fee first, then a signed visit, finalized proposal, fundus ChargeItem, completed Media, final DiagnosticReport, coverage and ordinary visit line. The **human composite** caller's served draft returned 200 with the imaging line kept and no hold warning. For the same report version, `If-Match` and retraction payload, the composite raw FHIR update returned **403**, leaving the report final; the **human provider-only** caller (one provider AccessPolicy, patient compartment bound to the synthetic patient) returned **200** and set it to `entered-in-error`. This paired control isolates the 403 to caller role composition, consistent with kickoff §8. The composite then read the served draft (200): fundus line excluded, ordinary visit line kept, exact warning `Synthetic fundus photograph was held: it needs an interpretation and report on this visit.` The single-role human staff caller also read the proposal Basic and the after-retraction draft (both 200), with the same hold warning.

Browser proof used the current served Vite/claims route and synthetic composite human session, loaded the encounter and displayed the warning with zero page errors. A detached read-only base `c61c5883` server loaded the same already-retracted encounter: two charges, no warning, zero page errors. `evidence/draft-before.png` and `evidence/draft-after.png` are matching 1152×212 scoped browser captures. `evidence/result-preview.png` shows the production result component populated by a **synthetic handler-level fake-adapter response**; it is not a real clearinghouse result. Images were visually checked for synthetic-only content and are referenced in the PR's before/after block.

Harness-only corrections: this host required `docker-compose`; one operator login returned a transient 400 before an identical retry succeeded; initial role selection matched two policies until the exact single-role tag was chosen; a client-credentials staff principal could read Basic but received 401 at the human claims route, so single-role human staff was invited and verified; the initial MCP runtime service lacked membership read, so a separate disposable project-admin runtime service fixed startup. None changed product code or expected results.

Not in this slice: Stedi resubmission; unmatched hand-typed imaging codes; per-concept precision; modifiers; cross-panel refresh; staff Follow-up Accept 502. Real clearinghouse behavior is untested by design. Independent evaluation, bot reviews at final head, merge and deployment are follow-ups. Task containers and processes are stopped in the final handoff, with `docker ps` quoted there.

needs-review
