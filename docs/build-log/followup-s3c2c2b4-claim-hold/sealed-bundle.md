# S3c-2c-2b-4 author bundle

The claim draft and submit path hold fee-classified imaging lines when no same-service-day interpretation exists. Named proposals are read by identifier, so a practice-wide proposal count cannot hold unrelated lines. A failed scoped read or malformed named Basic holds only affected lines as unclassified; an absent named proposal still falls through. Typed billing codes are trimmed and uppercased before matching a fee in the CPT/HCPCS billing space. A failed practice-wide advisory list, including an unrelated malformed Basic, skips the same-day OCT/photo warning without holding a line. Partial submissions name held lines; all-held submissions return 409 without writes or an adapter call. This is Codex-authored, **NOT EVALUATED at the final head**, and must receive independent Claude Opus/Fable evaluation before merge.

Branch: `drbang-iva/followup-s3c2c2b4-claim-hold`, based on `origin/main c61c58832ef12bec46c628d8c9dfe6e40c28c1d9`. The PR URL and final head are in the handoff. No merge or deployment was performed.
Prior independent evaluations were NEEDS-WORK at `51d38494a5320693cd8edb018e8ff960f4124bf3` and `1d079d8a4ec2b38f4ce0e2202569c1bd3560e792`. Neither is a PASS on the new head.

## Premises and rulings

P1: At the pinned base, `buildClaimDraft` reads encounter ChargeItems and holds an otherwise billable charge without a confirmed linked diagnosis before return; the handler passes the caller FHIR client. P2: `handleSubmitClaimRequest` previously persisted hand-added ChargeItems before creating the Claim and calling the adapter. P3: materialization writes the proposal identifier, procedure-concept coding and encounter context. P4: the existing `chargeImageType`, literal `serviceDay`, `sameDayWarnings` and fee-schedule snapshot helpers were reused. P5: the practice read inventory includes the required resource types; a **single-role human staff caller** with this synthetic patient's compartment read its charge-proposal Basic (200) and reached the `claims.manage` draft route (200). P6: the existing submit result panel and client mapping were extended; draft warnings already rendered. P7: the three existing warning pins remained unedited and passed; the sole authorized change to `claimDraft.test.ts` kept its exact `deepEqual` search list and added ChargeItemDefinition in the observed running order.

Kickoff §8 rulings were verified at `c61c5883`: the fee snapshot adds an unconditional ChargeItemDefinition search; both audit registries lack `claim.submit.lines-held`; the amount-contract mock supplies no Basic or fee results; provider-only policy permits a patient-compartment DiagnosticReport `final` to `entered-in-error` update. The implementation uses existing `claim.submit.completed` reason for partial holds and `claim.submit.failed` with `Claim/uncreated` and `all-lines-held: <n> lines` for 409. A successfully searched but absent proposal falls through to concept, code and not-gated; a failed identifier-scoped Basic read or malformed named Basic holds that line as unclassified. The fourth STOP corrected the code-system ruling: CPT and HCPCS share the billing-code match, while unrelated systems do not. The fifth STOP narrowed H15 to the money gate: the advisory uses `ProtocolBasicStore.list()` and skips on any list failure, including an unrelated malformed row. `claimAmountContract.test.ts` is unchanged and all six cases pass. No audit registry or AccessPolicy changed.

## Tracked files

- New `mcp/src/claims/interpretation-hold.ts` and `mcp/tests/claimInterpretationHold.test.ts`.
- Changed `mcp/src/claims/claim-draft.ts` and `mcp/src/claims/claimmd-handlers.ts` (submit handler only).
- Changed `mcp/tests/claimDraft.test.ts` (one exact search-list assertion) and appended `mcp/tests/submitClaimsClearinghouse.test.ts`, whose synthetic PHOTO1 fixture now uses the HCPCS system assigned by its fee builder; its assertions are unchanged.
- Changed `ui/src/lib/submit-claims.ts`, `ui/src/scenes/claims/SubmitClaims.tsx`, and appended `ui/tests/submitClaims.test.tsx`.
- This bundle and five synthetic browser images in `docs/build-log/followup-s3c2c2b4-claim-hold/evidence/`, including fresh final-head draft and result screenshots.

No authz, policy, audit registry, sign-gate, slice-3b, schema, index, ledger, deployment, script or CI file was edited. No billing code was added to a production rule; test and live codes were synthetic fee-linked alphanumerics. No new decision or medical code needs a `decisions/INDEX.md` or Mandate 14 ledger entry. PerformanceOD was read-only.

The only other fixture correction was `claimInterpretationHold.test.ts`'s PHOTO1 coding, also aligned with its synthetic fee builder. Its VISIT1 and OCT1/OCT2 codings still use a synthetic non-billing system; VISIT1 has no matching fee, while the OCT cases classify by named proposal or procedure concept rather than billing-code fallback. No other test in this PR relies on a non-billing system matching a fee by code.

## Suites and guard demonstrations

Valid MCP suites and mutations used dedicated `odos-s3c2c2b4-*` PostgreSQL through `ODOS_POSTGRES_URL`, matching CI; `.odos/operator.env` and `.odos/operator-identity.json` were absent. An earlier full-suite attempt with those live operator files present was void and produced nine setup failures; the corrected clean rerun at the prior head passed. The sixth-turn H19–H22 red run lacked the required dedicated Postgres and is void; seventh-turn red→green runs below replace it. No `.odos/` output is tracked.
At prior head `1d079d8a`, the four affected MCP files ran together as `45 tests; 45 pass; 0 fail; exit 0`, and the full UI command was rerun with `1865 tests; 1865 pass; 0 fail; exit 0`.

Full MCP command, from `mcp/`:

```sh
node --import tsx --test --test-concurrency=1 'src/__tests__/**/*.test.ts' 'tests/**/*.test.ts' '../tests/boundaries/**/*.test.ts' '../tests/observation-status-machine/**/*.test.ts' '../tests/setup-wizard/**/*.test.ts' '../tests/preflight/**/*.test.ts' '../tests/smart/**/*.test.ts' '../tests/cds/**/*.test.ts' '../tests/agentops/**/*.test.ts' '../tests/bulk-data/**/*.test.ts' '../tests/mandate-8/**/*.test.ts'
```

| Check | Base `c61c5883` | Prior head `1d079d8a` |
|---|---:|---:|
| Full MCP | 6342 tests; 6287 pass; 0 fail; 55 skipped; exit 0 | 6365 tests; 6310 pass; 0 fail; 55 skipped; exit 0 |
| `npm --prefix ui test` | 1863 tests; 1863 pass; 0 fail; 0 skipped; exit 0 | 1865 tests; 1865 pass; 0 fail; 0 skipped; exit 0 |
| `npm --prefix mcp run build` | — | exit 0 after final source edit |
| `ui/: npx tsc --noEmit --skipLibCheck` | — | exit 0; UI unchanged afterward |
| `npm run typecheck:scripts` | — | exit 0; scripts unchanged afterward |
| `npm run preflight` | — | 0 warnings, 0 hard blocks; exit 0 after final source edit |
| `git diff --check` | — | exit 0 |

The following guard demonstrations were recorded before fixback 2. Entries give `tests/pass/fail/exit`:

The final full MCP run and H16–H18 mutation reruns used a new dedicated `odos-s3c2c2b4-unit-db-r5` container and `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15432/medplum`, with both operator files absent. The three mutations were restored byte-for-byte before handoff. The first local mutation harness invocation had a Python syntax error before it touched source; the corrected harness changed no expected value, product request or product file beyond the reversible mutation.

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
| H14 named proposal absent after successful search | `2/0/2/1` | `2/2/0/0` |
| H15 prior advisory-survival assertion, superseded by the seventh ruling | `1/0/1/1` | `1/1/0/0` |
| H16 failed Basic search holds named line unclassified | `1/0/1/1` | `1/1/0/0` |
| H17 same code under a non-billing system does not match | `1/0/1/1` | `1/1/0/0` |
| H18 same code under the other billing system still holds | `1/0/1/1` | `1/1/0/0` |

H11 used service `2026-09-23T23:30:00-04:00` and an interpretation `2026-09-24T01:00:00Z`; naive UTC-day conversion incorrectly matches, while the literal prefixes differ. H15's earlier advisory-survival assertion was changed by the seventh ruling: valid named lines remain correctly classified despite an unrelated malformed Basic, but the advisory may be absent. H16 failed because the old catch converted a real Basic search failure into an empty successful result; H17 failed with the old code-only comparison; H18 failed under the intermediate strict system comparison. H10 compared Claim.MD and Stedi response, persistence and payload bytes against base fixtures. Submit proofs used **handler-level fake Claim.MD and Stedi adapters only**; no real clearinghouse call occurred. Partial holds created no held ChargeItem and sent no held line; all-held produced 409 with zero clinical resource writes and zero adapter calls, plus the required failure audit.

### Fixback 2, seventh ruling

`loadClaimHoldContext` now calls `ProtocolBasicStore.get(id)` for each distinct proposal identifier on the claim. A missing Basic returns `undefined` and follows H14's concept/code fallback; a failed scoped search or unparseable named Basic marks only that identifier unclassified. The advisory calls `ProtocolBasicStore.list()` through its existing declared search contract and catches any list failure. The three existing `searchParamContract.test.ts` assertions passed unedited; no new direct `fhir.search` call or contract registry entry was added. H15's changed assertion first proves the cross-encounter advisory with healthy data, then adds an unrelated malformed Basic: evidenced named photo and named visit lines still stay on the draft, while the advisory disappears. This is the explicit fifth-STOP ruling, not a waiver of the money gate.

The dedicated `odos-s3c2c2b4-unit-db-r7` Postgres container supplied `ODOS_POSTGRES_URL` for every valid MCP run below; `.odos/operator.env` and `.odos/operator-identity.json` were absent. Each mutation was restored before its green run. Targeted TAP counts are `tests/pass/fail/exit`:

| Guard | Mutation | Red | Restored green |
|---|---|---:|---:|
| H15, H19 | Replace scoped `get(id)` with practice-wide `list()` | `2/0/2/1` | `2/2/0/0` |
| H20 | Remove uppercase normalization of the typed HCPCS `octr1` against synthetic fee `OCTR1` | `1/0/1/1` | `1/1/0/0` |
| H21 | Swallow a corrupted named Basic parse error instead of marking that identifier failed | `1/0/1/1` | `1/1/0/0` |
| H22 | Let a failed advisory list throw out of draft assembly | `1/0/1/1` | `1/1/0/0` |

H19 used a real `FhirSearchLimitError` for an unscoped Basic list and proved a named visit line and an evidenced named imaging line both stay. H22 has a positive control: an evidenced same-day OCT/photo pair yields the advisory with a healthy list; after the list search throws, the same draft still keeps both charges and has no advisory. H1–H18 remained green in the focused and full suites, including the exact `claimDraft.test.ts` search pin and all six unedited `claimAmountContract.test.ts` cases. The earlier sixth-turn H19–H22 red run is void under rule 13 and is not used as proof.

Final-source checks:

| Check | Result |
|---|---|
| Focused claim, amount, and static search-contract files | `43 tests; 43 pass; 0 fail; exit 0` |
| Full MCP, direct `node --import tsx --test --test-concurrency=1` with the file patterns above and dedicated Postgres | `6369 tests; 6314 pass; 0 fail; 55 skipped; exit 0` |
| `npm --prefix ui test` | `1865 tests; 1865 pass; 0 fail; 0 skipped; exit 0` |
| MCP, UI, scripts typechecks | all three exited 0 |
| Isolated `npm run preflight` | 48 read resource types and 956 operations covered; 0 warnings, 0 hard blocks; exit 0 |
| `git diff --check` | exit 0 |

The MCP wrapper's immediately preceding run executed the same 6369 tests with 6314 pass, 0 fail and 55 skips, but exited 1 because it correctly flags 47 live authorization/integration skips as ungated; it is not reported as a green wrapper. The direct full-suite run above exited 0 with the same test counts, and does not claim live authorization proof. A concurrent preflight run briefly saw the MCP test's temporary RiskAssessment probe and failed; the test removed that probe, and the isolated rerun above passed without a source or policy edit.

## Live and browser proof

The prior head `1d079d8a`'s dedicated fresh stack used `http://localhost:18103/` byte-identically as the server `baseUrl` and every lane's `MEDPLUM_BASE_URL`. Healthcheck passed on **attempt 10/90**, polling every 2 seconds. In required order: smoke `12/12 pass, 0 fail, 0 skipped`; integration `218/218 pass, 0 fail, 0 skipped`; role repair with `GITHUB_ACTIONS=true` only on that command created 3 policies; sync matched provider, staff, admin and composite with 0 updates; authorization `78/78 pass, 0 fail, 0 skipped`. All exited 0.

The fixture created a synthetic fee first, then a signed visit, finalized proposal, fundus ChargeItem, completed Media, final DiagnosticReport, coverage and ordinary visit line. A malformed unrelated proposal Basic was then stored; the staff caller still listed the valid named proposal. The **human composite** caller's served draft returned 200 with the imaging line kept and no hold warning. For the same report version, `If-Match` and retraction payload, the composite raw FHIR update returned **403**, leaving the report final; the **human provider-only** caller (one provider AccessPolicy, patient compartment bound to the synthetic patient) returned **200** and set it to `entered-in-error`. This paired control isolates the 403 to caller role composition, consistent with kickoff §8. The composite then read the served draft (200): fundus line excluded, ordinary visit line kept, exact warning `Synthetic fundus photograph was held: it needs an interpretation and report on this visit.` The single-role human staff caller also read the proposal Basic and the after-retraction draft (both 200), with the same hold warning.

Browser proof at the prior head used the served Vite/claims route and synthetic composite human session, loaded the encounter and displayed the warning with zero page errors. The original author run's detached read-only base `c61c5883` server loaded its same already-retracted encounter: two charges, no warning, zero page errors. `evidence/draft-before.png` and `evidence/draft-after.png` remain matching 1152×212 scoped browser captures from that identical synthetic encounter. The fixback fresh stack supplied `evidence/draft-after-fixback.png` (1152×212) and `evidence/result-fixback.png` (1500×980); both were visually checked for synthetic-only content and zero page errors. The result images show the production component populated by a **synthetic handler-level fake-adapter response**, not a real clearinghouse result. The seventh-turn change affects only the scoped proposal read, typed-code comparison, corrupted-proposal classification and advisory failure behavior; it adds no route, authorization, submit, or UI behavior beyond those requested fixes, so live lanes and screenshots were not rerun under the sixth-turn conditional instruction. The prior-head live and browser evidence is identified as such, not as final-head proof.

Harness-only corrections across author and fixback runs: this host required `docker-compose`; one operator login returned a transient 400 before an identical retry succeeded; initial role selection matched two policies until the exact single-role tag was chosen; a client-credentials staff principal could read Basic but received 401 at the human claims route, so single-role human staff was invited and verified; the initial MCP runtime service lacked membership read, so a separate disposable project-admin runtime service fixed startup. Earlier the MCP server's first start omitted the signing-key path. On the fixback stack, the first operator-identity call omitted the dedicated Postgres URL, and the first browser script call omitted `--import tsx`. These were corrected in the ignored harness without changing product requests or expected values.

Not in this slice: Stedi resubmission; unmatched hand-typed imaging codes; per-concept precision; modifiers; cross-panel refresh; staff Follow-up Accept 502. Named proposal reads are identifier-scoped. A corrupt proposal Basic anywhere in the practice can silence the practice-wide same-day pair advisory because `ProtocolBasicStore.list()` parses all rows; that advisory never gates money. A named proposal that is absent still falls through to the live fee. Retired fees continue to enforce interpretation requirements under X1. Real clearinghouse behavior is untested by design. Independent evaluation, bot reviews at final head, merge and deployment are follow-ups. The task Postgres container was stopped; final `docker ps` showed only the untouched `vf-prac1b-walk-db` container.

needs-review
