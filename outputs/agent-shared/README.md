# outputs/agent-shared/ — fleet shared whiteboard

**What this is:** a per-repo shared whiteboard for cross-agent and
cross-session work-in-progress (WIP). Every agent that works in this
repo reads `active/` at session start and updates `last_touched` on
any file they interact with at session end.

**When to use it:**
- You start any multi-session project → create an `active/<slug>.md`
- Picking up work from a prior session → read `active/` first
- Handing off work to a different agent → write a file in `handoffs/`
- Finishing a project → move the file from `active/` to
  `completed/YYYY-MM-DD-<slug>.md` with a summary

**When NOT to use it:**
- One-off tasks that complete in the current session (just do them)
- Iris↔Rishi design tasks — those live in `outputs/hermes/tasks/`
  (Devon's pattern from `decisions/2026-04-01-rishi-hermes-agent-architecture.md`).
  `outputs/agent-shared/` is the broader superset for everything else.
- Mistake/correction logs — those live in `.vip/mistakes_log.md`
  (per `feedback_log-every-correction.md`)

**Scope — who writes here:** the agent population for this repo is
defined in `CLAUDE.md` (see the "Episodic Memory Protocol" section).
Roman (Bang Fitness) is isolated to `bang-fitness/outputs/agent-shared/`
and does not appear in any IVA repo. IVA agents do not appear in
`bang-fitness/outputs/agent-shared/`.

---

## Directory layout

```
outputs/agent-shared/
├── active/              # in-flight work, any agent can pick up
│   └── <slug>.md        # one file per in-flight project
├── handoffs/            # explicit agent-to-agent transfers
│   └── <from>→<to>_YYYY-MM-DD_<slug>.md
├── completed/           # archive of finished work
│   └── YYYY-MM-DD-<slug>.md
└── README.md            # this file
```

## Active file template

Copy this into `active/<slug>.md` when starting multi-session work:

```markdown
---
project: <slug>
status: in-progress          # in-progress | blocked | review
started: 2026-04-09
last_touched: 2026-04-09T14:32:00
last_touched_by: claude-code
agents_touched: [claude-code]
next_agent: null             # or '<agent-name>' for explicit handoff
blocked_on: null             # or 'path/to/blocker.md' (becomes KG edge)
estimated_completion: 2026-04-10
---

# <Project Title>

## Current state
- <where you are right now>

## Next steps
- [ ] <concrete next action>
- [ ] <another>

## Artifacts
- <paths to scripts, commits, images, etc.>

## Context for next agent
- <everything the next session/agent needs to resume cold>
```

## Handoff file template

When you explicitly hand work to another agent, drop a file in
`handoffs/` pointing at the active file:

```markdown
---
from: claude-code
to: rishi
date: 2026-04-09
active_file: outputs/agent-shared/active/ortho-k-animation.md
---

# Handoff: Ortho-K Animation → Rishi

Manim toolchain verified and ready. Test renders at
`scripts/iris-backups/manim-test-renders/`. Next step is the corneal
reshape scene — storyboard is in the active file. No blockers.
```

## Protocol — session start (every agent, every session, every repo)

1. Read every file in `active/`
2. Read `outputs/hermes/tasks/` (if Iris or Rishi — the Iris↔Rishi lane)
3. Filter `handoffs/` for files where `to: <your-agent-name>`
4. Surface in-flight work in the session opener BEFORE the user asks
5. Before creating any new active file, check that there isn't already
   one for the same project

## Protocol — during the session

- Starting multi-session work → create `active/<slug>.md` immediately
- Touching an existing active file → update `last_touched`,
  `last_touched_by`, add yourself to `agents_touched` if not already
- Work becomes blocked → set `status: blocked`, populate `blocked_on:`
- Ready for review → set `status: review`

## Protocol — session end

- For every active file touched, confirm `last_touched` is current
- If a project completed → move to
  `completed/YYYY-MM-DD-<slug>.md` with a "## Completed <date>" section
- If work was handed to another agent → write a file in `handoffs/`
- If any mistakes were logged this session → verify
  `.vip/mistakes_log.md` has the entry (see
  `feedback_log-every-correction.md`)

## Hippocampus integration

Active files are mined by Hippocampus via the `wings.yaml` topology,
so `recall("what's in flight with X")` finds them directly. The
`blocked_on:` frontmatter field becomes a KG edge (via `kg.py`), so
"what's blocking project Y" is a radius-1 ego query.

Completed files are also mined — they become the searchable archive
of finished work.

## Coexistence with outputs/hermes/

`outputs/hermes/` (if present in this repo) is the Iris→Rishi design
task lane. It has its own subdirs (`tasks/`, `completed/`, `skills/`,
`insights/`) following Devon's "git is the communication backbone"
pattern from `decisions/2026-04-01-rishi-hermes-agent-architecture.md`.

**Do not disturb it.** `outputs/agent-shared/` is the superset for
everything that isn't specifically an Iris-to-Rishi design task.

## Why this exists

Without a shared whiteboard, cross-session continuity relies on the
user's memory + git log + raw session JSONLs. Multi-day projects stall
when the user gets distracted. Cross-agent collaboration requires the
user as the human bridge. The Alex Finn video at
`performance-od/research/2026-04-09-alex-finn-openclaw-obsidian-memory-mining.md`
describes the pattern and documents the gap this closes.
