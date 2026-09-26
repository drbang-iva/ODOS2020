# W2b visit diagnosis defaults

NOT EVALUATED. Independent Claude Opus 5.5 evaluation is required before merge.

## Scope and premises

Base: `4afa0b62c34111ce7b799c16a6a013239e6698a7`, refreshed from origin before edits. Branch: `drbang-iva/w2b-visit-dx-link`.

- P1 confirmed: `protocol-endpoint.ts` calls the default only for a newly created visit proposal with omitted `dxPointer`; the original default selected the sole valid rank-one Condition reference.
- P2 confirmed: `VISIT_PROCEDURE_CONCEPT_KEYS` contains 12 keys; `visitProcedureFamily` returns eye-code, em, or vision-plan.
- P3 repeated the requested `git grep` over `mcp/tests`, `mcp/src/__tests__`, and `ui/tests` for `initialPrincipalDiagnosisPointers`, `dxPointers`, and `handleVisitChargeMutationRequest`. No conflicting existing default assertion found. `visit-billing-codes.test.ts` has no ICD-10-CM-coded Condition fixtures. Additional handler calls in `procedure-charges.test.ts` at base lines 972 and 1043 use text-only diagnoses and preserve the selected pointer on replacement. `feeInterpretation.test.ts` checks interpretation snapshots. UI fixtures do not invoke the server default. Existing tests were not edited.
- P4 confirmed: KCS precedes dry-eye syndrome in seeds, and `FhirDiagnosisCatalogStore.list` retains seed order. Find dx consumes the `diagnosisCatalogRows` projection through the real quick-list handler. Legacy DiagnosisPicker actually consumes the raw catalog-list handler; its guard uses that real route's response, rather than giving it the incompatible quick-list shape (which omits `active`). Both guards passed at base; no UI product change.
- Open PRs 667, 666, 647, and 626 had no file overlap with the allowed product changes.

## Implementation

The new ledger is the only production safe list. The classifier reuses `loadDiagnosisCodeLedger` and performs exact membership. The visit handler reads Conditions through the caller client, preserves ambiguity and unclassified fallback rules, and selects by existing visit family. Explicit overrides and existing-charge replacement behavior are unchanged.

## Terminology evidence

Accessed 2026-09-26. Compared the CDC code-description text with the NLM API response: all 20 safe-list codes and the three additional guard codes agreed on code and description.

- [CDC/NCHS FY2026 code descriptions](https://stacks.cdc.gov/view/cdc/250974/cdc_250974_DS4.zip), `icd10cm_codes_2026.txt`.
- [NLM Clinical Tables H52 query](https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search?terms=H52&sf=code&df=code,name&maxList=500).
- [NLM Clinical Tables glaucoma-suspect query](https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search?terms=H40.023&sf=code&df=code,name&maxList=500).

The medical/refractive classification is the operator's billing-default ruling; the sources verify terminology, not that ruling. No CPT or HCPCS code was added.

## Rerun

From this checkout under the home directory, with locked root, MCP, and UI dependencies installed:

```sh
node docs/build-log/walkthrough-w2b/w2b-unit.mjs
node docs/build-log/walkthrough-w2b/w2b-run.mjs
```

The unit runner starts its own randomly named `odos-w2b-*` Postgres and sets `ODOS_POSTGRES_URL`, moves operator files aside when present, restores product mutations, and removes its container. UI runs use `npm --prefix ui test`.

The live runner adapts the existing W1 runner in memory, keeping its health gate, bootstrap, runtime credentials, role setup, A1 invite checks, and cleanup. `w2b-live.ts.inc` is the appended W2b proof fragment, not a standalone TypeScript module. Generated executable files and private logs stay under ignored `.odos/`. Ports 18103, 15432, 5433, and 3334 must be free. No shared services are stopped.

## Not done

- Procedure-charge default diagnosis links.
- Re-defaulting an existing visit charge when its visit code changes.
- W2a refraction suggestions.
- W3 MDM problem-status list.
- Every other W3 item.
- Independent evaluation, merge, or deployment.

No new strategy decision was made; `decisions/INDEX.md` was not changed. The accepted operator ruling is implemented here, and the new Mandate 14 ledger contains 20 rows. No cross-repository files were changed.

## Files touched

- `mcp/src/clinical-graph/protocol-endpoint.ts`: creation-only family-aware diagnosis selection.
- `mcp/src/clinical-graph/diagnosis-billing-class.ts`: ledger-backed exact classifier.
- `data/code-bindings/refractive-billing-class-ledger.json`: 20 verified code rows and operator scope.
- `mcp/src/__tests__/walkthrough-w2b.test.ts`: real-handler G1–G7 guards.
- `ui/tests/walkthroughW2bDryEye.test.tsx`: real-catalog G8 searches.
- This build-log folder: implementation plan, evidence, unit/mutation runner, and W1-derived live proof runner/fragment.

## Final author verification

G1–G9 have mutation RED and restored GREEN evidence in `GUARDS.md`. Final focused MCP: 80/80. Full UI: 1912/1912. Full MCP CI unit selection: 6175 total, 6116 passed, 0 failed, 59 skipped, exit 0. Separate live bootstrap 12/12, integration 218/218, authorization 78/78, cleanup guard 9/9. Live persisted defaults 2/2 after restoration. All three build/typecheck commands exited 0.

The first full MCP run found two registry assertions against an unused copied test-helper method; deleting that method in the new test resolved both, without changing the registry or existing assertions. All task containers were removed. `docker ps` retained only the unrelated `vf-prac1b-walk-db` container.
