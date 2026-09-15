# Plan-set authoring slice 1a — fixback sealed bundle

## Status and identity

**Needs independent evaluation.** Local branch `drbang-iva/plan-authoring`. Starting head verified clean: `4ca6500a720134fb6c10a4b48920dc00c2972797`, the head reviewed by Opus as NEEDS-WORK. Fixback code commit: `6753f895d282ee034d00de30e64d254ed30c76fd`. A subsequent evidence-only commit removes raw logs and updates this bundle. No push, PR, deployment, or test stack startup.

The original slice is based on `52c6ec4926e95e78344082add8522e74743ffb33`; this fixback continues the evaluated branch without rebasing or changing versions. Initial code commits remain `79588035`, `bac7cd14`, `e968b821`, `6b5d385f`, `7891ed17`; initial evidence commits `8b1c0784`, `4ca6500a`.

## Summary

All cited defects were verified at the requested head before edits. Only the five requested areas changed:

1. Unapply collects projection-restore failures and finishes restoring actions, findings, charges and the application before throwing one error containing every refused projection reference and the original failure. Conditional restoration still leaves a newer conflicting projection untouched. Executed real-route tests cover one and two conflicting ServiceRequests after failure on the first charge write: application active, all five orders restored, nonconflicting requests active, five staged charges still owned by that application.
2. Apply and item-add seed just their requested built-in and the built-in rules referenced by its charge seeds. Boot retains the full pass. Existing upgrade conditions, snapshot handling and conflict logging are unchanged. The dry-eye evaluation protocol retains its referenced evaluation rule.
3. Offers reuse `unofferedSelectedItems` with default selections, so IPL off marks both `series-ipl` and `charge-ipl-package` false. The existing rail filter hides both. A charge needed by another selected offered item remains available.
4. Counseling and monitoring wording follows operator rulings 8–9 exactly, without version bumps. The seven exact pairs appear below.
5. Removed 57 tracked raw/intermediate evidence files. Their originals remain local under `outputs/plan-authoring-fixback/prior-evidence/`. This directory retains the README, preservation script/report, mutation JSON summaries and PNGs. New raw checks remain local in `outputs/plan-authoring-fixback/`; none are committed.

## Executed checks

All following checks ran against the code in `6753f895` (subsequent changes are evidence only).

| Command/check | Actual output |
|---|---|
| Protocol suites, command below | 212 tests; 212 pass; 0 fail; 0 skipped; exit 0 |
| From `ui`: `node --import tsx --test tests/planAuthoring.test.tsx` | 3 tests; 3 pass; 0 fail; exit 0 |
| `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` | 5027 tests; 4958 pass; 6 PostgreSQL failures; 63 skipped (43 live-stack checks); exit 1 |
| `npm --prefix mcp run build` | `tsc`; exit 0, no diagnostics |
| `npm --prefix ui run build` | TypeScript and Vite passed; 327 modules transformed; existing large-chunk advisory; exit 0 |
| `npm run preflight` | 0 warning(s), 0 hard block(s); exit 0 |
| `node docs/build-log/plan-authoring-1a/test-preservation.mjs` | All mandatory assertion hashes unchanged; details below |
| `git diff --check` | no errors |

Protocol command:

```sh
npm --prefix mcp test -- src/__tests__/protocol-phase5.test.ts src/__tests__/gonioscopy-phase5.test.ts tests/procedureChargeMaterialization.test.ts tests/dryEyeInitiationProtocols.test.ts src/__tests__/plan-carried.test.ts src/__tests__/plan-set-generator.test.ts src/__tests__/plan-seeding.test.ts src/__tests__/plan-offered.test.ts src/__tests__/plan-glaucoma-integration.test.ts src/__tests__/plan-materialization.test.ts
```

Full MCP failing test names (all in `claimReadModelStore.test.ts`, unavailable PostgreSQL `ECONNREFUSED 127.0.0.1:5433`):

- rebuild is atomic and server-side worklist grouping returns honest untouched facts
- never-paid-untouched aggregation is performed by payer and month in PostgreSQL
- reconciliation detects a corrupted money row and a rebuild restores exact FHIR-derived truth
- an older per-claim upsert cannot overwrite a newer completed rebuild
- an older rebuild snapshot fails loudly without publishing incomplete FHIR truth
- file-level `mcp/tests/claimReadModelStore.test.ts` failure from database cleanup

The first full run recorded 5027 tests, 4957 passes, 7 failures and 63 skips: the six database failures plus `B3 global record widens and preserves every existing extension` in `commsApi.test.ts` (404 versus expected 200). Its source and communications implementation are unchanged from the evaluated head. An isolated rerun passed 99/99 with no edits. The cause of that intermittent failure is unresolved; the final full rerun is reported in the table above.

This is not a green full MCP suite. The ungated flag acknowledges missing live-stack checks; it does not establish authorization correctness. No full UI rerun is claimed for this fixback: the requested touched UI tests ran. The prior evaluated head had 1554/1554 UI tests.

### Measured searches

The counting fake executes real route handlers after a full warm boot. Seeding is the first seven searches: one definition, one snapshot and five referenced glaucoma rules. Budgets are asserted, not inferred from source.

| Warm suspect operation | Before total / seed | After total / seed |
|---|---|---|
| Item tap | 51 / 34 | 24 / 7 |
| Whole apply | 79 / 34 | 52 / 7 |

First apply on an empty store also passes and creates only the requested suspect definition and its five rules. Restoring the all-built-ins seed call fails both warm budgets and the empty-store isolation assertion.

## Mandate 17 — break and restore

[Fixback mutation results](evidence/fixback-mutations.json):

| Mutation | RED | Restored GREEN |
|---|---|---|
| Rethrow projection restore immediately | 2 rollback regressions fail | 12/12 |
| Seed all built-ins on apply/tap | 3 seeding regressions fail | 7/7 |
| Annotate charges only from procedureDefinitionKey | IPL dependent charge assertion fails | 6/6 |
| Revert monitoring reason wording | exact seven-string assertion fails | 13/13 |

Each RED run exited 1; each restored run exited 0. Initial slice mutation summaries retained: [parent](evidence/parent-mutations.json), [UI](evidence/ui-mutations.json). Those historical results describe their original stages; the fixback counts above are current.

## Preservation

[AST report](test-preservation.json), reproducible with the command above, binds to `6753f895`: phase5 115/115 static callbacks, procedure-charge 7/7, gonioscopy 6/6; every assertion hash unchanged from original base. The fixback changes none of these files. The sole original slice body exception remains the allowed finding-case setup in `shared rollback endpoint: ${kind} revocation rollback preserves original FHIR IDs and statuses`, which pre-saves staff-owned v1. All assertions, including #599/1b, remain intact. Static callback counts differ from dynamic runtime counts.

The original v1 suspect object and its nonexistent test-only handout reference remain unchanged. All seven generated glaucoma sets still emit zero education items; each hidden report includes “handout — no real catalog content”. No catalog entries or assetRefs were invented. The catalog-row × laterality oracle remains 60/60.

Historical component screenshots retained: [before](browser-before.png), [after](browser-after.png). These are initial synthetic component proof, not screenshots of this fixback or full app/Medplum proof. The touched rail test now includes both unavailable IPL rows and proves neither renders.

## Operator red-pen list — final counseling and recall reasons

| Set | Exact counseling string | Exact follow-up reason | Unchanged default |
|---|---|---|---|
| Suspect | Discussed glaucoma suspect. Questions answered. | Glaucoma suspect monitoring | 6 months |
| Ocular hypertension | Discussed ocular hypertension. Questions answered. | Ocular hypertension monitoring | 6 months |
| Narrow angle | Discussed anatomical narrow angle: angle-closure warning signs · medications that dilate (antihistamines, decongestants, anticholinergics). Questions answered. | Anatomical narrow angle monitoring | 6 months |
| Primary angle closure | Discussed primary angle closure without damage. Questions answered. | Primary angle closure without damage monitoring | 1 month |
| Steroid responder | Discussed steroid responder. Questions answered. | Steroid responder monitoring | 2 weeks |
| POAG | Discussed primary open-angle glaucoma: adherence and drop technique. Questions answered. | Primary open-angle glaucoma monitoring | 3 months |
| Low-tension glaucoma | Discussed low-tension glaucoma. Questions answered. | Low-tension glaucoma monitoring | 3 months |

Follow-ups retain medical kind and scheduling-order behavior. No handout titles form part of this list.

## Files touched in fixback

- `mcp/src/clinical-graph/protocol-service.ts`: finish rollback after refused projections, aggregate error.
- `mcp/src/clinical-graph/protocol-endpoint.ts`: requested-only seeding and dependent-charge offer state.
- `mcp/src/clinical-graph/plan-sets/glaucoma.ts`: exact counseling and monitoring reasons.
- `mcp/src/__tests__/plan-carried.test.ts`: one/two projection-conflict recovery scenarios.
- `mcp/src/__tests__/plan-glaucoma-integration.test.ts`: warm search budgets and empty-store seeding.
- `mcp/src/__tests__/plan-offered.test.ts`: IPL package unavailable/available annotations.
- `mcp/src/__tests__/plan-set-generator.test.ts`: exact seven wording pairs.
- `ui/tests/planAuthoring.test.tsx`: unavailable package absent from rail.
- This README, `test-preservation.json`, `evidence/fixback-mutations.json`, and removal of 57 raw/intermediate evidence files.

## Risks, decisions and verification boundaries

A refused projection intentionally remains at its newer version; the error identifies it for reconciliation. Restoring the application does not claim that this conflicting projection was repaired. Other rollback conditional-write behavior is unchanged. Tests use a conditional/version-aware FHIR fake through real handlers, not a live Medplum instance. No cross-process atomicity, live policy enforcement, delivery tracking or deployment is claimed.

No policy scope, Basic-code inventory, terminology code, schema, dependency or version changed. No new Mandate 14 ledger rows were needed for this fixback. The original ledger remains `data/code-bindings/plan-authoring-focus-ledger.json`, recording agreement of [HL7 R4 definitions](https://hl7.org/fhir/R4/servicerequest-definitions.html) and [HL7 R4 JSON schema](https://hl7.org/fhir/R4/servicerequest.schema.json.html), accessed 2026-09-15 during the original slice. It is a verification record, not runtime enforcement. No new source-verification claim is made here.

No new product decision: implemented the operator's existing rulings, so companion `decisions/INDEX.md` is unchanged. Cross-repo follow-up is independent evaluation of this final branch head against the kickoff and rulings. No raw logs, private kickoff/design documents or practice data are included in the new evidence commit.

**NOT EVALUATED independently.** This is the author's fixback to Opus's NEEDS-WORK verdict. Obtain a fresh exact-head review from Fable (high) or Opus (extra) before merge; the prior verdict cannot approve new commits.
