# PR #620 — adjudicated CodeRabbit fixback

NOT EVALUATED. HELD OPEN. Never merge. Independent evaluator: Claude Opus.

Coded-by: Codex — GPT-6 Astra, high effort

## Changes and proof

The protocol cache now lasts only until the first write attempt. Subsequent validation and rollback reload the projection and Encounter, including after an uncertain write response. W108 is unchanged. Removing the forward cache fails the one-load test; caching rollback fails W108. Both restored checks pass.

The remaining adjudicated changes preserve completed command responses when the diagnostic closure read fails, scope priors searches and count unscoped records, limit completeness evidence to candidate encounters with concurrency four, preserve inactive-unapply no-ops, return the specified panel error, and repair census/usage/copying/live-test cleanup behavior. No UI, policy, authentication, or lifecycle builder changes.

[25 source/test/script files](current-files-touched.json); [source hashes](current-source-sha256.json). [All 21 mutation pairs and exact test names/counts](red-green.md), [machine results](mutation-results.json). Every mutant exited 1; restored tests exited 0. Anchor misses are loud and never counted as proof. Focused and full suites overlap.

[Assertion audit](assertion-audit.json): 13 files, 1,037 retained assertions, 32 removed/changed, 54 added/changed, zero unmapped. [Removed-test ledger](deleted-assertion-ledger.json), [explicit semantic changes](ruling-semantic-assertions.json). Ten misleading duplicate pre-rebuild refusal tests were removed under the ruling; one accurate refusal test and named canonical write coverage remain. F1's unscoped refusal was explicitly superseded; foreign-subject refusal remains.

## Local verification

Full non-live commands use an allowlisted OS environment, only the disposable PostgreSQL URL and ODOS_REAL_WEASYPRINT_TEST=1; no MEDPLUM_PROJECT_ID, disposable credentials or root .odos/operator.env leak. PostgreSQL 16-alpine runs on loopback29142. CI separately provisions pinned Medplum5.1.30-9b1bd92 at localhost18103.

Full UI: 1,685 tests, 1,673 pass, exactly8 carried failures, 0skip,4existingTODO. Both builds exit0. Preflight completes including lint with 0warnings/0hardblocks. Diff check exit0. Release checker:16MCPgreen,9UIopen, expected exit1; only UI diagnostics. [Full logs](review-full-ui.txt).

An intermediate MCP run had two exact warm-query fixture counts reflecting the removed redundant pre-write load; both were updated under W82/W108 and mutation-proven. A later unchanged communications G6 test received an HTML response instead of JSON; its isolated file passed106/106. Both failed runs are preserved, and the latter is not claimed base-proven environmental. The known WeasyPrint69 ENOENT has an exact base reproduction:5,687tests,5,618pass,1samefailure,52skip,16TODO. Hosted CI installs WeasyPrint69.

[T22 registry/census](registry-check.json):97sites,30mapped,67explicit exclusions,27required registry paths,0failures, including Binary JSON Patch. Earlier capability gates, premise verification, F1–F5 proofs and64 required W-row mutation history remain in the parent bundles; G-h retains rev2.5 field-preservation grading only.

## Risks and follow-ups

- Exactly8 UI failures remain for A3.2; nine UI release slots intentionally open. See the parent ruling bundle for every test name and per-test proof.
- MCP attest/amend/append write no Provenance under a project-scoped identity (Medplum canSetId = super admin) — pre-existing, separate slice.
- Inherited fhir-search outcome handling is outside A3.1; reproduce against Medplum before the release merge.
- The observed unrelated intermittent communications HTTP failure remains disclosed; no assertion was weakened.
- No new medical codes, FHIR URLs or design decisions; no Mandate14 ledger additions required.

Upstream refreshed:main c742b2e4b543e0706b24f66aec6883a82f0d18a3; A2b2 1706d7c8417b04791471d4332b4ecd712883bf11. Neither moved; no rebase.

## Fresh CI-built live lane

Compose project `odos-r10-a3-1-review`, fresh volumes, subnet10.249.146.0/24, localhost18103; same pinned server and CI bootstrap/repair/sync order. Bootstrap12/12, integration218/218, authorization73/73; zero skipped/TODO. [Raw authorization](../review-live-authz.txt), [structured live rows](live-results.json).

Active synthetic project `ab8f8e50-c843-4995-b233-0324493c4039`. Provisioning login `r10-a3-ci-admin@example.invalid`, principal `Practitioner/76f0ddda-2cfd-4bed-b341-cab51425768a`. New service `ClientApplication/820950af-3ae8-4080-b681-2014c62e79bf`: distinct principal, membership admin=true, access=[], legacy accessPolicy absent, superAdmin=false, active project matches. Real MCP amendment PATCH200, final→amended, protected identifier/components/extensions byte-identical. Provenance404/readback404 recorded as the known defect, not a required outcome. Mismatched session and pre-rebuild refusals attempted/persisted zero writes. Generic shared-body/append and audit rows pass. Cleanup removed membership200; ClientApplication deletion403 recorded and retained only in disposable storage.

The already-repaired previous stack refused the initial bootstrap Patient create403. A fresh stack's first registration attempt hit external password-check fetch failure; public endpoint connectivity subsequently returned200 and an unchanged retry passed. Both setup attempts are preserved; no security setting was bypassed.

## Final local MCP confirmation

[Full command](review-full-mcp-confirmation.txt): **6,000 tests, 5,946 pass, 1 base-reproduced WeasyPrint ENOENT failure, 53 skip, 0 TODO**. The unchanged communications test passed in this full confirmation. No non-live source or assertion changed after the intermittent failure.

## Publication status

Local fixback complete; hosted CI and bot review pending the commit containing this bundle. Exact final head, CI counts, review dispositions and container stop list will be recorded in the PR and final handoff after those external checks finish. NOT EVALUATED; HELD OPEN.

## Final CodeRabbit type correction

CodeRabbit completed review5235939476 at54badebf with one outside-diff minor finding: the applied DiagnosisPickResponse omitted the closure marker already returned at runtime. Added `encounterClosedDuringCommand?: true` to that member only. [Compiler test and emission proof](type-contract-proof.json): removing the field fails with the missing-property diagnostic; restoring passes1/1; emitted JavaScript is byte-identical. This is mutation pair22; no existing assertion changed.

Repeated full MCP:6,000tests,5,946pass,1base-reproducedWeasyPrintENOENT,53skip,0TODO. Repeated full UI:1,685tests,1,673pass,the same8carriedfailures,0skip,4TODO. Both builds and preflight complete exit0; checker remains16MCPgreen/9UIopen (expectedexit1). Logs are the `review-type-*` files beside this bundle. Full/isolated/mutation counts overlap.

Hosted CI at the preceding54badebf: [MCP job](https://github.com/drbang-iva/ODOS2020/actions/runs/35222646153/job/105207130929) succeeded:6,000tests,5,947pass,0fail,53skip,0TODO; bootstrap12/12,integration218/218,authz73/73. [UI job](https://github.com/drbang-iva/ODOS2020/actions/runs/35222646153/job/105207130918) had exactly8approvedfailures. This hosted result belongs to54badebf; the final type-correction head will have separate hosted evidence in the PR/final handoff.

Final type-correction live authorization rerun: **73tests,73pass,0fail,0skip,0TODO**. [Raw](../review-type-live-authz.txt), [latest identity and resource rows](type-live-results.json). Same CI-built synthetic project and bootstrap; newly provisioned service identity for this run.
