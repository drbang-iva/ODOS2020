# Independent evaluation fixback — F1–F10

Author: Codex GPT-6, high effort. NOT EVALUATED; HELD OPEN. Base reviewed head: 9f58d5fc7a0d3cd98228d6af5e28fab53c377528. Evaluation: performance-od decisions/2026-09-16-odos-r10-a2b2-pr619-eval-needs-work.md (Opus, NEEDS-WORK).

## Changes

F1: Apply kept choice derives the atomic finding from the previous target keys, then rebuilds eye-change from its current live fact rows in searchIndex, retaining eyes.to. It uses fresh baselines and current source qualifiers. Builder errors render as the finding message. F10: conflict rows replace Offered and Choose presence with Conflicting records. F2–F9 add tests only; their production behavior is unchanged.

Only four screen/test files changed: DiagnosisWorkspace.tsx, DiagnosisFindingsTable.tsx, r10DiagnosisWorkspace.test.tsx and r10DiagnosisTable.test.tsx. All evidence is under docs/evidence/r10-a2b2/. No MCP, picker, Assessment, or four section-caller edits. No existing assertion changed or removed.

## Guards

The runner applies the evaluator's E1/E2/E3/E4/E5/E6/E8/E9 replacements verbatim for W56–W63. E4's second replacement is scoped to addDiagnosis, as specified; unrelated audit-repair permission checks are not mutated. W55 switches the rebuilt rows back to previous target rows while retaining error handling, so the two refusal cases must still produce a fresh command rather than merely surface the stale-builder error. W64 restores both old labels. Each mutation is restored in finally before its green run. The runner asserts nonempty test counts, red failures, and restored success.

| Guard | Red | Restored green |
|---|---|---|
| W55 | 1 pass / 2 fail | 3 pass / 0 fail |
| W56 | 0 pass / 1 fail | 1 pass / 0 fail |
| W57 | 0 pass / 1 fail | 1 pass / 0 fail |
| W58 | 0 pass / 1 fail | 1 pass / 0 fail |
| W59 | 0 pass / 1 fail | 1 pass / 0 fail |
| W60 | 0 pass / 1 fail | 1 pass / 0 fail |
| W61 | 0 pass / 1 fail | 1 pass / 0 fail |
| W62 | 0 pass / 2 fail | 2 pass / 0 fail |
| W63 | 0 pass / 1 fail | 1 pass / 0 fail |
| W64 | 0 pass / 1 fail | 1 pass / 0 fail |

W55 has three real-workspace cases: 409 destination-differs, 400 invalid, and a genuinely incompatible current two-eye state that must display the builder reason. The first two check new commandId, kept from/to, fresh destination baseline and current source grade; all check zero unhandled rejections. W62 exercises both signed and conflict tray rows.

Commands: `python3 docs/evidence/r10-a2b2/fixback/run-guards.py`; each subprocess runs from ui/ with `node --import tsx --test --test-name-pattern=Wnn tests/<suite>.test.tsx`. See counts.json and individual Wnn-red/green.tap files. Focused suites: workspace 19/19, table 21/21. Other affected counts are in affected-counts.json.

## Checks and limitations

Full UI: **1,679 total, 1,675 pass, 0 fail, 0 skip, 4 A3 TODO** (full-ui-counts.txt). UI build exit 0 (existing large-chunk warning), preflight 0 warnings/0 hard blocks, diff check clean. A3 gate exit 1 expected: T1–T22 open, including the UI slots. MCP/live suites were NOT rerun: no MCP file changed. Earlier MCP/live counts belong to 9f58d5fc, not this fixback head.

Both inherited CodeRabbit MCP threads remain OPEN under the operator/evaluator ruling: checker symlink containment and T17 conditionReference are valid A3 release blockers. Replies record that disposition. CodeQL's 128 missing-rate-limit alerts were independently ruled pre-existing on main c742b2e4; no dismissals or scanner changes.

## Visual check

conflict-before.png uses an isolated source snapshot of 9f58d5fc; conflict-after.png uses current source. Same synthetic fixture, Chrome 1440x1000, no auth or real patient data. Before row shows Offered / Choose presence; after shows Conflicting records; controls remain disabled; zero page errors. visual.json records the text and source-hashes.json records the after source. Both snapshots were served on verified private ports 15471/15472 and their processes stopped after capture. Prior twelve screenshots remain historical evidence; this pair supersedes the old conflict pair for F10.

No Docker container started in this fixback. The prior task container odos-r10-a2b2-postgres-1 remains stopped, not removed. Independent Opus re-evaluation is required at the final head; this is author verification only.

Final pre-push refresh: origin/main remains c742b2e4b543e0706b24f66aec6883a82f0d18a3. No rebase needed. Forbidden-file and MCP diffs are empty.
