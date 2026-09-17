# R10 A3.2 active progress

Author: Codex GPT-6, high effort. NOT EVALUATED. HELD OPEN; never merge.

Base: a211b36887b49139ab29cf2d811a5a30f261034d. Branch: drbang-iva/r10-a3-2.
Implementation commits: 3eaba076951d86562fe1287044f3485b0f480703 and f9e4bc0f (closed-encounter shared label).

Both published §13 scope rulings are implemented: unchanged read-only loaded witnesses and extraction-only DiagnosisWorkspace. BLOCKED.md and RESUME-BUNDLE.md are historical snapshots, not current status.

- W147: five tests; both required mutants fail, restored pass. Scoped MCP 92/92.
- Workspace assertions unchanged, 22/22; shared-helper mutation fails both workspace and picker, restored green.
- W130–W146 mutation evidence is in editor, picker, carry, void-undo, and harness directories.
- Prior full UI: 1,727 passed, zero failures/skips/todos. A new W134 closed-label guard passed after failing first; full UI is rerunning for the extra test.
- Carry integration: 25/25, including remount recovery and confirmed-change refresh.
- Credentialed live authorization: 73/73, zero failures/skips; existing lifecycle Provenance limitation documented separately.
- Strict release checker reports PASS for T1–T22.
- MCP CI-equivalent raw command: 5,952 passed, zero failed, 53 skipped, exit 0 across 423 files. The prior npm wrapper still correctly exits 1 for ungated live skips; separate live lane is 73/73.
- Served-route (a) passes at exact #619 head: diagnosis OU creates two canonical records absent from the old OH editor. Remaining steps are in progress. Harness runtime authorization, source boundary lint and synthetic project quota are repaired.
- PR, CI, terminal bot review, final sealed bundle and container shutdown remain outstanding.

Only synthetic disposable containers with prefix odos-r10-a3-2-served belong to this task. Preserve them until live proof completes, then stop without removing them.
