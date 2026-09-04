---
name: tier0-census
description: >
  Tier 0 of the ODOS wiring-verification loop — the dead-control census. Answers one question,
  breadth-first, for every route the UI serves: is this control connected to anything at all?
  Phase 1 (built): route-level discovery straight from ui/src/App.tsx's RouteSwitch, diffed
  against a checked-in manifest, with unlisted routes reported as findings instead of silently
  rotting off a stale list. Phase 1b (built): a sibling census one layer back — whether every
  backend route family mcp/src/index.ts registers has a matching ui/vite.config.ts proxy entry,
  the exact gap behind four real shipped bugs (/watchers, /communications, /inventory, /comms).
  Phase 1b runs in CI as a reporting-only preflight step: gaps receive GitHub Actions annotations,
  but never fail the build pending burn-in and a separate blocking decision. Phase 2 (not yet
  built): per-control browser crawl against a seeded stack. Use when auditing route coverage,
  extending the manifest as routes get reviewed, or checking whether a new backend route family
  reaches the front door.
license: Proprietary — PerformanceOD / Integrated Vision Associates internal use only.
compatibility: Requires Node 18+. Run from anywhere inside the ODOS2020 repo (worktree or root checkout).
metadata:
  author: performance-od
  version: "0.3.0-phase1b-reporting"
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
  Run standalone from the repo root: `node .claude/skills/tier0-census/scripts/discover-routes.mjs`
  (or `--json` for machine output), or `cd .claude/skills/tier0-census && node
  scripts/discover-routes.mjs` if you're already in the skill directory — the paths below are
  written for the repo-root form since that's how CI and most agents will invoke this.
- **`manifest.json`** — checked-in, one entry per reviewed route: `{ "route": "...", "status":
  "reviewed" }`. **Ships empty.** Do not pre-populate it to make a report look clean — an entry
  means someone (or an agent) actually walked that route and is vouching for it. As of this
  writing that's 0 of 49 routes; the honest first report says exactly that.
- **`scripts/check-manifest.mjs`** — runs discovery, diffs against the manifest, reports unlisted
  routes (in the app, not in the manifest, or listed with a non-`"reviewed"` status) and stale
  entries (in the manifest, no longer in the app). Duplicate or malformed manifest entries are
  reported as their own warnings and never inflate the coverage count. Conflicting statuses for
  one route leave that route unreviewed, regardless of entry order, until the entries agree. Always exits 0 —
  **advisory only**, per the design's "Advisory first, always" rule, even on a malformed
  `manifest.json` or a reformatted `RouteSwitch`. Run from the repo root:
  `node .claude/skills/tier0-census/scripts/check-manifest.mjs`.
- **`scripts/self-test.mjs`** — unit tests and subprocess checks using the real scripts copied
  into disposable directories (never touches the real `App.tsx` or `manifest.json`). Checks
  findings, Actions annotations, incomplete-discovery diagnostics, and process exit codes,
  including invalid JSON and unexpected discovery read errors; removes its temporary directories
  afterward. The `preflight` CI job runs this guard before the live proxy census. Run after
  touching either script:
  `node .claude/skills/tier0-census/scripts/self-test.mjs`.

## How to use it

1. Run `node .claude/skills/tier0-census/scripts/check-manifest.mjs` from the repo root.
2. Pick an unlisted route. Load it in the running app, exercise what's on it.
3. If it's wired correctly, add `{ "route": "<path>", "status": "reviewed" }` to `manifest.json`.
   If you find a genuinely dead or broken control, file it the normal way (an issue, a decision
   file, a fixback PR) — this skill's job is to surface the gap, not to fix what it finds.
4. Re-run the check. Coverage should tick up; it never blocks you from doing anything else.

## Phase 1b — the proxy-coverage census (a different layer, same trick)

Phase 1 answers "is this UI control wired to anything." Phase 1b answers a question one layer
further back: "does every backend route family even have a path to the browser at all." Four real
bugs shipped from the identical root cause in one day — `/watchers` and `/communications` were
registered server-side (`mcp/src/index.ts`'s `register*Routes` calls) with no matching entry in
`ui/vite.config.ts`'s proxy table, so requests silently fell through to the SPA shell (`200
text/html`) instead of reaching the backend; `/inventory` and `/comms` shipped the same gap and
were caught only by manual or evaluator runs, not CI. Full root-cause writeup:
`decisions/2026-09-02-odos-watchers-route-missing-from-proxy-table.md`.

- **`scripts/discover-backend-routes.mjs`** — parses `mcp/src/index.ts` for `register*Routes`
  imports that are BOTH imported AND actually called (an unused import doesn't count), resolves
  each to its source file (following re-export chains — `pretest-endpoint.ts` re-exporting from
  `pretest-vitals-endpoint.ts` is a real example), and extracts every route-family prefix from its
  literal route-registration calls. Recognizes both call shapes actually used in this codebase:
  `app.get("/path", ...)` and the local wrapper form `get(app, "/path", ...)` (seven files use the
  wrapper, including `payments/payment-routes.ts`). **Also scans `index.ts`'s own 120+ inline
  `app.<method>(...)` calls directly** — an independent evaluation of an earlier version found this
  script only scanned delegated files and silently missed index.ts's own routes, which is exactly
  how it missed a real gap (see below) in its own first run. Run: `node
  .claude/skills/tier0-census/scripts/discover-backend-routes.mjs` (or `--json`).
- **`scripts/check-proxy-coverage.mjs`** — diffs discovered backend families against
  `ui/vite.config.ts`'s proxy table keys. A backend family with no proxy entry is the finding — the
  exact shape of all four bugs above. Lists every registration that owns a gap family, not just
  the first (`/comms` has three). A proxy entry with no matching backend family is NOT reported as
  a problem (`/fhir`, `/auth`, `/oauth2` intentionally target Medplum directly, not the ODOS mcp
  server — correctly outside this census's scope). The `preflight` CI job runs it on every push to
  `main` and every PR into `main`; uncovered families and incomplete scanner diagnostics emit
  GitHub Actions warnings so they appear in the Checks and Files views. Diagnostic runs never
  print the clean-coverage sentence. It remains deliberately reporting-only and always exits 0. Run:
  `node .claude/skills/tier0-census/scripts/check-proxy-coverage.mjs`.

  Promotion to blocking is a separate decision. The proposed threshold is 10 consecutive clean
  `main` runs, matching the live-authorization lane's burn-in precedent, followed by a dedicated
  PR that changes the exit-status contract and repeats the real-CI break/restore proof.

**Known blind spot, not yet closed:** this only recognizes `app.<method>("/path", ...)` and the
local `get(app, "/path", ...)` wrapper. Two other real registration shapes exist and aren't
scanned: `app.route("/path").get(...).post(...)` (two instances, both under the already-covered
`/clinical-graph` family, so no known impact yet) and a globally-mounted sub-router —
`app.use(createSmartAuthorizationRouter({...}))` with no path argument, whose own internal routes
(`router.use("/agentops", ...)` and others in `mcp/src/smart/authorization-server.ts`) define their
own prefixes this census never sees. Whether that sub-router's routes have proxy coverage hasn't
been checked — don't assume either way. Flagged by Greptile on this PR; not fixed here.

At initial CI wiring, all 24 discovered backend families had a proxy entry. That clean snapshot is
not a promise about later heads; CI now reruns the discovery and reports drift on each PR and
`main` push.

This is not a manifest you populate like Phase 1's; there's nothing to mark "reviewed" here, it
either has a proxy entry or it doesn't.

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

49 route(s) served by the app with NO reviewed manifest entry (unreviewed — advisory finding, not a failure):
  ? /audit/log
  ? /billing/today
  ... (47 more)

Coverage: 0/49 routes reviewed.
Advisory only — this check never fails the build. See SKILL.md for how to act on findings.
```

Phase 1b (`check-proxy-coverage.mjs`):

```
Proxy-coverage census — 24 backend route families discovered, 25 proxy table entries.

2 backend route families have NO proxy table entry — this is the exact shape of the /watchers, /communications, /inventory, and /comms bugs:
  ! /comms (registered by registerTwilioWebhookRoutes, ./comms/twilio-routes.js; registerGhlWebhookRoutes, ./comms/ghl-routes.js; registerTrackedLinkRoutes, ./comms/tracked-links.js)
  ! /inventory (registered by (inline), mcp/src/index.ts)

Reporting only — CI annotates findings, but this check never fails the build.
```
