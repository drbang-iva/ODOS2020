# S2a sealed author bundle — REV 3

Exam content now follows a persisted encounter scope; absent scope is Comprehensive.
Office visit requires History and Assessment; rows with findings remain visible.
The permanent chart picker records actor/time and uses conditional creation/version checks.
Scheduling category, billing families/selection, and recall behavior remain independent.
All eight guards were executed red → restored green; all six proof obligations are covered below.
Author verification is complete; independent evaluation and merge are not performed.

Base: `cc707eab83bf66d97a61b574d68f4f27631c3e7b` (fresh origin/main at kickoff and resumption).
Branch: `drbang-iva/followup-s2a-exam-scope`. Exact committed head and PR URL are in the accompanying PR body/handoff; this file cannot contain its own commit hash.

## Files touched

Production: mcp/src/clinical-graph/{exam-overview-projection.ts,exam-overview-endpoint.ts,exam-scope-store.ts}; mcp/src/index.ts; ui/src/components/charting/{ExamOverviewBoard.tsx,EncounterHeader.tsx}; ui/src/scenes/EncounterCharting.tsx.

Tests: mcp/tests/{examOverviewProjection.test.ts,examOverviewEndpoint.test.ts,examScopeStore.test.ts,r10-parity.test.ts,r10A3Overview.test.ts,visitTypeResolver.test.ts}; ui/tests/{examOverviewBoard.test.tsx,findingSectionGroups.test.tsx}.

Inventory coordinate only: scripts/fhir-read-grant-check.ts. Evidence: docs/build-log/followup-s2a-exam-scope/**. All changes are within §4 plus REV 3. See [assertion migration](assertion-migration.md) for each changed pre-existing assertion and its replacement, and the canon sentences the kickoff author must repair at merge.

## P1–P7 re-verification at the base

| Premise | Observed at origin/main cc707eab |
| --- | --- |
| P1 | One `exams` policy, six required sections; category lookup; unmatched → empty sections/unconfigured. |
| P2 | Endpoint imports/calls resolveVisitTypeCategoryForEncounter and passes category into projection. |
| P3 | Fixed six worksheet rows; optional/trace/finding visibility predicate; both old visit-type strings; category in type/guard. |
| P4 | Header receives completeness; absent projection falls back to whole-inventory SpineNav. |
| P5 | FhirEncounterSectionOverrideStore uses one encounter Basic and version-guarded edits. S2a follows that storage pattern and adds conditional-first-create conflict handling. |
| P6 | isEyeExamVisit and clinic-summary resolver remain category consumers; neither changed. |
| P7 | Three named overview test files cover affected boundaries. REV 3 authorizes the five additional adaptations discovered by the full suite. |

## Guards and proof 1–6

[G1–G8 quoted red and restored-green summaries](guards.md), with failing test names and commands. G1/G2/G3/G7 server restorations: 47/47; G4/G5/G6/G8 UI restorations: 108/108. Extra persistence guards demonstrate version-conflict and conditional-create loser rejection. No assertion merely disappears.

Real disposable Medplum/odos-core/UI stack; synthetic patient/provider; 1440 × 1100 Chrome viewport; separate base checkout for before captures. Screenshots inspected after capture.

1. Base non-exams category: [01-before-medical.png](01-before-medical.png), near-empty board. Base exams category: [02-before-exams.png](02-before-exams.png), full frame.
2. Same non-exams encounter without scope record: [03-after-medical-default.png](03-after-medical-default.png), full Comprehensive board.
3. [04-office-visit.png](04-office-visit.png): History/Assessment. [05-comprehensive-restored.png](05-comprehensive-restored.png): full board restored.
4. Charted OD IOP 18 in Office visit, then Comprehensive → Office visit; exact overview findings and selected visit-charge response remain equal across both switches. [06-office-finding.png](06-office-finding.png), [07-retained-and-scope-trace.png](07-retained-and-scope-trace.png). Repeated harness runs leave repeated synthetic observations visible; this is not an unmatched/carried-finding repair.
5. Scope wording and count 0 of 2 in [07](07-retained-and-scope-trace.png). [08-billing-unchanged.png](08-billing-unchanged.png) shows selected visit code; browser assertions enumerate every option and confirm E/M, eye-code and vision-plan families remain available, selected code unchanged. Selecting a different billing code leaves exact scope and findings unchanged. Live stale-version PUT → 409, invalid scope → 400, missing credentials GET → 401; no scope change on refusal. [Browser summary](proof/browser-final.txt).
6. Full suites below. [Build summary](proof/builds-final.txt). [Grant check](proof/rev3-grants.txt): only shifted coordinate, no new exemption.

## Full-suite summaries

| Command | Before | Final after |
| --- | --- | --- |
| npm --prefix mcp test | 6,087 total; 6,032 pass; 0 fail; 55 skip | 6,097 total; 6,042 pass; 0 fail; 55 skip |
| npm --prefix ui test | 1,762 pass; 0 fail; 0 skip | 1,770 pass; 0 fail; 0 skip |

MCP database tests use an isolated `s2a_suite` database, separate from synthetic Medplum. The baseline MCP wrapper exited 1 because 47 live tests were unconfigured; final explicitly uses `ODOS_ALLOW_UNGATED_MCP=1`, exits 0 for executed tests, and does **not** claim broad live authorization coverage. All 55 skips are retained; dedicated S2a served-route proof supplements the suite. Summaries: [before MCP](proof/mcp-before-db.txt), [after MCP](proof/mcp-final.txt), [before UI](proof/ui-before.txt), [after UI](proof/ui-final.txt). REV 3 targeted server checks: 221 passed, zero failed. Earlier interrupted counts remain historical in BLOCKED.md.

## Scope and follow-ups

Acceptance built: BD-1, BD-9, B-1/B-2/B-3; BD-3 except shelf; BD-10 counter/copy only. **Not built here:** BD-2 and BD-10 profile clause (S3); BD-4/BD-5/BD-6/BD-7 (S2b); BD-8 (S5). No profiles, shelf, search, three-state behavior, census, unmatched finding repair, carried-finding display repair, board group pull-in, or recall changes.

Additional category consumer search found patient-overview eye-exam filtering and annual recall via isEyeExamVisit; neither decides this board's exam content and neither changed. The enforced G7 check prevents this projection path from using the category again.

No new clinical codes, external FHIR artifact URLs, or regulatory claims introduced; no Mandate 14 ledger rows required. No performance-od files or decisions/INDEX.md edited. Kickoff author owns the documented canon repair at merge (Mandate 17 check 3).

Only odos-s2a-proof app processes and containers were stopped. Final command `docker ps --filter name=odos-s2a- --format 'table {{.Names}}\t{{.Status}}'`:

```text
NAMES     STATUS
```

See [cleanup output](proof/docker-ps-final.txt). Volumes retained; no other task's stack touched.

⚠️ NOT EVALUATED — hand to Claude Opus 5 for independent evaluation of the exact PR head. Codex wrote this slice and cannot judge it. No merge or deployment performed.

needs-review
