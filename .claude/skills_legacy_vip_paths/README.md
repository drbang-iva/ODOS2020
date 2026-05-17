# Quarantined — Legacy vip-path skill symlinks

These 11 broken symlinks were originally at `.claude/skills/` and point to `/Users/ericr.bang/Documents/GitHub/vip/.claude/skills/*` — the retired vip clone path (substrate migration to `mb` pipx completed 2026-05-02 per `performance-od/decisions/2026-05-02-mb-cli-full-migration.md`).

**Quarantined 2026-05-17** per audit Decision #2 in `performance-od/audits/2026-05-17-repo-memory-audit/12-operator-decisions-needed.md`.

## Why quarantine and not delete

osod is a code repo (open-source PMS/EHR for optometry). Code repos don't need brain skills (mb is for operator authoring workflows, not coding). The vip-path symlinks were leftover from the pre-`mb`-pipx era. Quarantining (not deleting) keeps them as historical record per the audit's no-delete rule.

## If skills are ever needed in osod

Run `mb skill link --repo .` from osod root to relink to current mb pipx engine. Then this folder can stay as historical record or be removed by operator decision.

## Restore (if quarantine was wrong)

```
git mv .claude/skills_legacy_vip_paths .claude/skills
```
