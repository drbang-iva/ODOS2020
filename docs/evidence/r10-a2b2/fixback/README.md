# Independent evaluation fixback — F1–F10

Author: Codex GPT-6, high effort. NOT EVALUATED; HELD OPEN. Base reviewed head: 9f58d5fc7a0d3cd98228d6af5e28fab53c377528. Evaluation: performance-od decisions/2026-09-16-odos-r10-a2b2-pr619-eval-needs-work.md (Opus, NEEDS-WORK).

## Changes

F1: Apply kept choice derives the atomic finding from the previous target keys, then rebuilds eye-change from its current live fact rows in searchIndex, retaining eyes.to. It uses fresh baselines and current source qualifiers. Builder errors render as the finding message. F10: conflict rows replace Offered and Choose presence with Conflicting records. F2–F9 add tests only; their production behavior is unchanged.

Five screen/test files changed: DiagnosisWorkspace.tsx, DiagnosisFindingsTable.tsx, r10DiagnosisWorkspace.test.tsx, r10DiagnosisTable.test.tsx, and diagnosisWorkspace.test.tsx (two fixture-only support additions). All evidence is under docs/evidence/r10-a2b2/. No MCP, picker, Assessment, or four section-caller edits. No existing assertion changed or removed.

## Guards

The runner applies the evaluator's E1/E2/E3/E4/E5/E6/E8/E9 replacements verbatim for W56–W63. E4's second replacement is scoped to addDiagnosis, as specified; unrelated audit-repair permission checks are not mutated. W55 switches the rebuilt rows back to previous target rows while retaining error handling, so the two refusal cases must still produce a fresh command rather than merely surface the stale-builder error. W64 restores both old labels. Each mutation is restored in finally before its green run. The runner asserts nonempty test counts, red failures, and restored success.

| Guard | Red | Restored green |
|---|---|---|
| W55 | 2 pass / 2 fail | 4 pass / 0 fail |
| W56 | 0 pass / 1 fail | 1 pass / 0 fail |
| W57 | 0 pass / 1 fail | 1 pass / 0 fail |
| W58 | 0 pass / 1 fail | 1 pass / 0 fail |
| W59 | 0 pass / 1 fail | 1 pass / 0 fail |
| W60 | 0 pass / 1 fail | 1 pass / 0 fail |
| W61 | 0 pass / 1 fail | 1 pass / 0 fail |
| W62 | 0 pass / 2 fail | 2 pass / 0 fail |
| W63 | 0 pass / 1 fail | 1 pass / 0 fail |
| W64 | 0 pass / 1 fail | 1 pass / 0 fail |

W55 has four real-workspace cases: a kept OU-to-OD shrink taking current presence/qualifiers, 409 destination-differs, 400 invalid, and a genuinely incompatible current two-eye state that must display the builder reason. The first two check new commandId, kept from/to, fresh destination baseline and current source grade; all check zero unhandled rejections. W62 exercises both signed and conflict tray rows.

Commands: `python3 docs/evidence/r10-a2b2/fixback/run-guards.py`; each subprocess runs from ui/ with `node --import tsx --test --test-name-pattern=Wnn tests/<suite>.test.tsx`. See counts.json and individual Wnn-red/green.tap files. Focused suites: workspace 20/20, table 22/22. Other affected counts are in affected-counts.json.

## Checks and limitations

Full UI: **1,681 total, 1,677 pass, 0 fail, 0 skip, 4 A3 TODO** (full-ui-counts.txt). UI build exit 0 (existing large-chunk warning), preflight 0 warnings/0 hard blocks, diff check clean. A3 gate exit 1 expected: T1–T22 open, including the UI slots. MCP/live suites were NOT rerun: no MCP file changed. Earlier MCP/live counts belong to 9f58d5fc, not this fixback head.

Both inherited CodeRabbit MCP threads remain OPEN under the operator/evaluator ruling: checker symlink containment and T17 conditionReference are valid A3 release blockers. Replies record that disposition. CodeQL's 128 missing-rate-limit alerts were independently ruled pre-existing on main c742b2e4; no dismissals or scanner changes.

## Visual check

conflict-before.png uses an isolated source snapshot of 9f58d5fc; conflict-after.png uses current source. Same synthetic fixture, Chrome 1440x1000, no auth or real patient data. Before row shows Offered / Choose presence; after shows Conflicting records; controls remain disabled; zero page errors. visual.json records the text and source-hashes.json records the after source. Both snapshots were served on verified private ports 15471/15472 and their processes stopped after capture. Prior twelve screenshots remain historical evidence; this pair supersedes the old conflict pair for F10.

No Docker container started in this fixback. The prior task container odos-r10-a2b2-postgres-1 remains stopped, not removed. Independent Opus re-evaluation is required at the final head; this is author verification only.

Final pre-push refresh: origin/main remains c742b2e4b543e0706b24f66aec6883a82f0d18a3. No rebase needed. Forbidden-file and MCP diffs are empty.

## PR-Agent follow-up: candidate-to-row association (V13 / W-d / W-e)

PR-Agent identified the contributor fallback and collection-wide rendering as allowing unrelated candidates beneath a finding row. The tray now filters each candidate by supportingFacts rowKey, preserving endpoint findingInstanceId and ordering. The tray contains fact rows; unsupported numeric/measurement picks remain on their unchanged legacy section/picker path. A new real-tray test supplies separate supports plus an unrelated no-support numeric candidate. Restoring the old association/rendering yields 0 pass/1 fail; current filter yields 1 pass/0 fail (V13-tray-red/green.tap). Two existing suggestion fixtures now include their canonical support identity; all their assertions are unchanged. Three affected suites together: 95/95. W55–W64 rerun red/green after the final correction.

The F10 screenshot pair predates this tray-only adjustment; its displayed FindingRow code is unchanged.

Final F1 shrink check: eye-change recovery retains eyes.to but never overlays the earlier target presence/grade onto current rows. A real-workspace OU-to-OD refusal/refresh reproduction failed 0 pass / 1 fail with that stale overlay and passed 1 / 0 after the correction (shrink-red/green.tap). W55 now covers four cases. The conflict screenshot remains representative; this correction affects recovery after a refused command.

CodeRabbit outside-diff finding at 9703145 (existing-suggestion link rejection): not reproduced by the implemented transport contract. mutateDiagnosisFinding delegates to send, whose catch converts fetch, header, serialization and JSON errors to a typed 502 unconfirmed command; finishLink then sets pendingLink and the linking status. load catches refresh failures. The link builder has no eye-change throws on operation link and supports are prevalidated. No generic catch added for a hypothetical programming error. The final-head review is recorded in the PR handoff.
