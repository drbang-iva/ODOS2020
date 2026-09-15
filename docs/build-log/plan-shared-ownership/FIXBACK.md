# Slice 1b follow-up fixback — sealed author bundle

Status: local fixback complete; **needs independent re-evaluation**. Opus 5 evaluated `d864523e` as NEEDS-WORK. These author checks do not supersede that verdict.

Branch: `drbang-iva/plan-shared`.
Implementation commit: `3f763ce7`.
The worktree was clean at exactly `d864523ef44c1f7200ac969892fc3d8533fa656b` before editing. The cited clash, undo, dependent sort and under-lock duplicate check were re-read at that head. No push, PR, merge or deployment was performed. No test stack was started.

## Summary

- Clinician-owned follow-ups retain interval, unit, reason, state, modified fields and provenance during a plan clash. Ownership is recognized by either modified state or clinician-entered provenance. Alternatives show the current value as the doctor's choice with its actor, plus the incoming plan's recommendation and application ID. The rail renders the clinician entry as **your change**.
- Plan alternatives carry contributing application IDs. Owner or dependent undo, for whole or item applications, removes that application's recommendations from live encounter follow-ups under the encounter lock. Remaining plan recommendations select the soonest due date; confirmation state clears when the specified remaining-entry threshold is met. Clinician-owned values remain unchanged.
- Changed interval/unit/reason re-materializes the follow-up ServiceRequest. Failed undo restores both the action and its ServiceRequest in the existing rollback path, including changes to a follow-up owned by another application.
- New guards exercise three distinct appliedAt times and two concurrent whole commits. Reversing the dependent ordering or disabling the under-lock duplicate check now fails a test.

## Files touched by this fixback

- `mcp/src/clinical-graph/protocol-service.ts` — clinician preservation, application-tagged alternatives, undo cleanup and projection rollback.
- `mcp/src/__tests__/protocol-phase5.test.ts` — twelve added regressions/guards; existing test bodies unchanged.
- `ui/src/components/charting/ProtocolApplicationStatus.tsx` — clinician alternative shape and your-change label.
- `ui/tests/protocolScope.test.tsx` — rendered clinician-label regression.
- `mcp/scripts/verify-protocol-sharing.py` — four added mutation controls, alongside the original ten.
- `docs/build-log/plan-shared-ownership/README.md` — pointer to this follow-up bundle.
- `docs/build-log/plan-shared-ownership/FIXBACK.md` — this evidence.
- `docs/build-log/plan-shared-ownership/fixback-mutations.json` — exact replay commands, source hashes and counts.

## Executed verification

| Command | Actual output |
| --- | --- |
| `node --import tsx --test mcp/src/__tests__/protocol-phase5.test.ts mcp/tests/dryEyeProtocols.test.ts mcp/tests/dryEyeInitiationProtocols.test.ts mcp/tests/procedureChargeMaterialization.test.ts` | 159 tests, 159 pass, 0 fail, 0 skipped, exit 0 |
| From `ui`: `node --import tsx --test tests/protocolScope.test.tsx tests/protocolAuthoring.test.tsx` | 16 tests, 16 pass, 0 fail, 0 skipped, exit 0 |
| `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` | 4,972 tests, 4,903 pass, 6 fail, 63 skipped, 0 cancelled; exit 1; 66,952 ms |
| `npm --prefix mcp run build` | exit 0, TypeScript clean |
| `npm --prefix ui run build` | exit 0, existing chunk-size warning |
| `npm run preflight` | exit 0; 0 warnings, 0 hard blocks |
| `git diff --check` | exit 0 |

The six full-suite failures remain confined to `mcp/tests/claimReadModelStore.test.ts`, PostgreSQL connection refused at `127.0.0.1:5433`:

1. rebuild is atomic and server-side worklist grouping returns honest untouched facts
2. never-paid-untouched aggregation is performed by payer and month in PostgreSQL
3. reconciliation detects a corrupted money row and a rebuild restores exact FHIR-derived truth
4. an older per-claim upsert cannot overwrite a newer completed rebuild
5. an older rebuild snapshot fails loudly without publishing incomplete FHIR truth
6. file after-hook, reported as the file path

The #599 AST preservation check still reports 24 tests, 21 unchanged from the original base and only the three previously approved changes. This fixback appends tests; it changes none of those bodies.

## RED / GREEN evidence

Before the implementation, the new focused backend checks reported **2 pass, 10 fail**: the follow-up regressions failed and both existing guards passed. The UI label check failed, rendering `12 months (undefined)` instead of `12 months (your change)`. After implementation, the focused suites above passed.

The failed-undo regression observes the ServiceRequest changing from three to six months before injecting a failure after the action write. It then compares the restored action and original ServiceRequest collection, including original IDs, dates, reasons and statuses.

Replay: `python3 mcp/scripts/verify-protocol-sharing.py <evidence-directory>`. All 14 controls executed against the committed fixback source, with source restored after each. Every RED exited 1; every restored GREEN exited 0; no cancellations.

| Mutation | RED failures | Restored GREEN passes |
| --- | ---: | ---: |
| overwrite-clinician-follow-up | 3 | 3 |
| retain-undone-recommendation | 6 | 6 |
| reverse-dependent-order | 1 | 1 |
| skip-under-lock-whole-check | 1 | 1 |
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

The first four controls directly address this evaluation: overwrite clinician choice, retain undone recommendation, reverse earliest-dependent selection, and skip the under-lock whole duplicate check. The other ten retain the original slice's mutation coverage. Detailed machine-readable evidence is in `fixback-mutations.json`.

Raw logs are local at `/tmp/plan-fixback-{red,green,protocol,ui-red,ui-green,full-mcp,mcp-build,ui-build,preflight,mutations}.log`; per-mutation RED/GREEN logs are retained in `.superpowers/sdd/pasted-text.txt/fixback-mutations/` in this worktree.

## Limits and follow-ups

- Service tests use the real ProtocolService and real follow-up ServiceRequest materializer with synthetic FHIR storage. UI evidence is a rendered React component assertion. No live Medplum/AccessPolicy result or browser walkthrough is claimed. The full suite skips 43 live-stack checks among its 63 skips.
- The evaluator-carried exclusions remain untouched: linkedDx after shared-order undo, cross-plan charge-seed disposition, crash mid-undo, and cross-process arbitration.
- No new medical terminology value or regulatory reference was introduced; Mandate 14 ledger rows added: zero. No new design decision was authored; companion `decisions/INDEX.md` unchanged.
- Hand the final local head and this bundle to Fable/Opus (high) for independent re-evaluation. The author cannot issue a PASS marker.
