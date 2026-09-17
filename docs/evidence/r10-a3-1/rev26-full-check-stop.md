# R10 A3.1 — rev 2.6 sealed continuation bundle

**BLOCKED pending the two-entry carry extension registry scope approval. NOT EVALUATED. HELD OPEN.**

Coded-by: Codex — GPT-6 Astra, high effort

## Remaining blocker and concrete proposed change

The nine authorized preflight inventory anchors are repaired. Preflight now runs through `preflight-lint` and reports exactly **two hard blocks**, both because `carry-plan` and `carry-versions` are absent from `data/canonical-extensions/registry.json`. The check named `odos-extension-url-shape` checks registry membership, not spelling. The URLs already have the repository's canonical shape. Renaming or obscuring them would evade that check.

That registry file remains outside rev2.6 §4. The pending scope question asks permission for **only those two registry entries**, with no changes to the check. [Exact proposed patch](rev26/proposed-carry-registry.patch), [hard blocks](rev26/preflight-hard-blocks.json), [full preflight output](rev26/full-checks/preflight-unregistered.txt). The patch is reviewable but **not applied**. No PR is opened while this A3.1-owned failure remains.

## Summary and files

Reconciled the full-check failures under rev2.6 rather than loosening their assertions. Added real open Encounter fixtures for protocol operations; preserved invalid-Condition400 and unscoped-capture201 behavior by correcting protocol validation order and capture projection scope. Kept original protocol workload budgets while separately asserting exact added finding-guard searches. Reconciled historical identity/history/parity fixtures with shared-record behavior while preserving original legacy captures and five divergence pins. Added the exact carry search-contract specification. No UI, roles/policies, service authentication, scribeAttestation builder, seed, or project-feature edits.

[Complete file inventory](files-touched.txt), [content SHA256 seal](file-sha256.json), [exact assertion audit](assertion-audit/REPORT.md). All implementation/test changes remain within §4 and its rev2.6 addition. The registry proposal is evidence only.

Only line anchors changed in `scripts/fhir-read-grant-check.ts`: VisionPrescription3251→3269; AllergyIntolerance3633→3651; CareTeam3687→3706; DeviceDefinition3836→3855; ConceptMap3864→3883; Substance3887→3906; AdverseEvent4217→4240; BodyStructure5318→5345; AccessPolicy7895→7923. [Machine-checked delta](rev26/inventory-anchor-updates.json) confirms9 existing entries changed,0 added/removed, and every other byte equal after normalizing those line fields; call/resource/interaction/reason unchanged.

Branch `drbang-iva/r10-a3-1`, worktree `/Users/ericr.bang/GitHub/ODOS2020/.worktrees/r10-a3-1`. HEAD/base remains `1706d7c8417b04791471d4332b4ecd712883bf11`; implementation and evidence are preserved uncommitted. Origin/main `c742b2e4b543e0706b24f66aec6883a82f0d18a3` and origin/drbang-iva/r10-a2b2/base unchanged at ref refresh; no rebase. **PR number/head: not created. No commit, push, merge, bot verdict or independent evaluation.**

## Capability gates and premises retained

No G-e–G-h reruns. [Rev2.5 grading](rev25-gate-adjudication.md), [raw gates](gate-http.json), [results](gate-results.json), [runtime](runtime.json), [principals/policies](principals.json), [P1–P26 verification](premises/). Medplum5.1.30-9b1bd92, runtimev24.18.1, image SHA256358ab425b29390067b6cb82bfbaeee48580a703f7cc5b730bed2b2ba7184c1de.

G-e/G-f retained PASS. G-g retains the original no-op/finished-Encounter staff403 setup and corrected fresh in-progress provider-only stale412 PASS. G-h retains every provider/scoped-admin/super-admin/project-mismatch run, but **the super-admin200/200 is not accepted evidence**. Accepted G-h proof is JSON Patch field preservation only. P1–P26 were behaviorally verified before implementation at the base with no moved premise.

Provider login `r10-a3-1-provider@example.invalid`, policy95fa2233-96b0-49df-850b-f34981c88326; staff login `r10-a3-1-staff@example.invalid`, policy2a64dbb9-ffea-4cbe-9647-b0713f422913. Earlier raw runs and sealed stop bundles remain intact.

## Current §7 proof

**Full live-authz73/73,0skip/TODO**, including A3's4/4. [Fresh38 operation rows](rev26/live-results.json), [full lane](rev26/full-checks/live-authz.txt). Staff16/provider16/service6 rows are not additional tests. Each includes identity, active/target project, resource, before→after, policy and blocking lane metadata.

Real MCP password fallback uses synthetic project admin `r10-a3-1-live-admin@example.invalid`, Practitioner/3bd8ef2d-cf96-463b-baa7-bbb3e24e7c23. Active project is asserted equal to14e0ec2a-cc7f-4ce6-be82-49d9417f3e95, membership admin=true, superAdmin=false. Session clinician is the current synthetic provider. Closed canonical amendment records PATCH200, final→amended, changed version and byte-identical identifier/every component/every extension. Provenance PUT404/readback404 is recorded, not required or represented as success. Mismatching practitioner and pre-rebuild amendment refuse with zero writes. Generic-create/append refusals and audit mismatch execute. Generic create's public-schema refusal and staff pull403 are explicitly distinguished from downstream guard/provider closed409 proof.

## Assertions and red/green guards

Expanded audit covers26 changed test/fixture source files: **2950 original assertions=2562 retained+388 mapped**, including one explicitly recorded removal of obsolete legacy-save200. **0 gaps,0 invalid ledger anchors**. [Before/after mappings](assertion-audit/result.json), [fresh verification](rev26/assertion-verification.txt). The old rev2.5 audit is preserved under assertion-audit/rev25. Every changed/removed assertion maps to a V/W row; no new skip/TODO or loosened clinical assertion was introduced.

Original **64/64 required W rows,128 red/green pairs** remain indexed in [coverage](guard-coverage.json) and [raw index](guard-log-index.json). Rev2.6 adds14 recorded behavioral mutation pairs:4 reader/identity/history/overview,4 premise replay,2 protocol search budgets,4 source/inventory/search-contract guards. [Reader](rev26-reader-proof/), [premise replay](rev26-premise-replay/), [protocol](rev26-protocol-proof/), [source results](rev26/source-mutation-results.json). Unique-anchor failures are loud; mutated production files restore byte-for-byte. These are overlapping tests, not additive independent case counts.

Focused reconciliations: reader/history/parity250/250 (before201pass/49fail); protocol156/156 (before113pass/43fail); premise replay preserves17 probes and17 E comparisons; search contract5/5; fixture evidence scanner1/1. Raw proof logs were moved from directory names containing `fixtures` to `proof` because the fixture scanner mistook numeric runs inside hashes for identities; raw log bytes were preserved and the scanner was not changed.

## T22 and release checker

Fresh release suite **16/16**,0skip/TODO: [output](rev26/release-green.txt). Census remains **27 semantic paths,97 call sites across43 files,30 mapped,67 reasoned exclusions**, including both Binary JSON Patch entries. [Full census](release/census-output.json), registry/exclusions in mcp/tests/fixtures/r10. T22's13 endpoint/3 protocol/11 MCP helper IDs are one test, not27tests. Endpoint33attempt/33persisted; protocol5/5commit,3/3unapply,1/1compensation restore; MCP34attempt/34persisted,15Observationversions,63zero-write controls,6builder variants,5transport checks. Four decoded patch projections are not extra writes. Static census does not claim arbitrary alias/dataflow proof.

[Fresh release checker](rev26/full-checks/release-checker.txt) exits1 only for9 UI slots: T4–6,T15–18,T21,T22. All16MCPslots green. This is not a release PASS.

## Full commands, environment and base comparison

[Environment and PostgreSQL setup](rev26/environment.md): non-live tests have only allowlisted OS variables plus CI's ODOS_POSTGRES_URL and ODOS_REAL_WEASYPRINT_TEST=1. No MEDPLUM_PROJECT_ID, credentials or derived operator environment leaks into them. Own PostgreSQL16-alpine, loopback29132, databaseodos_a3_test; own Medplum5.1.30 loopback29131 and network10.249.142.0/24. Credentialed lanes use the CI bootstrap sequence and explicit synthetic role/seeder environment separately. No shared/deployed database. Dependencies installed in all three task/base packages; no probe files added under UI or MCP test discovery. The missing WeasyPrint69 package install attempt is retained.

| Command | Actual result |
|---|---|
| Task `npm --prefix mcp test` |5979tests:5924pass,2fail,53skip,0TODO; exit1 |
| Base same MCP command/environment |5687tests:5618pass,1fail,52skip,16existingTODO; exit1 |
| Task `npm --prefix ui test` |1685tests:1673pass,8expectedfail,0skip,4existingTODO; exit1 |
| Task `npm --prefix mcp run test:live-authz` |73/73,0skip/TODO; exit0 |
| Base same live-authz command/environment |69/69,0skip/TODO; exit0 |
| Task/base `npm --prefix mcp run test:live-integration` |Each: bootstrap12/12, then218tests/212pass/6fail; aggregate230tests/224pass/6fail,0skip/TODO; exit1 |
| MCP build after type-only fixture repairs |exit0 |
| UI build |exit0; large-chunk warning |
| `npm run preflight` |ran through preflight-lint:0warnings,2hardblocks for unregistered carry URLs; exit1 |
| Release checker |exit1 for9openUIslots only;16MCPslots green |
| `git diff --check` |exit0 |

[Raw outputs](rev26/full-checks/), [exact base-comparison pairs](rev26/full-checks/base-comparison.json). The MCP package wrapper also reports live tests absent and returns1 for live skips; CI's direct Node step has the same tests/environment but live lanes run separately. No ODOS_ALLOW_UNGATED_MCP opt-out was used. These existing live skips are shown honestly, not claimed as passes. Full commands and focused/mutation suites overlap; do not sum their counts.

Only the WeasyPrint failure is treated as environmental in the non-live suite: **both base and task fail the same named test with `WeasyPrint render failed: spawn weasyprint ENOENT`**. The preflight canonical-shape failure is A3.1-owned and remains the blocker. The additional earlier fixture-scanner failure is fixed by evidence relocation and disappears in the final full rerun.

The six integration profile-validation tests fail in both versions with the same `Missing expected rejection.` outcome (IOP unit, missing bodySite extension, missing Observation encounter, axial-length unit, Encounter class, finished Encounter end). Their complete paired diagnostics are in base-comparison.json; this is a base-proven limitation of the identical local environment, not a claim that their checks passed. The previous cleanup403 does not reproduce with the required CI environment: base69/69 and task73/73, so no cleanup failure exception is needed.

## Exactly eight UI failures carried to A3.2

[Per-test request/result proof](rev26-ui-proof.md), [source excerpts and ownership chains](rev26-ui-proof.json), [fresh names](rev26/ui-current-failures.json). Six send legacy saves for real shared ocular-health-structure definitions; two compare void results while dropping voidActionId. No other UI failures, no UI edits, and no new TODOs.

- deferred and recorded ocular findings cannot coexist at the client-server boundary
- fresh ocular-health history restores scoped diagnosis suggestions without a save
- count honesty: Dilation section preview, confirm, void result, section subtotal, and stored statuses all agree
- count honesty: whole-visit preview, confirm, void result, section subtotals, and stored statuses all agree
- custom state writer preserves other-only notes for normal and abnormal findings
- abnormal custom state other-only value leaves the exact unformatted sentinel behind
- exercised EOM and custom-state writers declare every schema-blind component code
- SWEEP-1 guard 1 REAL SEED: Anterior All Normal posts only requests accepted by the real capture handler

## Risks, follow-ups and handoff status

**BLOCKED pending registry scope.** The prepared two-entry registry patch needs explicit authorization because rev2.6 §4 permits only the listed source/tests and the inventory line anchors. After applying it, prove deletion of each entry red/restored green, rerun preflight and affected full checks, refresh refs, then commit/push/open the NOT EVALUATED, HELD OPEN PR. No merge. The PR must list these eight expected red UI tests and the exact base-proven environment pairs.

Required follow-up: **MCP attest/amend/append write no Provenance under a project-scoped identity (Medplum canSetId = super admin) — pre-existing, separate slice**. First-recorded and the writer repair-then-write versus repair-then-unchanged follow-ups remain deferred per contract. A3.1/A3.2 must not ship separately. No new decision document or Mandate14 terminology claim was introduced; this is implementation/proof of the accepted contract. Independent Claude Opus must evaluate the eventual exact PR head. Author verification is not an evaluation.

## Stopped containers and removed comparison checkout

Executed `docker ps -q --filter "name=^odos-r10-a3-1-" | xargs -r docker stop`. Stopped, not removed:

```text
odos-r10-a3-1-postgres-1 Exited (0) About a minute ago
odos-r10-a3-1-medplum-1 Exited (1) About a minute ago
odos-r10-a3-1-redis-1 Exited (0) About a minute ago
```

The detached base comparison worktree was clean and removed with `git worktree remove` after its runs. No base-specific containers were started; both comparisons used the same owned synthetic stack. No other project was stopped. Private operator credentials/cache remain preserved in the task’s ignored rev26-private directory, outside the non-live test environment.
