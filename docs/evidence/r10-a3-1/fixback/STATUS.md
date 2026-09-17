# PR620 fixback — sealed stop bundle

**BLOCKED on F4 provisioning authority. NOT EVALUATED. HELD OPEN.**

Coded-by: Codex — GPT-6 Astra, high effort

PR: https://github.com/drbang-iva/ODOS2020/pull/620
Published head remains `3c14565e6e9b42241f413bb3af89fce69867bd7c`, independently evaluated NEEDS-WORK by Claude Opus. This fixback is preserved uncommitted in `.worktrees/r10-a3-1`, branch `drbang-iva/r10-a3-1`; no new push, evaluation marker or merge.

## Blocking boundary and requested ruling

F4 explicitly requires provisioning the new project-admin service identity **through the seeder**. In the exact CI-style lane, the distinct operator seeder cannot perform either administrative provisioning path:

- Administrative `POST /admin/projects/<project>/client` returns403. Full live lane71/73, failing before lifecycle operations. [Raw result](F4-admin-api-refusal.txt).
- FHIR ClientApplication creation succeeds, but seeder `POST /fhir/R4/ProjectMembership` returns403. Focused A3 lane2/4, failing before lifecycle operations. The created application was cleaned up. [Raw result](ocular-initial.txt).

The pending question asks whether the lane's existing project-admin login may be used **only for provisioning** the new disposable policy-free service identity. Its existing practice-role bindings would stay intact, and all amendment/refusal assertions would run as the new identity, never the lane admin or a super admin. This alternative has not been applied because “through the seeder” is an explicit F4 constraint. [Detailed boundary record](F4-provisioning-block.md).

## Completed changes and files

- F1: `mcp/src/clinical-graph/custom-section-endpoint.ts` limits patient-wide prior candidates to codes belonging to the requested shared definition, then refuses foreign/unscoped contributing records. An encounter-less smoking-status Observation no longer suppresses canonical priors.
- F2: `mcp/src/index.ts` moves attest/amend session and lifecycle guards, and append guards/building, inside their existing denied-audit try/catch boundaries. Denied rows retain the actual reason.
- F3: `mcp/scripts/check-r10-a3-release.mjs` supplies the Node-only source census over mcp/src, ui/src and src. T20 calls it without an external binary.
- Tests: `r10A3OcularDoor.test.ts`, `r10A3McpGuards.test.ts`, `r10A3ReleaseChecker.test.ts`, `r10A3ReleaseScenarios.test.ts`.
- F4: `r10OcularHealthDoorAuthzLive.test.ts` has a **partial, not passing** service-provisioning change. Its membership-shape and lifecycle assertions remain pending successful provisioning. No service-authentication module, role policy or builder changed.
- F5: not applied because the ordered fixback stopped at F4. `.coderabbit.yaml` remains unchanged.
- Evidence and assertion audit updates stay under docs/evidence/r10-a3-1. [Tracked delta inventory](changed-files.txt); the root bundle inventory includes new evidence as well.

## Per-fix red and green proof

[All parsed counts](test-counts.json), [strict-anchor manifest](mutations.json), raw mutation logs in ../mutations.

**F1:** `V21 F1 patient-wide priors ignore encounter-less smoking status and retain canonical facts`; `V21 F1 patient-wide contributing foreign record is refused`; `V21 F1 patient-wide contributing unscoped record is refused`.

The original widened refusal produced53pass/1fail in54tests. Fixed suite54/54. Removing the contributing-record refusal is red; restoring is green. Widening the candidate set back to every Observation is red; restoring is green. [Two mutation results](F1-mutations.json).

**F2:** real MCP SDK dispatch tests named `W115 W116 F2 <tool> session refusal is audited once`, `W115 F2 <tool> pre-rebuild refusal is audited once`, `W115 F2 <tool> legacy refusal is audited once`, and `W116 F2 append <target|result> shared refusal is audited once`; the existing `W115 <tool> refuses mismatched audit` cases now also assert exactly one denied row with the audit-repair reason. Every refusal asserts tool error, zero FHIR writes, and one denied row. Restored suite63/63. Moving each tool's checks back outside its try is red, restored green: [three mutations](F2-mutations.json). The initial development log includes five invalid-argument fixture failures; those arguments were corrected to the real strict schemas before the accepted mutation proofs. Do not credit those fixture failures as guard proof.

**F3:** `T20 source census identifies any exam PDF consumer for canonical migration` and `W40 F3 Node census finds nested mixed-case exam PDF consumers in every source root`,2/2. The actual T20 in a scratch copy with a planted exam-PDF source fails0/1; removing the planted source passes1/1. PATH points to no external binaries for both runs. [Scratch red](F3-scratch-red.txt), [scratch green](F3-scratch-green.txt), [reproducer](pdf-proof.mjs). Disabling the Node directory scan also fails the census guard, restored green: [mutation](F3-mutations.json).

**F4:** not green. Staff/provider live rows pass; service setup is blocked by the two403s above. No successful membership shape or amendment result is claimed for the proposed new principal.

**F5:** pending; no red/green claim.

A deliberately absent source anchor is rejected with `MUTATION ANCHOR MISS` before executing any test: [proof](anchor-miss.txt). Production source restoration is byte-exact in each completed mutation.

## Full commands and environment

| Command | Actual result |
|---|---|
| `npm --prefix mcp test` |5992 tests:5938pass,1fail,53skip,0TODO; exit1 |
| `npm --prefix ui test` |1685 tests:1673pass,8fail,0skip,4existingTODO; exit1 |
| `npm --prefix mcp run build` |exit0 |
| `npm --prefix ui run build` |exit0; existing chunk-size warning |
| `npm run preflight` |all stages complete;0warnings/0hardblocks; exit0 |
| release checker |16MCPslots green,9UIslots open; expected exit1 |
| full working delta whitespace check |exit0 after preserving and normalizing new captured logs |
| fresh CI-style `test:live-integration` |bootstrap12/12 plus218/218; exit0 |
| operator-identity, repair-practice-roles, sync --apply --bootstrap-service-identity |each exit0 |
| CI-style full `test:live-authz`, admin-endpoint attempt |73tests:71pass,2fail(parent+service subtest),0skip/TODO; exit1 |
| focused A3 live, FHIR-membership attempt |4tests:2pass,2fail(parent+service subtest),0skip/TODO; exit1 |

Non-live commands use only allowlisted OS variables, ODOS_POSTGRES_URL and ODOS_REAL_WEASYPRINT_TEST=1. No MEDPLUM_PROJECT_ID/credentials/operator variables; generated `.odos/operator.env` and identity cache were moved to the ignored fixback directory before full non-live tests. All package dependencies were already installed; no dependency changes. No temporary probe was placed in test discovery. [Environment record](environment.json), [clean runner](run-clean.mjs), [live sequence runner](run-ci-lane.mjs).

Fresh Docker project `odos-r10-a3-1-ci`, Medplum5.1.30-9b1bd92 at localhost:18103, PostgreSQL16-alpine at loopback29142/fresh medplum database, private subnet10.249.144.0/24 and uniquely scoped volumes. Existing other projects occupied15432 and other subnets; none were altered. CI's checked-in image is5.1.8, while this requested pinned local proof uses5.1.30. The CI sequence uses MEDPLUM_CONTRACT_BOOTSTRAP=1 and GITHUB_ACTIONS=true, exports the bootstrapped project and loads the operator environment before authorization. Project `c16edbe4-6e68-4f43-be03-52684b747b6d`. Repair bound the lane admin membership to AccessPolicy/b0a47714-bad8-4bd9-8251-de011ba76e94. [Repair](repair.txt), [sync](sync.txt).

The only non-live failure is `installed WeasyPrint 69.0 emits a real PDF/A-3u document`: `WeasyPrint render failed: spawn weasyprint ENOENT`. This is the same local missing-binary failure previously reproduced at base; no new base comparison was run against this fresh database. The53skips are the established non-live credential partition; the new F1/F2/F3 tests execute, no new skip/TODO. The earlier six local profile-validation failures do not occur on the fresh CI-style stack: integration218/218.

UI's eight failures exactly match the approved carried set; see [raw UI output](ui-test.txt) and the [existing per-test proof](../rev26-ui-proof.md). No UI source changed. Full/focused/mutation/live counts overlap and must not be added.

## Assertion audit and retained evidence

[Fixback assertion delta](assertion-delta.json):346 retained assertions across the five changed test files; five changed originals mapped explicitly (two T20 assertions to the F3-approved Node census/W40 guard; three service identity assertions to V35/W115/F4), no unmapped change. All pre-existing F1/F2 assertions remain intact; new assertions strengthen refusal auditing and candidate scoping. F4's new checks are not yet runtime-verified.

[Original-base audit](../assertion-audit/result.json):2950 originals=2560retained+390mapped, one previously documented explicit removal, zero gaps or invalid ledger anchors. The audit script now treats files introduced after the base as having no base assertions, instead of failing git-show after those files become tracked. Source digests regenerated. Original gates, premises and64-row guard history remain preserved; no gate reruns or changes to their grading.

## Remote CI and bots

No fixback was pushed, so there is no new-head CI run or CodeRabbit review to claim. Published head remains3c14565e. Its [MCP CI job](https://github.com/drbang-iva/ODOS2020/actions/runs/35205773094/job/105151173044) failed T20 due to absent rg and never reached live lanes; its UI job had the approved eight failures. CodeRabbit skipped for the1080-file count; PR-Agent's previous one note was already adjudicated. The requested code-only filter and final-head terminal review/four-minute re-poll remain pending F4/F5 and a new push.

Origin/main c742b2e4b543e0706b24f66aec6883a82f0d18a3 and origin/drbang-iva/r10-a2b2 1706d7c8417b04791471d4332b4ecd712883bf11 were freshly fetched and unchanged; no rebase.

## Risks, follow-ups and cleanup

F4 must be resolved before the service test can pass or a new head can be handed for independent re-evaluation. Do not use the prior policy-free login run as CI proof. F5, final CI counts, CodeRabbit review and its thread dispositions remain pending. The pre-existing project-scoped lifecycle Provenance defect stays out of scope; no builder/auth/policy change was made. A3.2's UI failures and nine open release slots remain carried. No new decision or terminology claim was introduced.

Executed the requested docker-stop filter. Stopped, not removed: odos-r10-a3-1-ci-medplum-server-1, odos-r10-a3-1-ci-postgres-1, odos-r10-a3-1-ci-redis-1, all exit0. The binary-init container had already exited0; the original three odos-r10-a3-1 containers remain stopped. [Stop record](container-stop.txt). No other project's services were stopped. All work and private credentials are preserved locally; no destructive history operation or force push.
