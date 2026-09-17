# R10 A2b.2 — round 2 fixback F11–F13

**NOT EVALUATED · HELD OPEN · NEVER MERGE.** Codex GPT-6, high effort. Independent Opus verdict at b5376689 was NEEDS-WORK. This round merges both-eye suggestions per diagnosis, sends the merged supports, and restricts scope to the supports' eye union. The PR body receives the standalone Coded-by line; exact-head verification and bot states belong in the final handoff.

Changed this round: DiagnosisFindingsTable.tsx, DiagnosisWorkspace.tsx; r10DiagnosisTable.test.tsx, r10DiagnosisWorkspace.test.tsx; evidence under this directory and PR body. No MCP or prohibited component change. Four new cases; no pre-existing assertion change. No new decision or medical-code binding.

Full UI: **1685 total / 1681 pass / 0 fail / 0 skipped / 4 A3 TODO**. Affected suites: workspace 53/53; LinkL2 4/4; LinkL3 7/7; grouping 2/2; carry 15/15; demotion 11/11; R10 workspace 22/22; R10 table 24/24; surfaces 5 pass / 4 TODO. UI build exit 0; preflight exit 0 with 0 warnings/0 hard blocks; diff check clean. MCP suite was not rerun because no mcp/ file changed. A3 checker remains exit 1 expected.

W88 red **1 pass / 1 fail** → green **2 / 0**; W89 red **0 / 2** → green **2 / 0**. W55–W64 re-demonstrated red/green and all 14 restored tests pass. [Round 2 sealed evidence](round2/README.md) contains the exact TAP/counts, mutation runner, source hashes and synthetic before/after capture. Two MCP/A3 bot threads remain open by ruling, CodeQL alerts unchanged, independent exact-head evaluation still required. No Docker started this round; temporary Vite capture servers stopped.

---

## Round 1 historical evidence

# R10 A2b.2 — independent evaluation fixback

**NOT EVALUATED · HELD OPEN · NEVER MERGE.** Codex GPT-6, high effort. The prior head 9f58d5fc received Opus NEEDS-WORK. This fixback addresses F1–F10; the new head requires independent re-evaluation.

Apply kept choice now rebuilds an eye change from current live finding rows, keeps the requested eyes, uses fresh baselines and shows builder errors. Conflict rows say Conflicting records in place of Offered/Choose presence. Eight previously unguarded rules now have mutation-sensitive tests. A subsequent PR-Agent finding also corrected tray suggestions to associate each candidate through supportingFacts, not shared contributor references; V13/W-d/W-e guard is recorded. Legacy measurement picking is unchanged.

Changed files: ui/src/components/charting/DiagnosisWorkspace.tsx; ui/src/components/charting/DiagnosisFindingsTable.tsx; ui/tests/r10DiagnosisWorkspace.test.tsx; ui/tests/r10DiagnosisTable.test.tsx; ui/tests/diagnosisWorkspace.test.tsx (fixture-only); evidence under docs/evidence/r10-a2b2/. No forbidden source or MCP edits. No existing assertion changed; mapping is in existing-assertions.md.

[Fixback sealed evidence](fixback/README.md) contains W55–W64 red/green counts, the exact mutation runner, per-suite results, expected-red A3 output, and an updated conflict screenshot pair. Focused workspace 20/20, table 22/22; full UI: **1,681 total, 1,677 pass, 0 fail, 0 skip, 4 A3 TODO** (fixback/full-ui-counts.txt). UI build and preflight pass; A3 exit 1 expected. MCP and live suites were not rerun because no MCP file changed.

The two inherited MCP review threads remain OPEN as explicitly ruled A3 release blockers. CodeQL rate-limit alerts were independently classified as pre-existing; no action or dismissal in this slice. Final-head bot states and SHA are recorded in the PR body/handoff to avoid staling review with a reporting-only commit. No Docker started in the fixback; the prior odos-r10-a2b2-postgres-1 remains stopped, not removed.

---

## Original build evidence (historical; counts below belong to 9f58d5fc)

### Original author bundle

**NOT EVALUATED · HELD OPEN · never merge independently of the R10 joint release.** Coder: Codex, GPT-6, high effort. Independent evaluation belongs to Claude Opus; this bundle is author evidence only.

## Summary and scope

Diagnosis screens consume the shared finding record: per-eye commands and OU grouping, typed outcomes and identical retries, conflict recovery, unavailable states, audit repair, origin lines from homeSources, and workspace pick/bodySite/link recovery. The legacy picker and Assessment source are unchanged; only Workspace uses submitDiagnosisPickResult. Rev 3.6 removes the unused linkMode prop.

Contract: performance-od kickoff rev 3.6 §§3.10/12. Original base: evaluated A2b.1 `6025d836643fdf74298834f8290a8fdacabef5b7`. Rebased onto main `c742b2e4b543e0706b24f66aec6883a82f0d18a3`; refreshed A2b.1 still 6025d836. All §12.1 premises were checked before implementation, including unchanged UI since 6f44c050, payloads/unions, four legacy picker callers, workspace origins/early return, absent A3 UI slots, and the actual UI test command. Shared checkouts were only read/fetched.

Six allowed production files: ui/src/lib/{diagnosis-findings,clinical-graph-client}.ts; ui/src/components/charting/{DiagnosisFindingsTable,DiagnosisWorkspace,EncounterFindingOverlay}.tsx; ui/src/scenes/EncounterCharting.tsx (unassigned unavailable count only). Tests: diagnosisWorkspace, diagnosisCarryForward, diagnosisFindingGrouping, diagnosisDemotionImpact; new r10DiagnosisWorkspace, r10DiagnosisTable, r10DiagnosisSurfaces and r10A3ReleaseScenarios. Evidence is confined to docs/evidence/r10-a2b2/. No MCP implementation delta, Assessment or structure-section edits. The main-target PR necessarily inherits A2b.1 server commits; the A2b.2 source/test delta is limited to this inventory.

## Checks and assertions

- Original six door suites: 91 pass, 0 fail.
- Full UI after rev 3.6: see checks/ui-rev36-counts.txt (1666 total, 1662 pass, 0 fail, 0 skipped, 4 A3 TODO).
- Full MCP after rebase with fresh root/MCP dependencies and isolated synthetic PostgreSQL16: **5687 total, 5618 pass, 0 fail, 53 named environment skips, 16 A3 TODO**. MEDPLUM_PROJECT_ID and Medplum credentials unset; ODOS_ALLOW_UNGATED_MCP=1 acknowledges missing live Medplum credentials. This is not live-authz proof. Setup: disposable odos-r10-a2b2-postgres-1 on loopback port 29543; no shared database.
- Affected suites: Workspace 53/53; LinkL2 4/4; LinkL3 7/7; grouping 2/2; carry 15/15; demotion 11/11; new workspace 11/11; table 16/16; surfaces 5 pass + 4 A3 TODO. Exact machine-readable counts: checks/affected-counts.json.
- UI/MCP builds exit 0; UI retains its existing large-chunk warning. Preflight: 0 warnings, 0 hard blocks. git diff --check clean.
- check-r10-a3-release.mjs exits **1, expected**: T1–T22 remain open. T15/T16/T17 UI/T18 are now real component TODO tests; A3's other UI slots remain absent. See checks/a3-rev36.txt for exact output.
- Every changed existing assertion has before/after and V/W mapping in [existing-assertions.md](existing-assertions.md). No tests removed or skipped. W54 is a new failure test in an existing suite.

## Mutation proof

[guard-index.md](guard-index.md) inventories every required guard: W3/W9/W36/W37/W46–W54, with red counts and restored green evidence. W51: real Ocular Health and Cup/Disc legacy picker requests mutated to the result API plus supports → **0 pass, 2 fail**; restored **2/2**. W54: legacy API made nonthrowing → **0 pass, 1 fail**, plus tsc exit 2 at Assessment353 and Picker158; restored **1/1**, tsc exit 0. All mutations restored. The historical generic-picker-error W49 proof is superseded by rev 3.6; the final candidate failure guard is Workspace W49.

## Visual evidence and limits

Twelve screenshots in visual/: ou-before/after, conflict-before/after, prebuild-before/after, unavailable-before/after, partial-before/after, audit-before/after. Source hashes and capture assertions are recorded there. These are real rendered React components with synthetic transport, not a deployed route walkthrough or persistence/authz proof. Rev 3.6 restores the unused legacy Picker; none of the six screenshot scenarios mounts it, so these captures remain representative of the changed surfaces.

## Risks and follow-ups

Audit authenticity remains A2b.1's separately scoped release blocker. A3 consumer migration and T1–T22 remain deliberately open; four UI TODO failures are intentional. Real role policy and clinical persistence are outside these UI transport fixtures; A2b.1's independent live evidence is inherited, not rerun or claimed here. No medical codes or regulatory facts introduced; no new Mandate 14 ledger rows or strategy decisions required.

## Delivery status

Author checks complete; PR publication and final-head bot adjudication are tracked in the PR body and handoff. NOT EVALUATED until independent Opus review. Never merge this held-open slice.

Docker project prefix: odos-r10-a2b2. Only container started: odos-r10-a2b2-postgres-1. Stopped, not removed. Visual Vite processes were also stopped.
