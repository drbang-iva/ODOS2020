# PR620 F1–F5 fixback after F4 provisioning ruling

**NOT EVALUATED — HELD OPEN. Author verification; independent Claude Opus re-evaluation required.**

Coded-by: Codex — GPT-6 Astra, high effort

This supersedes the F4 stop in [STATUS.md](STATUS.md), whose raw evidence remains preserved. F1–F3 were already proven before that stop. F4 now uses the lane admin only to provision/configure/clean up a separate disposable ClientApplication. F5 adds only `reviews.path_filters: ["!docs/evidence/**"]`. No merge, evaluation marker, role-policy change, service-authentication change or lifecycle-builder change.

## Changes and proof

Nine non-evidence files changed against3c14565e: `.coderabbit.yaml`; `mcp/scripts/check-r10-a3-release.mjs`; `mcp/src/clinical-graph/custom-section-endpoint.ts`; `mcp/src/index.ts`; and five tests: `r10A3McpGuards`, `r10A3OcularDoor`, `r10A3ReleaseChecker`, `r10A3ReleaseScenarios`, `r10OcularHealthDoorAuthzLive`. Evidence/audit files stay under this evidence tree. No UI file changed.

- **F1:** `V21 F1 patient-wide priors ignore encounter-less smoking status and retain canonical facts`; `V21 F1 patient-wide contributing foreign record is refused`; `V21 F1 patient-wide contributing unscoped record is refused`. Original54tests53pass1fail; fixed54/54. Refusal deletion and widening candidates back to all Observations each red→green. [Results](F1-mutations.json).
- **F2:** real-dispatch `W115 W116 F2 <tool> session refusal is audited once`, pre-rebuild/legacy/append cases, and existing mismatched-audit cases strengthened to assert exactly one denied row with reason and zero writes. Fixed63/63. Each of attest/amend/append moved back outside its audit try produces red; restoration green. [Results](F2-mutations.json). Initial bad-schema development fixtures are not counted as accepted mutation proof.
- **F3:** `T20 source census identifies any exam PDF consumer for canonical migration`; `W40 F3 Node census finds nested mixed-case exam PDF consumers in every source root`. Focused2/2. ActualT20 with a planted consumer in scratch and PATH without external binaries:0/1, then1/1 after removal. Directory scan deletion also red→green. [Results](F3-mutations.json), [scratch red](F3-scratch-red.txt), [green](F3-scratch-green.txt).
- **F4:** `MCP service identity: closed canonical amendment, real session binding and zero-write refusals`. Focused4/4; fullauthz73/73. Running the real amend process with lane-admin credentials yields PATCH403 and fails the expected200 assertion; restore the new service credentials→green. Removing the zero-policy guard fails its contaminated membership controls; restore→green. [Strict manifest](F4-mutations-manifest.json), [results](F4-mutations.json), raw logs in ../mutations/fixback-F4-*.txt. Membership.access and membership.accessPolicy are independently poisoned in controls. The service's own stored membership is checked before dispatch.
- **F5:** `F5 CodeRabbit excludes evidence and preserves every other setting`: delete filter→0/1; restore→1/1, with remainder byte-identical to3c14565e. [Results](F5-mutations.json), [test](F5-check.mjs).

All completed mutations use the strict one-anchor runner and byte-exact restoration. The deliberately missing anchor remains loudly rejected in [anchor-miss.txt](anchor-miss.txt). These focused, mutation, full and live counts overlap.

## Fresh CI-style lane

A new stack with fresh volumes, project `odos-r10-a3-1-ruling`, Medplum5.1.30-9b1bd92 at localhost:18103, PostgreSQL16-alpine at loopback29142, subnet10.249.145.0/24. The prior ci stack was stopped, not removed. Other projects were untouched. CI's checked-in server image is5.1.8; local pinned proof uses5.1.30 as instructed.

Sequence: live-integration bootstrap12/12 +218/218; operator-identity0; repair-practice-roles0 with MEDPLUM_CONTRACT_BOOTSTRAP=1 and GITHUB_ACTIONS=true; sync --apply --bootstrap-service-identity0; full test:live-authz with operator.env loaded73/73,0skip/TODO. [Bootstrap](ruling-bootstrap-ready.txt), [repair](ruling-repair.txt), [sync](ruling-sync.txt), [authorization](ruling-authz.txt).

The first fresh bootstrap was started before the server finished initializing and failed fetch in all12bootstrap hooks; it is preserved in ruling-bootstrap.txt. The accepted run began after healthcheck returned ok/version5.1.30. No code changed to address startup timing.

Synthetic project `a9c5235a-ca2f-403a-b73a-8da510760f02`. Provisioning login `r10-a3-ci-admin@example.invalid`, principal Practitioner/e903d96f-1af6-49a3-b8e8-224e1adfcec3, remained bound to AccessPolicy/e306ea6b-0019-436a-a315-df1f2200e963. New principal ClientApplication/411dae6f-ede0-42d5-ba27-37bf98ed4cdc has membership ProjectMembership/5466066e-2b4d-4494-9fab-21bc460ab3af: admintrue, access[], no legacy accessPolicy, zero policy references, no super-admin User, active project equals synthetic project. The identities differ.

Real MCP session practitioner Practitioner/6f63c1bc-2d26-4d2c-b223-718146cd0059. Observation/4df66ef0-d808-41e2-98c4-4f166919f600 final→amended; PATCH200, version advanced, identifier/all components/all extensions unchanged. Provenance entry404 and readback404 recorded as known rev2.5 defect, not asserted as required/success. Mismatched practitioner and pre-rebuild calls refuse with zero attempted/persisted FHIR writes. All remaining staff/provider/shared-body/append/audit rows pass. [Structured operation rows](ruling-live-results.json).

Cleanup: membership deletion200, ClientApplication deletion403, explicitly recorded. The membership was removed; the residual application is confined to disposable storage. Earlier seeder403 attempts and the initial membership-read403 are preserved; the final test reads membership as its new service identity.

## Assertions and retained original evidence

[Fixback delta](assertion-delta.json):346 original assertions retained; five changed originals mapped to W40/F3 or V35/W115/F4, zero unmapped. Added checks strengthen the approved behaviors. [Original-base audit](../assertion-audit/result.json):2950 original assertions=2560retained+390mapped, including the previously documented removal;0gaps/ledgerissues. [Audit output](ruling-assertion-verification.txt).

Original G-e–G-h grading, P1–P26,64requiredWrows and T22 registry/census remain in the parent bundle; not re-run or regraded. T22 remains27semanticpaths,97calls/43files,30mapped/67reasonedexclusions, including BinaryJSONPatch. [Census](../release/census-output.json).

## Remaining limitations

MCP attest/amend/append write no Provenance under a project-scoped identity (Medplum canSetId = super admin) — pre-existing, separate slice. A3.2 carries the exact eight UI failures and nine open release slots; no independent shipping of A3.1/A3.2. Independent Claude Opus must re-evaluate the final SHA; author/bot checks are not that verdict. No new clinical terminology or decision claim was introduced.

## Full checks before push

| Command | Result |
|---|---|
| npm --prefix mcp test (confirmation run) |5992tests,5938pass,1fail,53skip,0TODO; sole WeasyPrint ENOENT |
| same command at detached1706d7c8 |5687tests,5618pass,1fail,52skip,16TODO; same WeasyPrint ENOENT |
| npm --prefix ui test |1685tests,1673pass,8approvedfail,0skip,4existingTODO |
| npm --prefix mcp run build |exit0 |
| npm --prefix ui run build |exit0 |
| npm run preflight |exit0,0warnings/hardblocks |
| node mcp/scripts/check-r10-a3-release.mjs |16MCPgreen,9UIopen; expected exit1 |

The non-live environment contains allowlisted OS variables plus ODOS_POSTGRES_URL and ODOS_REAL_WEASYPRINT_TEST=1, no MEDPLUM credentials/project/operator variables; root operator.env was moved to ignored storage first. Dependencies are installed for root/mcp/ui; the detached base comparison reuses the same installed dependencies. PostgreSQL is the same disposable29142 instance; no base-only containers. No temporary probe lives under ui/src, ui/tests or mcp/tests.

The first full task run also failed `precondition HTTP terminal-release lost 412 race returns typed 409` (200 rather than409). The immediate file rerun passed43/43; the unchanged full confirmation run passed that test. Repetition of the unchanged file at base also exposes intermittent HTTP failures, but those are tracked separately rather than relabeling a different failure as the exact base reproduction. Original raw logs are retained, including the first task failure. No education source or assertion was changed. See the later final handoff for the completed comparison and hosted CI results.

The eight UI failures have the same names and proof as [rev26-ui-proof.md](../rev26-ui-proof.md); no additional failure. The53MCPskips are the existing non-live partition, with the established base52/task53 distinction retained; no skip or TODO was added by this fixback.

Fresh refs before push: origin/main c742b2e4b543e0706b24f66aec6883a82f0d18a3; origin/drbang-iva/r10-a2b2 1706d7c8417b04791471d4332b4ecd712883bf11, both unchanged. No rebase required.
