# Plan application shared ownership — author evidence

**Follow-up:** Opus 5 returned NEEDS-WORK at `d864523e`. The local repair and its final checks are recorded in [the fixback bundle](FIXBACK.md); independent re-evaluation is pending. The original evidence below is retained for provenance.

Status: locally committed implementation, author verification complete; **NOT independently evaluated**.

Implementation head: `117da014`. No push or PR was created. Independent evaluation by Fable/Opus (high) remains required before merge.

Base: `02cdf89e0b964cb442bd42287c86435102fcccc9` (fetched before work).
Integration branch: `drbang-iva/plan-shared`.
No push, PR, merge or deployment is part of this task.

## Baseline actually executed

`ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test`

```text
# tests 4926
# pass 4857
# fail 6
# cancelled 0
# skipped 63
# duration_ms 76415.434542
```

Exit 1. All six failures are PostgreSQL `ECONNREFUSED 127.0.0.1:5433` from `mcp/tests/claimReadModelStore.test.ts`:

- rebuild is atomic and server-side worklist grouping returns honest untouched facts
- never-paid-untouched aggregation is performed by payer and month in PostgreSQL
- reconciliation detects a corrupted money row and a rebuild restores exact FHIR-derived truth
- an older per-claim upsert cannot overwrite a newer completed rebuild
- an older rebuild snapshot fails loudly without publishing incomplete FHIR truth
- the file's after-hook (reported as the file path)

The harness explicitly reports that live-stack authorization is not gated. Of 63 total skips, it records 43 as missing live-stack configuration. No live authorization result is claimed.

Baseline MCP build, UI build and preflight all exit 0. Preflight: 0 warnings, 0 hard blocks. UI build has existing bundle-size warnings. Proxy census: 25 backend route families, 28 proxy entries, all families covered; the census is advisory.

## Approved #599 assertion changes

1. Baseline line 807: whole-plan open after item add changes from rejection to success.
2. Baseline lines 824–856: cross-plan tap changes from one application and replacement after undo to two applications, surviving original record IDs on the dependent item application, and already-added on re-tap.
3. Baseline lines 760–788: application count changes from one to two; the second is active, confirmed, scope item, with action/charge dependency references. Existing owning-application return, `alreadyApplied: true`, one action and one charge remain.

The TypeScript AST preservation check compared the exact source bodies of all 24 tests introduced or modified in #599: **21 identical, exactly the three approved changes, zero unexpected changes**. Same-plan repeat, same-plan whole-then-tap and the endpoint application-count test are unchanged. See `pr599-test-preservation.json`.

Three older, pre-#599 tests also changed: late-partial-failure retry and no-merge-key retry now assert rollback/retry behavior; application-list hydration now includes scope/actions. These are separate from the three approved #599 changes.

## Scope limits

- Protocol staging models one unit per concept per encounter. Multi-unit same-concept protocol charges are not modeled.
- Manual, visit and series charge writers remain outside the protocol dedupe rule.
- Charge diagnosis pointers remain clinician-reviewed billing data and are not changed when action diagnoses are shared.
- Encounter serialization is in-process. Cross-process arbitration remains a follow-up before multiple server processes are deployed.
- No clinical terminology, FHIR artifact URL or regulatory citation is added by this slice; no new Mandate 14 ledger row is required for those values.
- Product decisions were supplied by the operator in the companion repository; this file records implementation evidence, not a new decision.

## Result

Cross-plan taps retain a confirmed active item application and dependency references while returning the existing owner. Undo re-homes the original order and charge to the earliest active dependent. Repeated live dependencies are idempotent; dead dependencies permit a fresh add. Charge dedupe uses encounter and concept, including manual and inactive-owner records. Shared action diagnoses are appended without rewriting charge diagnosis pointers.

Whole-plan application remains available after an item application. A shared scope normalizer drives backend guards and UI badges/undo targets. Follow-up conflicts choose the sooner interval and retain alternatives requiring confirmation; confirm/edit clears that advisory flag.

Encounter operations serialize in-process. Conditional application writes and rollback restore original FHIR record IDs and statuses after failed undo. Author-team review found two rollback defects and UI undo/confirmation defects; all were repaired and regression-checked. This is author QA, not independent evaluation.

## Final executed checks

At implementation head `117da014`, after all integration fixes:

| Command | Actual result |
| --- | --- |
| `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` | 4,960 tests; 4,891 pass; 6 fail; 63 skipped; 0 cancelled; exit 1; 66,582 ms |
| `npm --prefix mcp run build` | exit 0 |
| `npm --prefix ui run build` | exit 0; existing chunk-size warning |
| `npm run preflight` | exit 0; 0 warnings, 0 hard blocks |
| `node --import tsx --test mcp/src/__tests__/protocol-phase5.test.ts mcp/tests/dryEyeProtocols.test.ts mcp/tests/dryEyeInitiationProtocols.test.ts mcp/tests/procedureChargeMaterialization.test.ts` | 147 pass, 0 fail, 0 skipped |
| From `ui`: `node --import tsx --test tests/protocolScope.test.tsx tests/protocolAuthoring.test.tsx` | 15 pass, 0 fail, 0 skipped |
| `node .claude/skills/tier0-census/scripts/check-proxy-coverage.mjs` | 25 families, 28 entries; every family covered; advisory |
| `git diff --check` | exit 0 |

Final full-suite failures are exactly the same six PostgreSQL failures listed in the baseline, with no additional failures. Raw final output is retained locally in `/tmp/plan-shared-final-mcp.log`, `/tmp/plan-shared-final-focused.log`, `/tmp/plan-shared-final-ui.log`, `/tmp/plan-shared-final-build.log`, `/tmp/plan-shared-final-ui-build.log`, and `/tmp/plan-shared-final-preflight.log`.

The first integrated run exposed 11 additional failures: six stale source-line inventory entries, two dry-eye fake-version failures, two materialization fake-version failures, and one route-count assertion. Integration fixes teach the synthetic FHIR stores version/If-Match semantics and update exact inventories; they do not widen permissions. Their focused run passed 42 tests. Disabling If-Match produced two failures; deleting the inventory entries produced three failures; restoration returned all 42 to green.

## Mandate 17 replay

Run `python3 mcp/scripts/verify-protocol-sharing.py <evidence-directory>` from this checkout. It refuses modified source, records source hashes and exact commands, and restores source in `finally`. The committed `mutations.json` is the final integration replay, not a predicted result.

| Mutation | RED failures | Restored GREEN passes |
| --- | ---: | ---: |
| skip-item-dependency | 2 | 2 |
| skip-action-liveness | 1 | 1 |
| application-charge-dedupe | 2 | 2 |
| active-owner-only | 1 | 1 |
| skip-rehome | 2 | 2 |
| skip-charge-liveness | 1 | 1 |
| old-open-guard | 1 | 1 |
| old-route-guard | 1 | 1 |
| drop-encounter-lock | 1 | 1 |
| drop-alternatives | 1 | 1 |

Every mutant exited 1 and every restored run exited 0, with no cancelled tests. `skip-item-dependency` returns before recording the dependent application: both approved cross-plan tests fail, satisfying the requested controls for baseline 760 and 824. `old-open-guard` reverses the approved baseline-807 behavior and fails.

Additional rollback controls produced three service failures and two real endpoint-handler failures before restoration, then 3/3 and 2/2 passes. The endpoint harness verifies the original projection collection and IDs after failure. An opted-out finding rollback regression failed before repair and passed afterward. UI mutations and red/green fixback evidence are in [UI evidence](../plan-shared-ui/README.md).

## Files and commits

All changed paths relative to this worktree:

- `docs/build-log/plan-shared-ui/README.md`
- `docs/build-log/plan-shared-ui/components-after.png`
- `mcp/scripts/verify-protocol-sharing.py`
- `mcp/src/__tests__/protocol-phase5.test.ts`
- `mcp/src/clinical-graph/protocol-endpoint.ts`
- `mcp/src/clinical-graph/protocol-service.ts`
- `mcp/src/clinical-graph/protocol-types.ts`
- `mcp/src/index.ts`
- `mcp/tests/dryEyeProtocols.test.ts`
- `mcp/tests/findingDefinitionStore.test.ts`
- `mcp/tests/procedureChargeMaterialization.test.ts`
- `scripts/fhir-read-grant-check.ts`
- `src/protocol-application-scope.ts`
- `ui/src/components/charting/AssessmentSection.tsx`
- `ui/src/components/charting/ProtocolApplicationStatus.tsx`
- `ui/tests/protocolScope.test.tsx`
- `docs/build-log/plan-shared-ownership/README.md`
- `docs/build-log/plan-shared-ownership/mutations.json`
- `docs/build-log/plan-shared-ownership/pr599-test-preservation.json`

Local implementation commits:

```text
399ff7c7 Show protocol application scope and follow-up review
f1a6aba5 Share protocol application scope normalization
5e714340 Match protocol controls to chart styling
f60157c3 Clarify synthetic protocol verification evidence
41b0515b Keep unmatched plan undo and follow-up confirmation clear
b3fc145e Preserve shared protocol orders and charges across undo
c610d5a3 Record replayable protocol ownership mutation checks
59bc578a Restore projections and opted-out findings after rollback
fb01097b Restore original FHIR projections when protocol undo fails
117da014 Align protocol integration fakes and route inventories
```

## Remaining limits and handoff

- A deliberate charge opt-out with no existing charge stays opted out on the dependent application; sharing does not create an unwanted charge.
- UI evidence is a synthetic component screenshot and mounted-component checks, not a full application walkthrough. See [screenshot](../plan-shared-ui/components-after.png). The task-owned Vite server and Chromium were stopped.
- No item-tap frontend existed at the pinned base. This slice displays persisted item applications; it does not introduce a new tap surface.
- Real Medplum persistence and AccessPolicy enforcement were not exercised. Service and real route-handler checks use synthetic FHIR. No Done/sign UI action was executed; follow-up confirmation remains advisory in backend cleanup checks.
- No Docker stack was started. No push, PR, merge or deployment was performed.
- `decisions/INDEX.md` is unchanged: operator-supplied decisions already live in the companion repository. No new decision or Mandate 14 value was authored; ledger rows added: zero.
- Cross-repo follow-up: use this bundle with the existing slice-1a/design handoff, then obtain an exact-head independent Fable/Opus (high) evaluation. Author verification does not satisfy that gate.
