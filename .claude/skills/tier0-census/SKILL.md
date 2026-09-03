---
name: tier0-census
description: >
  Tier 0 of the ODOS wiring-verification loop — the dead-control census. Answers one question,
  breadth-first, for every route the UI serves: is this control connected to anything at all?
  Phase 1 (built): route-level discovery straight from ui/src/App.tsx's RouteSwitch, diffed
  against a checked-in manifest, with unlisted routes reported as findings instead of silently
  rotting off a stale list. Phase 2 (not yet built): per-control browser crawl against a seeded
  stack. Advisory only — never blocks a build. Use when auditing route coverage or extending the
  manifest as routes get reviewed.
license: Proprietary — PerformanceOD / Integrated Vision Associates internal use only.
compatibility: Requires Node 18+. Run from anywhere inside the ODOS2020 repo (worktree or root checkout).
metadata:
  author: performance-od
  version: "0.1.0-phase1"
allowed-tools: Bash(node:*)
---

# Tier 0 — the dead-control census

Origin: `decisions/2026-09-02-odos-wiring-verification-loop-design.md` in `performance-od`. That
file names Tier 0 as the gap in ODOS2020's prove step that Tiers 1–3 don't cover: for the large
majority of routes, nobody — no test, no CI lane — has ever confirmed a control on the page is
wired to anything. The operator is the first click. This skill is breadth-first, not depth-first:
it doesn't test a few flows deeply, it inventories every route shallowly and tracks what's actually
been reviewed.

**This is Phase 1 of that design, not the whole thing.** Read the "What Phase 2 needs" section
before assuming this skill already crawls the live app — it doesn't yet.

## The anti-rot rule (the actual trick)

A hand-authored checklist normally rots silently: the app grows past it, and nobody notices the
list stopped being current. This inverts that. `manifest.json` is the checklist, but
`check-manifest.mjs` diffs it against routes discovered **live from source** (App.tsx's
`RouteSwitch`, not a copy of it) every time it runs. A route the app serves with no manifest entry
is not a passing check — it's the finding. A manifest entry for a route that no longer exists is
also a finding (stale, not silently ignored). The manifest cannot fall behind the app without the
tool saying so.

## What's built (Phase 1)

- **`scripts/discover-routes.mjs`** — parses `ui/src/App.tsx`'s `switch (path) { ... }` block and
  extracts every route it serves, resolving named path constants (`DESK_HOME_PATH`, `CLINIC_PATH`,
  `CLINIC_PATIENTS_PATH`) back to their literal string by grepping their `const` definitions under
  `ui/src`. No hand-maintained route list — if `RouteSwitch` changes, discovery changes with it.
  Run standalone: `node scripts/discover-routes.mjs` (or `--json` for machine output).
- **`manifest.json`** — checked-in, one entry per reviewed route: `{ "route": "...", "status":
  "reviewed" }`. **Ships empty.** Do not pre-populate it to make a report look clean — an entry
  means someone (or an agent) actually walked that route and is vouching for it. As of this
  writing that's 0 of 49 routes; the honest first report says exactly that.
- **`scripts/check-manifest.mjs`** — runs discovery, diffs against the manifest, reports unlisted
  routes (in the app, not in the manifest) and stale entries (in the manifest, no longer in the
  app). Always exits 0 — **advisory only**, per the design's "Advisory first, always" rule. Run:
  `node scripts/check-manifest.mjs`.

## How to use it

1. Run `node scripts/check-manifest.mjs` from the repo root (or any worktree).
2. Pick an unlisted route. Load it in the running app, exercise what's on it.
3. If it's wired correctly, add `{ "route": "<path>", "status": "reviewed" }` to `manifest.json`.
   If you find a genuinely dead or broken control, file it the normal way (an issue, a decision
   file, a fixback PR) — this skill's job is to surface the gap, not to fix what it finds.
4. Re-run the check. Coverage should tick up; it never blocks you from doing anything else.

## What Phase 2 needs (not yet built — don't claim this skill does it)

The full design (see the decision file) wants per-**control** entries — `{ route, precondition,
control, expectedEffect }` — verified by an actual browser crawl: click each declared control on a
disposable seeded stack, confirm it produces a network request or DOM mutation matching the
declared expectation, flag any *discovered* control absent from the manifest the same way Phase 1
flags unlisted routes.

That needs a logged-in session against the real app (`ui/src/App.tsx` shows `LoginScreen` until
`fhir.rehydrateSession()` / `fhir.login()` succeeds), which needs the seeded Medplum stack
(`docker-compose.dr-drill.yml`, bootstrapped the way `.github/workflows/ci.yml`'s `live-authz` job
already does it — `generate-medplum-signing-keys` → bring up postgres/redis/medplum-server →
project bootstrap → policy repair/sync) plus a UI-side test identity with practice roles resolved
(`resolveSessionRoles`), which doesn't exist yet in reusable form outside that CI job. Building that
bootstrap as a reusable local/CI script is the next slice, not a rewrite of what's here — Phase 1's
route discovery and manifest diff are the pieces Phase 2 builds on, not pieces Phase 2 replaces.

Do not stub out a fake "crawled all controls" pass to make this skill look more complete than it
is. A check that looks like it verifies the real system and doesn't is exactly the failure mode
this whole tier exists to catch (see `decisions/2026-08-28-odos-auditor-fixture-fossil-verdict.md`
and the void-bug incident that prompted this design). Report Phase 1's real, narrower scope
honestly instead.

## Output format

```
Tier 0 dead-control census — 49 route(s) discovered, 0 manifest entries.

49 route(s) served by the app with NO manifest entry (unreviewed — advisory finding, not a failure):
  ? /audit/log
  ? /billing/today
  ... (47 more)

Coverage: 0/49 routes reviewed.
Advisory only — this check never fails the build. See SKILL.md for how to act on findings.
```
