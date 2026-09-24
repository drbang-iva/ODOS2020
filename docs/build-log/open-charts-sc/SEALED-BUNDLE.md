# Open Charts C — sealed coder bundle

Both desk docks now show Open charts after Requests, using the desk projection even for providers.
Prior-day/older counts alarm; today-only counts are neutral; empty/loading/error states have no badge.
The panel shows inert desk rows, owner-only older summaries, response-zone times, and incomplete/error messages.
R2 changes only the granted Office fixture prop; both Office assertions remain unchanged.
All author checks and fresh-stack C11 proof passed. No merge or deployment was performed.
NOT EVALUATED — Claude Opus 5.5 (HUB) is the evaluator of record; Grok 4.7 is advisory.

## Identity and scope

- Branch: `drbang-iva/open-charts-sc-desk-badge`.
- Base: `2136e18c41f5846cd3240de236181afdeccfdd1b`.
- Product commit and live-tested implementation: `59c922c2d2ab8db9bfbef918c909f7c92b5f3061`.
- Subsequent commits contain evidence only. The final handoff and PR identify the final head.
- Actual coder runtime: Codex — gpt-6-astra, low effort. Requested gpt-5.6-sol/high was not the runtime selected for this task.
- R1 authority: performance-od `dc517e2ff8aeeb262894e0e82c5ec219d9f2deae`, kickoff §8 rule 15.
- R2/G2 authority: performance-od `ea8722dfe22a48859445a847635d6cb9957fef53`, kickoff §8.

Files touched: `ui/src/lib/cockpit-shell.ts`, `ui/src/scenes/DeskHome.tsx`, `ui/src/scenes/clinic/OpenChartsCard.tsx`, `ui/src/scenes/frontdesk/CockpitBadgeDock.tsx`, `ui/src/scenes/frontdesk/CockpitGuestPanel.tsx`, `ui/src/scenes/frontdesk/FrontDeskCockpit.tsx`, new `ui/src/scenes/frontdesk/OpenChartsDeskPanel.tsx`, additive `ui/src/styles/desk-home.css`, new `ui/tests/openChartsDeskPanel.test.tsx`, G1 `mcp/tests/cockpitShell.test.ts`, G2 `ui/tests/officeChannel.test.tsx`, and evidence under `docs/build-log/open-charts-sc/`.
The hook change is only an additive optional shape argument; the dock also accepts additive titles for the required response-derived tooltip.
No tracked files outside the granted scope changed. No medical codes, FHIR artifact URLs, or new decisions were introduced: Mandate 14 ledger and decisions/INDEX.md updates are not applicable.

## Premises and guards

P1–P6 were re-read at pinned `origin/main`, not from the modified worktree. P1 dock contracts, P2 both real render sites, P3 exhaustive stub record, P4 default role routing/helpers/60-second refresh, and P6 no new route/registry/policy all held.
P5's mechanical id/dock/stub sweep produced exactly the granted G1 failure: MCP 6419 pass / 1 fail / 59 skip, while UI stayed 1899 pass / 0 fail and its typecheck exited 0. The later hook exposed the Office fixture omission now covered by G2.

[R1-SEALED-BUNDLE.md](R1-SEALED-BUNDLE.md) preserves the full P1–P6 table, commands and quoted C1–C10 red/restored-green outputs. Its opening blocked status is historical and superseded by this bundle.
Each guard was broken in an allowed product file and restored byte-for-byte; no expected value was changed for a mutation.
C1 tests the real dock registry; C2–C9 mount both actual desk screens; C10 runs unchanged slice B tests.

| Guard | Mutant pass / fail | Restored pass / fail |
|---|---:|---:|
| C1 dock order | 3 / 1 | 4 / 0 |
| C2 today included in behind | 6 / 4 | 10 / 0 |
| C3 DeskHome desk override removed | 9 / 1 | 10 / 0 |
| C3 FrontDeskCockpit desk override removed | 9 / 1 | 10 / 0 |
| C4 row navigation button | 8 / 2 | 10 / 0 |
| C5 older rows instead of owner summary | 8 / 2 | 10 / 0 |
| C6 incomplete note omitted | 8 / 2 | 10 / 0 |
| C7 error badge shown | 8 / 2 | 10 / 0 |
| C8 response timeZone omitted | 8 / 2 | 10 / 0 |
| C9 DeskHome panel children removed | 7 / 3 | 10 / 0 |
| C9 FrontDeskCockpit panel children removed | 7 / 3 | 10 / 0 |
| C10 default shape changed to desk | 29 / 9 | 38 / 0 |

Every red command exited 1 and every restored command exited 0. C8 ran with process zone Asia/Tokyo and expected Denver 10:00 AM. No registry/ledger enforcement claim applies.

G1 is exactly the expected-list insertion after requests:

```diff
     "requests",
+    "open-charts",
     "team-chat",
```

G2 is exactly the added prop on the existing DeskHome element at baseline line 84:

```tsx
initialOpenCharts={{ timeZone: "America/Denver", timeZoneSource: "setting", complete: true, today: { date: "2026-09-24", count: 0, rows: [] }, lastClinicDay: null, older: { count: 0, byOwner: [] } }}
```

No other line in `officeChannel.test.tsx` changed. Existing `listCalls === 1` and `intervals === 1` assertions remain; Open Charts polling/cleanup stays covered by the hook and real-screen tests.

## Suite results

| Command | Base | Final implementation |
|---|---|---|
| `npm --prefix ui test` | 1899 tests / 1899 pass / 0 fail / 0 skip | 1909 tests / 1909 pass / 0 fail / 0 skip; exit 0 |
| MCP full CI globs, dedicated Postgres | 6479 tests / 6420 pass / 0 fail / 59 skip | 6479 tests / 6420 pass / 0 fail / 59 skip; exit 0 |
| `npm run typecheck:scripts` | exit 0 | exit 0 |
| mcp `npx tsc --noEmit` | exit 0 | exit 0 |
| ui `npx tsc --noEmit --skipLibCheck` | exit 0 | exit 0 |
| `npm run preflight` | 0 warnings / 0 hard blocks; exit 0 | 0 warnings / 0 hard blocks; exit 0 |

UI 1899 + 10 = 1909; MCP 6479 + 0 = 6479. Full MCP command and its dedicated `odos-sc-unit-pg` environment are quoted in the R1 record. The final full UI run followed G2. The full MCP run and three typechecks/preflight cover the identical product implementation; the only later test change was G2's fixture prop.
Focused UI command from `ui/`: `node --import tsx --test tests/openChartsDeskPanel.test.tsx tests/openChartsCard.test.tsx tests/clinicHome.test.tsx tests/loginDeskHome.test.tsx tests/watcherFrontdesk.test.tsx` — 85 tests / 85 pass / 0 fail / 0 skip; exit 0.

## Fresh-stack C11

Project `odos-sc-r2-live`, local Medplum port 18103, fresh uniquely named volumes `odos-sc-live-postgres`, `odos-sc-live-redis`, `odos-sc-live-binary`. `MEDPLUM_BASE_URL=http://localhost:18103/` was byte-identical to the server baseUrl; `MEDPLUM_CONTRACT_BOOTSTRAP=1` was set.

> Healthcheck passed: attempt 8/90, interval 2 s; baseUrl byte-identical.

Rule 13 execution order (all exit 0):

1. `npm --prefix mcp run test:live-integration`: bootstrap smoke **12 tests / 12 pass / 0 fail / 0 skip**; integration **218 tests / 218 pass / 0 fail / 0 skip**.
2. `npm run operator-identity -- --project <synthetic-project>`; `npm run repair-practice-roles -- --email <synthetic-admin> --project <synthetic-project>`, with `GITHUB_ACTIONS=true` only for repair.
3. `npm run sync-practice-role-policy-rules -- --project <synthetic-project> --apply --bootstrap-service-identity` installs the unchanged canonical runtime rules; no policy source edit.
4. `npm --prefix mcp run test:live-authz`: **78 tests / 78 pass / 0 fail / 0 skip**.
5. Synthetic fixtures, then Playwright through the actual app routes on the verified task Vite and MCP processes.

Browser command: `node --import tsx .odos/sc-browser.mjs` (ignored synthetic harness).

> {"checks":6,"pageErrors":0,"requests":["http://127.0.0.1:25174/clinic/open-charts/desk"]}

[Structured C11 results](C11.json) records staff-only and provider-only `/desk` and `/frontdesk` red badge checks, then staff-only plain badge checks on both routes after the prior synthetic encounter was marked entered-in-error. Project membership readback verified one policy per human; actual `/desk/whoami` returned exactly the requested role. Both callers used only the desk endpoint. Each panel had no links or buttons. This is synthetic live routing/policy evidence, not a production deployment or a new policy implementation.

Inspected screenshots (452 × 844, panel plus dock, reduced-motion capture):

- [Staff red badge and panel](staff-red-panel.png)
- [Staff today-only plain badge](staff-plain-panel.png)
- [Provider desk panel](provider-desk-panel.png)
- [Staff cockpit red badge](staff-cockpit-red-panel.png)
- [Staff cockpit plain badge](staff-cockpit-plain-panel.png)

The new surface has after-only previews; these are not fabricated before/after comparisons.

## Harness corrections and teardown

R1's dependency installation race and earlier JSX/selector harness corrections are listed in its historical record. The in-progress false-children regression was fixed in product code with existing tests unchanged. The Office timer failure required R2 and was not relabeled a setup error.
During C11, ignored harness fixes handled local login throttling; used the verified operator for clinical fixture writes; used supported synthetic invite/member APIs instead of unsupported user lookup/password reset/readback paths; supplied the missing ephemeral SMART signing key before restarting MCP; and enabled reduced-motion capture before calculating screenshot bounds. No expected values, product files, policy source or package files changed to fix those harness errors. Initial failed attempts were rerun successfully under rule 15. Cleanup used the installed standalone `docker-compose` after the unavailable `docker compose` form failed.
Task MCP/Vite processes stopped; the disposable stack and its volumes were removed with `docker-compose -p odos-sc-r2-live -f docker-compose.dr-drill.yml -f <task-override> down -v` (exit 0). No stack reaper was used.

Final `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'`:

```text
vf-prac1b-walk-db   Up 5 days   127.0.0.1:55481->5432/tcp
```

## Risks and handoff

Incomplete counts remain an accepted projection limit; the panel discloses them and badge counts follow the response. Unit skips are not live proof; the separate live lanes above passed with zero skips.
Not done: Close as incomplete (D), waiting on results (E), Q4 admin-home owner summary, server/projection/policy changes, doctor-card changes beyond the additive hook parameter, or flow-board work.
No additional scope is requested. Independent Claude Opus 5.5 (HUB) evaluation remains required at the final PR head before merge; Grok 4.7 review is advisory. Bot results are recorded in the PR/final handoff and never substitute for that evaluation.

needs-review
