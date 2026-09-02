---
memory_class: canon
authority: human-approved
auto_inject_priority: 10
---

@AGENTS.md

# Claude-specific notes

Everything above this line comes from [`AGENTS.md`](AGENTS.md), which is the **single canonical
instruction file for this repo** — Codex, Claude Code, and Cursor all work from it. Only genuinely
Claude-specific guidance belongs below.

**Do not duplicate content from `AGENTS.md` here.** If a rule applies to any agent working this
repo, it goes in `AGENTS.md` and reaches Claude through the import above. This file existing as a
hand-maintained twin is what caused the drift recorded below.

## Why this file is now an import

Until 2026-09-02, `CLAUDE.md` and `AGENTS.md` were separate hand-maintained files describing the
same repo. They drifted, and Claude Code and Codex were reading different documents. Two concrete
harms, both live at the moment of the merge:

1. **A retired security policy stayed in force here for 3.5 months.** This file still read *"No
   agent interacts with authentication flows, credential management, or account settings… no
   automated authentication flow traversal of any kind, ever."* That framing was **retired
   2026-05-13** (`performance-od/decisions/2026-05-13-security-policy-updates.md`); `AGENTS.md` was
   corrected 2026-07-16 and records the retirement in its History section. The boundary is
   credential **mutation**, not auth interaction. Claude sessions were reading the superseded ban.
2. **Stale milestone prose.** This file asserted a v0.6c/July state long after the build had moved
   on — the same rot `AGENTS.md` shed on 2026-09-02 when its hand-maintained "Current state"
   paragraph was replaced with derived sources.

The import removes the twin. There is now one file to update, and both tools read it.
