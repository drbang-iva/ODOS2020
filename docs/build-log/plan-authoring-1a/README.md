# Plan-set authoring slice 1a — sealed author bundle

## Status and identity

Implemented and committed locally on `drbang-iva/plan-authoring`, based on freshly fetched `origin/main` `52c6ec4926e95e78344082add8522e74743ffb33`. Main was checked again before final verification and had not moved. Code head: `7891ed1724ac0744468d187784519ec1e50143a3`. This bundle is a subsequent evidence-only commit. No push, PR, deployment, or bot review was requested or performed.

Code commits: `79588035`, `bac7cd14`, `e968b821`, `6b5d385f`, `7891ed17`.

**NOT EVALUATED independently.** These are author checks, including same-model delegated review. Hand to Fable (high) or Opus (extra) for independent exact-head evaluation before merge.

## Result

Seven glaucoma sets are generated from versioned specifications and existing diagnosis/orderable catalogs. Unknown families and finding seeds are refused; pending tests and unavailable handouts remain hidden. All seven sets emit zero education items. The original v1 suspect fixture retains its nonexistent test-only assetRef unchanged. Real synthetic catalog content emits a print item; unknown or placeholder content does not. Recorded education uses the catalog title and “Handout recorded; delivery is not yet tracked”. No catalog entries were added.

Optional titles and explicit procedure links round-trip through authoring. Existing series items round-trip without adding a new series creation workflow. Both apply paths re-read the active procedure switch before resolving series; whole-plan application skips an unoffered item and its dependent charge unless another selected offered item needs it. Item addition returns 409; configured inactive series remains 400. Offers expose this state and the rail hides unavailable items.

Built-in upgrades preserve staff/draft/retired heads, snapshot the prior version before a conditional advance, and log conflicts. A lost head race cannot reserve the staff author's next snapshot. Interrupted snapshot creation is repaired on later seed or preserved before draft/retirement changes. Rule upgrades retain existing evaluation versions. Stored IDs are excluded from fixture fallback even when filtered out.

Carried repairs preserve apply/unapply conflict status, check follow-up existence under lock, preserve resolved clinician-owned undo flags, and use the revoked resource version for conditional rollback restoration. UI counts offers once and permits confirmation of missing follow-up defaults. Titles preserve timing context.

## Executed verification

| Check | Actual result | Evidence |
|---|---|---|
| Focused protocol run (command and full file list in log) | 206 tests, 206 pass, 0 fail | [protocol](evidence/protocol-final.txt) |
| `npm --prefix ui test` | 1554 tests, 1554 pass, 0 fail, 0 skipped | [UI](evidence/ui-full-final.txt) |
| `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` | 5021 tests, 4952 pass, 6 fail, 63 skipped; exit 1 | [MCP](evidence/mcp-full-final.txt) |
| `npm --prefix mcp run build` | exit 0, no TypeScript diagnostics | [build](evidence/mcp-build-final.txt) |
| `npm --prefix ui run build` | exit 0, 327 modules; existing chunk-size advisory | [build](evidence/ui-build-final.txt) |
| `npm run preflight` | 0 warnings, 0 hard blocks | [preflight](evidence/preflight-final.txt) |
| `node .claude/skills/tier0-census/scripts/check-proxy-coverage.mjs` | 25 backend families, 28 proxies, all covered; advisory | [proxy](evidence/proxy-coverage.txt) |
| Synthetic browser component proof | 5 checks passed; zero page errors; browser/server closed | [proof](evidence/browser-proof.txt) |

The six MCP failures are the expected unavailable PostgreSQL lane (`ECONNREFUSED 127.0.0.1:5433`) in `claimReadModelStore.test.ts`: atomic rebuild/worklist grouping; never-paid aggregation; corrupted-row reconciliation; older upsert versus rebuild; older rebuild refusal; and file-level cleanup failure. The full suite is **not green**. Of the 63 skips, 43 explicitly require a live stack, including authorization enforcement. No Docker stack was started. The task-owned Vite server on strict port 19361 was stopped and its listener checked absent.

Browser proof exercises the actual staging and follow-up components with synthetic props, including title, hidden IPL, selection and confirm behavior. It is not a full app-route or Medplum walkthrough. Charge rows were omitted from this focused screenshot fixture. [Before](browser-before.png) · [After](browser-after.png).

## Preservation audit

Reproduce with `node docs/build-log/plan-authoring-1a/test-preservation.mjs`. [AST report](test-preservation.json) binds to the code head above: phase5 115/115 static callbacks; procedure-charge 7/7; gonioscopy 6/6. **All assertion hashes unchanged** in these mandatory files, including #599/1b. Static callback counts differ from dynamically expanded runtime tests.

The sole permitted body exception is setup for `shared rollback endpoint: ${kind} revocation rollback preserves original FHIR IDs and statuses`: the finding case pre-saves staff-owned v1 because generated v2 has no finding seed. Assertions are unchanged. Fixture imports use the v1 alias where applicable. The phase5 FHIR fake now returns/checks resource versions while retaining domain snapshot shape. The original suspect object is byte-identical apart from export naming ([source check](evidence/generator-preservation.log)). Outside the three mandatory files, the existing IPL integration expectation gains the required `procedureDefinitionKey`; no old assertion was removed.

The independent catalog-row × populated-laterality oracle covers 15 rows and 60 slots, each with exactly one intended offer. Removing the severe family resolver result makes it fail.

## Mandate 17 — demonstrated guards

All 13 required mutations were executed, failed, and restored green. Logs retain both states; earlier stage counts are superseded by the final suite counts above.

| Mutation | RED result | Restored GREEN |
|---|---|---|
| Delete pending entry | generator failure | 12/12 |
| Remove severe resolver family | generator failure | 12/12 |
| Emit hidden test | generator failure | 12/12 |
| Emit placeholder-host handout | generator failure | 12/12 |
| Ignore offered active switch | 4 failures | 6/6 |
| Remove seed draft precondition | 1 failure | 14/14 |
| Skip prior snapshot | 3 failures | 14/14 |
| Collect stored IDs after filtering | 1 failure | 4/4 |
| Remove apply 409 mapping | 1 failure | 10/10 |
| Remove unapply 409 mapping | 1 failure | 10/10 |
| Move follow-up check outside lock | 1 failure | 10/10 |
| Re-raise resolved undo flag | 1 failure | 10/10 |
| Remove restore If-Match | 4 failures | 10/10 |

Raw evidence: `evidence/generator-mutation-*.log` with `generator-restored.log`; [parent results](evidence/parent-mutations.json) with `mutation-*-red/green.txt`; `carried-mutation-*.txt` with `carried-restored-*.txt`. Four additional UI mutations (count, defaults, hiding, title) each failed then restored 3/3: [UI results](evidence/ui-mutations.json). Further red/green regression logs cover title detail and seeding snapshot races. Carried intermediate bundle/logs describe their earlier integration stage, not final status.

## Hidden report

Every row also hides **handout — no real catalog content**. No handout titles form part of the red-pen list.

| Set | Pending tests hidden as not-orderable |
|---|---|
| glaucoma-suspect-initial | corneal-hysteresis; erg (PhNR); oct-angiography |
| glaucoma-oht | corneal-hysteresis |
| glaucoma-narrow-angle | anterior-segment-oct |
| glaucoma-pac | anterior-segment-oct |
| glaucoma-steroid-responder | none |
| glaucoma-poag | corneal-hysteresis; erg; oct-angiography |
| glaucoma-ltg | corneal-hysteresis; erg; oct-angiography; anterior-segment-oct |

## Operator red-pen list — every emitted counseling string and follow-up reason

### glaucoma-suspect-initial

Counseling: Discussed Glaucoma suspect: Glaucoma suspect. Questions answered.

Follow-up reason: **Glaucoma suspect**. Default: 6 months; medical, scheduling order enabled.

### glaucoma-oht

Counseling: Discussed Ocular hypertension: Ocular hypertension. Questions answered.

Follow-up reason: **Ocular hypertension**. Default: 6 months; medical, scheduling order enabled.

### glaucoma-narrow-angle

Counseling: Discussed Anatomical narrow angle: angle-closure warning signs · medications that dilate (antihistamines, decongestants, anticholinergics). Questions answered.

Follow-up reason: **Anatomical narrow angle**. Default: 6 months; medical, scheduling order enabled.

### glaucoma-pac

Counseling: Discussed Primary angle closure without damage: Primary angle closure without damage. Questions answered.

Follow-up reason: **Primary angle closure without damage**. Default: 1 months; medical, scheduling order enabled.

### glaucoma-steroid-responder

Counseling: Discussed Steroid responder: Steroid responder. Questions answered.

Follow-up reason: **Steroid responder**. Default: 2 weeks; medical, scheduling order enabled.

### glaucoma-poag

Counseling: Discussed Primary open-angle glaucoma: adherence and drop technique. Questions answered.

Follow-up reason: **Primary open-angle glaucoma**. Default: 3 months; medical, scheduling order enabled.

### glaucoma-ltg

Counseling: Discussed Low-tension glaucoma: Low-tension glaucoma. Questions answered.

Follow-up reason: **Low-tension glaucoma**. Default: 3 months; medical, scheduling order enabled.

## Mandate 14 and policy impact

Two primary HL7 sources were accessed on 2026-09-15 and agree: [R4 ServiceRequest element definitions](https://hl7.org/fhir/R4/servicerequest-definitions.html) and [R4 ServiceRequest JSON schema](https://hl7.org/fhir/R4/servicerequest.schema.json.html). `bodySite` and `orderDetail` are repeatable CodeableConcepts; authored focus is plain text, with the existing request code present. Ledger rows: `data/code-bindings/plan-authoring-focus-ledger.json`, both elements and both source records. This ledger records verification and is **not runtime enforced**. No new medical terminology codes were introduced; existing catalog/ledger resolution remains the source.

No policies, Basic code inventory, or authorization grant scope changed. The grant check edits are exact-line offsets only. Static policy delta is empty. A live policy-sync dry run was not performed: no disposable Medplum stack was started. Fake-backed tests cannot prove real AccessPolicy enforcement.

## Risks and follow-ups

Independent exact-head evaluation and operator clinical red-pen review remain required. No live FHIR/browser-route proof, deployment, or delivery tracking is claimed. Conditional writes refuse lost races; this is not a cross-process transaction guarantee. Rollback conflicts fail explicitly rather than overwriting another writer. Existing requiresOrderCompletion/performContext fields remain data, not newly enforced gates; historical rule-resolution and dxScope enforcement are outside this slice.

No new product decision was made: existing operator rulings were implemented, so companion `decisions/INDEX.md` was not changed. Cross-repo follow-up is review of this implementation against the existing kickoff/design; no strategy or private kickoff documents were copied into the public evidence. The local ignored originals remain uncommitted.

## Files touched

- `data/code-bindings/plan-authoring-focus-ledger.json`
- `mcp/src/__tests__/helpers/plan-authoring-fhir.ts`
- `mcp/src/__tests__/plan-carried.test.ts`
- `mcp/src/__tests__/plan-glaucoma-integration.test.ts`
- `mcp/src/__tests__/plan-materialization.test.ts`
- `mcp/src/__tests__/plan-offered.test.ts`
- `mcp/src/__tests__/plan-seeding.test.ts`
- `mcp/src/__tests__/plan-set-generator.test.ts`
- `mcp/src/__tests__/protocol-phase5.test.ts`
- `mcp/src/clinical-graph/plan-item-offered.ts`
- `mcp/src/clinical-graph/plan-sets/generator.ts`
- `mcp/src/clinical-graph/plan-sets/glaucoma.ts`
- `mcp/src/clinical-graph/plan-sets/types.ts`
- `mcp/src/clinical-graph/protocol-endpoint.ts`
- `mcp/src/clinical-graph/protocol-fixtures.ts`
- `mcp/src/clinical-graph/protocol-seeding.ts`
- `mcp/src/clinical-graph/protocol-service.ts`
- `mcp/src/clinical-graph/protocol-store.ts`
- `mcp/src/clinical-graph/protocol-types.ts`
- `mcp/src/comms/education-catalog.ts`
- `mcp/src/index.ts`
- `mcp/tests/dryEyeInitiationProtocols.test.ts`
- `mcp/tests/procedureChargeMaterialization.test.ts`
- `scripts/fhir-read-grant-check.ts`
- `ui/src/components/charting/AssessmentSection.tsx`
- `ui/src/components/charting/ProtocolApplicationStatus.tsx`
- `ui/src/components/charting/ProtocolStagingList.tsx`
- `ui/src/lib/protocol-authoring.ts`
- `ui/src/scenes/ProtocolLibrary.tsx`
- `ui/tests/planAuthoring.test.tsx`

Evidence files are under this directory. Absolute checkout prefixes in copied logs are replaced with `$WORKTREE`, `$GENERATOR_WORKTREE`, or `$CARRIED_WORKTREE`; trailing whitespace is normalized; test outputs/counts are otherwise retained.
