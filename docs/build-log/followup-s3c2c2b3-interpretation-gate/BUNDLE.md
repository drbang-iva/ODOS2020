# S3c-2c-2b-3 — interpretation billing gate

Status: **needs-review** after R4 fixback. Claude Opus 5.5's evaluation at `f6ab14a9c9a2984ab4941f336653f5cb544be683` was **NEEDS-WORK (tests only)**; the fixback head requires independent re-evaluation.

## Summary

The first gate refuses an accepted imaging charge before any sign-cleanup write unless a counting interpretation/report exists. R1 is honored: virtual seeded fees supply their seed answer; only an undefined non-seeded concept is missing. The gate, locked abandonment, and billing re-check run in one encounter lock; the protocol accept flip uses its own acquisition. Under R3, a race-only refusal at the billing re-check may follow abandonment, but writes no ChargeItem or recall. The UI shows the 409 sentence. G1–G13 went red under their specified mutations and green when restored; R4 adds G14–G17 after the first independent evaluation found five surviving mutations. The fixback changes tests only. Earlier clean credentialed live lanes and R2's no-charge control remain the live evidence; no live lane was rerun for the test-only fixback. Provider-only browser signing and a finished Encounter after release remain unproven. No merge was attempted.

## Branch and files

- Branch: `drbang-iva/followup-s3c2c2b3-interpretation-gate`; base `origin/main` `b817b123a667a9fd782c78a48865029f4709922a`; [PR #659](https://github.com/drbang-iva/ODOS2020/pull/659). Final fixback head SHA is reported in the handoff.
- Product: `mcp/src/clinical-graph/interpretation-gate.ts`, `follow-up-queue-endpoint.ts`, `protocol-endpoint.ts`, `protocol-service.ts`, `procedure-fee-schedule.ts`, `ui/src/components/charting/EncounterHeader.tsx`.
- Tests: `mcp/tests/interpretationGate.test.ts`, `followUpResults.test.ts`, `procedureChargeMaterialization.test.ts`, `mcp/src/__tests__/procedure-charges.test.ts`, `ui/tests/encounterSignRefusal.test.tsx`.
- R4 fixback changed only `mcp/tests/interpretationGate.test.ts` and this bundle; no product file changed.
- Evidence: this bundle and four synthetic Chromium screenshots in `evidence/`. No `.odos/` file is tracked.
- No terminology, billing code, fee seed, orderable, or concept changed in source; Mandate 14 ledger rows: none. No companion decision/INDEX edit; `performance-od` read only. Open PRs #647/#626 had no allowed-file overlap.
- No `mcp/src/index.ts`, authz/policy, imaging endpoint, route, script, CI, or `executeTransaction` edit. `ui/tests/clinicalGraphRouting.test.tsx` stays at 8 tests and its 59-caller assertion.

## P1–P8, rechecked at the base head

| Premise | Re-verification |
| --- | --- |
| P1 | `clinical.sign` preceded abandon, materialization, then annual recall; handler had no lock. Confirmed. |
| P2 | Promise-tail encounter lock is non-reentrant; locked abandon is safe inside it. Confirmed. |
| P3 | Staged-to-accepted snapshot loop was outside the commit lock. Confirmed. |
| P4 | Materializer validated accepted proposals before fee ensure/write and had one production caller. Confirmed. |
| P5 | Snapshot answers, live fee list, and seed mappings confirmed; R1 clarifies virtual seeded rows. |
| P6 | Final/amended/corrected, nonblank report predicate and live-order fields confirmed. |
| P7 | UI already stopped before finish transaction for non-OK cleanup. Confirmed. |
| P8 | Two signing fixtures accepted uninterpreted imaging: five-proposal glaucoma and three-procedure behavioral acceptance. Both received only grant-1 fixture data. The unrelated gonioscopy corrupt-application test remains unchanged and passes. |

Source-parsing tests were read before edits. Sign-cleanup base status map: 400 invalid input, 401 unauthenticated, 403 lacking `clinical.sign`, 200 success; other errors propagated. The new refusal is a structured 409.

## G1–G13 mutation proof

Each line quotes the mutation-run summary: named guard test failed after the temporary break, then passed after restoration. G3 and G10 initially had invalid proof-harness anchors; those ignored-harness corrections changed no expected value, request, product file, or guard semantics.

| Guard / break | Red output | Green output |
| --- | --- | --- |
| G1 skip first gate | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G2 only proposal-linked order | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G3 count preliminary | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G4 ignore unordered image type | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G5 snapshot only | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G5 live only | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G6 treat unanswered as not-required | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G7 drop duplicate check | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G8 gate non-imaging | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G9 omit billing `beforeWrite` | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G10 nested public abandon | tests=1 pass=0 fail=1 (2 s deadline) | tests=1 pass=1 fail=0 |
| G10 flip outside lock | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G11 gate/display disagree | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G12 continue after 409 | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G13 every unpersisted concept missing | tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |

G13 green explicitly proves virtual gonioscopy passes as `not-required`, virtual fundus photography refuses for missing interpretation rather than `unclassified-fee`, and a missing non-seeded key refuses `unclassified-fee`. G8 green compares unchanged non-imaging ChargeItems field for field to the base fixture.

## R4 G14–G17 fixback mutation proof

The independent evaluation at `f6ab14a9` found five surviving mutations. Each new test now fails under its exact temporary product break and passes after byte-for-byte restoration; no product break is delivered.

| Guard / temporary break | Red output | Green output |
| --- | --- | --- |
| G14 remove `beforeWrite: gate` from the real sign handler | `200 !== 409`; tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G15 drop concept-key filter from order selection | actual `[]` vs expected `needs-interpretation`; tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G16a count `preliminary` in the gate's unordered report filter | actual `[]` vs expected `no-interpreted-result`; tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G16b ignore the gate's nonblank-conclusion check | actual `[]` vs expected `no-interpreted-result`; tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |
| G17 count removed orders | actual `[]` vs expected `needs-interpretation`; tests=1 pass=0 fail=1 | tests=1 pass=1 fail=0 |

G14 calls `handleProtocolSignCleanupRequest` with a charge list that reveals an accepted uninterpreted fundus proposal only when the materializer reads its own list. The handler returns `409 interpretation-required` with the fundus proposal in `tests`; no ChargeItem or annual-recall ServiceRequest is created. G15–G17 use literal fixtures against the production gate. Focused run after restoration: **85/85 passed, 0 failed, 0 skipped**.

## Grant-1 instances, before and after

1. `mcp/tests/procedureChargeMaterialization.test.ts` five-proposal glaucoma sign fixture: before, accepted fundus/visual-field charges had no interpreted result; after, completed order-linked Media and final nonblank DiagnosticReports were added before sign. Assertions unchanged.
2. `mcp/src/__tests__/procedure-charges.test.ts` behavioral acceptance fixture: before, accepted fundus and visual-field charges had no interpreted result; after, completed visit Media of each type and final nonblank reports were added before sign. Assertions unchanged.
3. `mcp/tests/procedureChargeMaterialization.test.ts:381`, corrupt accepted proposal: no fixture or assertion change. Virtual seeded gonioscopy passes the gate, then the corrupt-application error remains first; focused run: **`ok 198`**.

## Checks and live lanes

- `node --import tsx --test tests/interpretationGate.test.ts`: 8/8. Four focused MCP files: 200/200, including `ok 198`. Follow-up results: 27/27. UI sign refusal: 2/2.
- R4 restored focused MCP run (`interpretationGate`, `procedureChargeMaterialization`, `procedure-charges`, `followUpResults`): **85/85 passed, 0 failed, 0 skipped**. Focused UI sign refusal: **2/2**. Three typechecks (`npm run typecheck:scripts`, MCP/UI `npx tsc --noEmit`) exited 0; `npm run preflight` exited 0 with **0 warnings, 0 hard blocks**. Dedicated Postgres container `odos-s3c2c2b3-fixback-pg` was healthy; `.odos/operator.env` and `.odos/operator-identity.json` were moved aside before every MCP suite run.
- R4 full MCP run selected **441 test files** with `rg --files` over the CI roots and ran `node --import tsx --test --test-concurrency=1`: **6329 tests, 6274 pass, 0 fail, 55 skipped**, exit 0. The 55 credentialed live skips are not called live proof; R4 required no live rerun. An initial macOS `/bin/bash` attempt could not enable the Linux CI `globstar` option and selected only a partial set (**6011 tests, 5956 pass, 55 skipped**); it was excluded from the full-suite claim and replaced by the explicit 441-file run. Full UI `npm test`: **1859 tests, 1859 pass, 0 fail, 0 skipped**, exit 0. `git diff --check`: exit 0. All task-owned fixback Postgres resources were stopped; ignored operator files were restored.
- Full MCP CI glob with `ODOS_POSTGRES_URL` pointed at dedicated `odos-s3c2c2b3-pg`: **6324 tests, 6269 pass, 0 fail, 55 skipped**. Base count 6315, +9 (eight new tests, one appended matrix). Live-dependent skips were exercised separately. `.odos/operator.env` and `.odos/operator-identity.json` were absent for unit/full suites and generated afterward.
- Full UI `npm test`: **1859 tests, 1859 pass, 0 fail, 0 skipped**; base 1857, +2. Root `npm run typecheck:scripts`, MCP/UI `npx tsc --noEmit`, and `npm run preflight` all exited 0. Preflight: `FHIR read grant check PASS`, 48 marked/literal resource types, 951 operations. `node mcp/scripts/check-r10-a3-release.mjs`: T1–T22 pass. `git diff --check`: exit 0.
- First fresh 18103 stack healthcheck: ready attempt 10 of 2 s loop (90 maximum); `MEDPLUM_BASE_URL=http://localhost:18103/` matched server config byte-for-byte. Credentialed bootstrap **12/12**, integration **218/218**, no skips; then operator identity, role repair (`GITHUB_ACTIONS=true` only there), policy sync (`Policies updated: 0; Memberships updated: 0`), authorization **78/78**, no skips.
- The task-owned browser stack was later rebuilt and healthcheck again passed at attempt 10. A repeated integration run met a stale derived operator file for the previous disposable project, so it was interrupted; ignored operator files were moved aside and identity/role repair/policy sync redone. The earlier clean 12+218+78 is the full live-lane result; the interrupted repeat is not called green. Earlier setup-contaminated attempts are likewise not counted green.
- **R2 fresh-stack control at task head `958ee36599d6661448e1ec51100200a88ee187d8`:** healthcheck ready on attempt 11 of the 2 s / 90-attempt gate; same `MEDPLUM_BASE_URL=http://localhost:18103/` as server config. Bootstrap **12/12**, integration **218/218**, role repair and policy sync (`Policies updated: 0; Memberships updated: 0`), authorization **78/78**, all with zero failures/skips. Operator files from the prior disposable project were moved aside before the run. Browser control then used the same multi-role `contract-admin` staff-profile login as the earlier gate walkthrough.

## Chromium and Medplum readbacks

All captures show a synthetic patient. The usable browser session was a staff-profile login with provider, staff, and admin roles. The constrained provider ClientApplication passed `/auth/me`, but MCP required a staff profile; a disposable provider-only human user could not be completed because Medplum's superadmin password-set endpoint returned 403. No credential/token appears here or in the screenshots.

- **Ordered fundus refusal.** A coded `fundus-photography` Visit-charges proposal was accepted; a live retina ServiceRequest/plan action and completed fundus Media linked to that order were persisted. The manual-imaging upload endpoint returned `403 upload-not-permitted` for this local staff identity, so Media was persisted by the privileged fixture seeder. Chromium clicked **Sign & finish**; cleanup returned `409 interpretation-required` and displayed *“Fundus photography needs an interpretation and report before this visit can be signed (or remove its charge).”* [Screenshot](evidence/desktop-refusal.png). Seeder readback: `Encounter=in-progress`, `ChargeItem=0`, proposal `accepted`, action `selected`, protocol applications `[]` (none abandoned).
- **Release attempt.** A final DiagnosticReport with nonblank conclusion and order/Media links was persisted by the fixture seeder. Chromium clicked **Sign & finish**. Cleanup released and wrote **one** fundus ChargeItem; the subsequent Encounter finish transaction returned `entry 0: 403 Forbidden` in the UI. [Finish-blocker screenshot](evidence/desktop-finish-403.png). Readback: `Encounter=in-progress`, `ChargeItem=1`, proposal `finalized`, action `selected`. This is **not** a passing sign. The Follow-up **Add interpretation** row action could not be used because an explicit exam-scope write returned 403 (`outside the caller's patient compartment`); the report was seeded directly.
- **Custom OCT refusal.** A non-seeded coded fee was created at runtime with interpretation `oct`; a Visit-charges proposal was accepted with no OCT result/order. Chromium clicked **Sign & finish**, got `409 interpretation-required`, and displayed *“Synthetic OCT browser proof was charged but has no interpreted result on this visit.”* [Screenshot](evidence/desktop-oct-refusal.png). Readback: `Encounter=in-progress`, `ChargeItem=0`, proposal `accepted`.
- **R2 no-charge distinguishing control.** On the fresh stack, the same multi-role staff-profile browser identity clicked **Sign & finish** on a separate synthetic visit with **zero charge proposals and no imaging**. Sign-cleanup response: **HTTP 200**, `abandoned=0`, `materialized=0`, `finalized=0`. Finish transaction response: **HTTP 200 Bundle** with entry statuses **`403`, `201`**; UI displayed `entry 0: 403 Forbidden`. [Control screenshot](evidence/desktop-r2-no-charge-control.png). Privileged Medplum readback: `Encounter=in-progress`, `ChargeItem=0`, proposal list `[]`, action list `[]`, application list `[]`. The finish 403 reproduces without any gate-relevant charge; under R2 it is attributed to this synthetic identity, not the interpretation gate.

The provider-only browser journey and a finished Encounter after release remain unproven for identity-tooling reasons: a provider-only human user could not be created because password-set returned 403. Release **was** proven at sign cleanup: one ChargeItem and proposal `finalized`; the Encounter stayed in progress because the finish transaction returned 403. Media and report were seeded by the privileged fixture seeder because the Binary upload path returned 403. Slice 1 separately proved **Add interpretation** live. No grant authorized an authz/policy or imaging-endpoint change in this slice, so none was made. Medplum intermittently returned 429 during the earlier browser proof; those attempts were excluded and fresh-window reruns produced the quoted 409s.

## Risks, follow-ups, and boundary

R3 adjudicated CodeRabbit's late-refusal finding: only the first refusal is zero-write; a changed report or image outside the lock can make the billing re-check refuse after abandonment, but before ChargeItem or recall writes. This race-only limit is accepted and is not a product-code fixback. The evaluator will adjudicate the CodeRabbit thread; the coder has not replied to or resolved it. Claude Opus 5.5's first verdict was **NEEDS-WORK (tests only)**; the final fixback head needs independent re-evaluation before merge. Post-deploy proof belongs to the operator: the first real Sign on Iris of a visit with an interpreted imaging charge must finish and produce one ChargeItem, recorded later.

Outside this slice and not done: R-d same-day warning (slice 3b); Q7 claim path (raw ChargeItems, hand-added claim lines, report retraction after signing); TC / 26 and modifiers; report retraction or image unlink between gate read and ChargeItem write; staged protocol charges; step-2 failure after successful cleanup.

All task-owned MCP/UI/proxy processes and `odos-s3c2c2b3-*` Docker stacks, including R2 and fixback Postgres, were stopped; task-owned disposable containers/volumes were removed. Port listeners 3333, 15120, and 8103: none. Final `docker ps --format '{{.Names}}\t{{.Status}}'`:

```text
vf-prac1b-walk-db    Up 3 days
```

needs-review
