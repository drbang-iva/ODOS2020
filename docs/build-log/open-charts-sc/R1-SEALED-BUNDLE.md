# Open Charts C — R1 sealed coder bundle

Historical stop record. R2 granted the G2 fixture correction; see SEALED-BUNDLE.md for the current outcome.

The badge and panel are implemented in the isolated worktree, but this slice is blocked by an existing Office test outside the granted scope.
The required Open Charts timer makes that test observe two timers where it asserts one.
No assertion in that file was changed. No PR, commit, merge, or deployment was made.
C1–C10 mutation proofs passed after restoration. C11 remains unperformed.
NOT EVALUATED — independent evaluation has not run.

## Identity and files

Branch: `drbang-iva/open-charts-sc-desk-badge`.
HEAD and refreshed `origin/main`: `2136e18c41f5846cd3240de236181afdeccfdd1b`.
The implementation is uncommitted; HEAD is the base, not an implementation commit.
PR URL: none. Commit hashes added: none.
R1 source: performance-od `dc517e2ff8aeeb262894e0e82c5ec219d9f2deae`, kickoff §8.

Edited: `ui/src/lib/cockpit-shell.ts`, `ui/src/scenes/frontdesk/CockpitBadgeDock.tsx`, `ui/src/scenes/frontdesk/CockpitGuestPanel.tsx`, `ui/src/scenes/clinic/OpenChartsCard.tsx`, `ui/src/scenes/DeskHome.tsx`, `ui/src/scenes/frontdesk/FrontDeskCockpit.tsx`, `ui/src/styles/desk-home.css`, and G1 in `mcp/tests/cockpitShell.test.ts`.
New: `ui/src/scenes/frontdesk/OpenChartsDeskPanel.tsx`, `ui/tests/openChartsDeskPanel.test.tsx`, this bundle.
CSS changes are additive. OpenChartsCard changes only its hook's optional shape argument and shape selection.
The dock also has an optional additive `titles` map to deliver the required response-derived button tooltip.

## Blocking assertion and precise scope needed

`ui/tests/officeChannel.test.tsx:64-95`, “Desk home consumes the shell Office source without starting a second poll”.
Its timer stub at line 71 counts **all** interval registrations; line 90 asserts `intervals === 1`.
The Office shell registers one timer, and the required Open Charts hook registers another.
The Office API call count assertion at line 89 still passes.

Actual full-suite failure:

> not ok 1245 - Desk home consumes the shell Office source without starting a second poll
> Expected values to be strictly equal: 2 !== 1
> expected: 1; actual: 2; operator: strictEqual

This is not an R1 harness failure. Rules 5 and 10 require a stop: §4 prohibits changing this existing test, and suppressing the required Open Charts refresh would violate the product contract.

Proposed narrow G2, **not applied**: grant only the DeskHome fixture line at `ui/tests/officeChannel.test.tsx:84` an explicit empty `initialOpenCharts` desk response. That test can keep both existing assertions unchanged and stay focused on Office polling. The new C3 tests independently exercise real Open Charts requests and its 60-second refresh on both screens.
No server, policy, registry, or other product change is requested.

## P1–P6

All premise reads used `origin/main`, verified at the pinned full SHA above.

| Premise | Re-verification |
|---|---|
| P1 | Dock model, optional counts, red badge styling, and zero/99+ behavior confirmed. |
| P2 | Both dock and guest-panel render sites confirmed; DeskHome initially passes no children and its fax preview shows the children pattern. App routes `/frontdesk` to FrontDeskCockpit and the Desk path to DeskHome. |
| P3 | PANEL_STUB is the exhaustive Record and needs the new entry. |
| P4 | Role-based shape choice, exported date/time helpers, 60-second refresh, and shared three error sentences confirmed. |
| P5 | Mechanical sweep added only the id, dock item, and stub entry: UI 1899 pass / 0 fail; UI typecheck exit 0; MCP 6419 pass / 1 fail / 59 skip, only the granted dock-order assertion. This premise holds for those three lines; it did not cover the later hook addition. |
| P6 | Existing `/clinic` proxy and existing desk route are reused. No new app route, backend registration, Basic resource, extension, or policy; no census or registry edit required. |

## Suites and checks

| Check | Clean base | Mechanical P5 sweep | Implemented working tree |
|---|---|---|---|
| `npm --prefix ui test` | tests 1899 / pass 1899 / fail 0 / skip 0; exit 0 | tests 1899 / pass 1899 / fail 0 / skip 0; exit 0 | tests 1909 / pass 1908 / fail 1 / skip 0; exit 1 |
| MCP full CI globs, dedicated Postgres | tests 6479 / pass 6420 / fail 0 / skip 59; exit 0 | tests 6479 / pass 6419 / fail 1 / skip 59; exit 1 | tests 6479 / pass 6420 / fail 0 / skip 59; exit 0 |
| `npm run typecheck:scripts` | exit 0 | not repeated | exit 0 |
| mcp `npx tsc --noEmit` | exit 0 | not repeated | exit 0 |
| ui `npx tsc --noEmit --skipLibCheck` | exit 0 | exit 0 | exit 0 |
| `npm run preflight` | 0 warnings / 0 hard blocks; exit 0 | not repeated | 0 warnings / 0 hard blocks; exit 0 |

Base + added: UI 1899 + 10 = 1909 tests. MCP 6479 + 0 = 6479 tests.
The 59 MCP skips are not live-authorization proof.
Full MCP command, from `mcp/`, under zsh with expanded recursive globs:

```sh
ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15439/medplum node --import tsx --test --test-concurrency=1   src/__tests__/**/*.test.ts tests/**/*.test.ts   ../tests/boundaries/**/*.test.ts ../tests/observation-status-machine/**/*.test.ts   ../tests/setup-wizard/**/*.test.ts ../tests/preflight/**/*.test.ts   ../tests/smart/**/*.test.ts ../tests/cds/**/*.test.ts   ../tests/agentops/**/*.test.ts ../tests/bulk-data/**/*.test.ts   ../tests/mandate-8/**/*.test.ts
```

All MCP unit runs used `odos-sc-unit-pg`. Operator credential/state files were absent during those runs; there were none to move aside.
The final focused run, from `ui/`:

```sh
node --import tsx --test tests/openChartsDeskPanel.test.tsx tests/openChartsCard.test.tsx tests/clinicHome.test.tsx tests/loginDeskHome.test.tsx tests/watcherFrontdesk.test.tsx
```

> tests 85 / pass 85 / fail 0 / skipped 0; exit 0

## C1–C10: broken → red → restored → green

Every mutation was applied to an allowed product file, run, then restored byte-for-byte in a `finally` block before the green run. No mutation changed an expected value.
C1 runs `node --import tsx --test tests/cockpitShell.test.ts` from `mcp/` with the dedicated database environment.
C2–C9 run `node --import tsx --test tests/openChartsDeskPanel.test.tsx` from `ui/`.
C10 runs `node --import tsx --test tests/openChartsCard.test.tsx tests/clinicHome.test.tsx` from `ui/`.
The new panel tests mount DeskHome and FrontDeskCockpit, open their actual dock buttons, and inspect the rendered panel. Scheduler loading is isolated; the Open Charts hook and fetch boundary are real.

### C1 — Move the dock item last

RED (exit 1):

> not ok 1 - dock items are in the design-doc order (launcher → fax)
> # tests 4
> # pass 3
> # fail 1
> # skipped 0

GREEN (exit 0):

> # tests 4
> # pass 4
> # fail 0
> # skipped 0

### C2 — Include today in behind

RED (exit 1):

> not ok 1 - C2 DeskHome: behind alarms, today stays plain, zeros/loading hide badges; exact tooltip and cap
> not ok 5 - C7 DeskHome: every error sentence replaces data and removes the badge
> not ok 6 - C2 FrontDeskCockpit: behind alarms, today stays plain, zeros/loading hide badges; exact tooltip and cap
> not ok 10 - C7 FrontDeskCockpit: every error sentence replaces data and removes the badge
> # tests 10
> # pass 6
> # fail 4
> # skipped 0

GREEN (exit 0):

> # tests 10
> # pass 10
> # fail 0
> # skipped 0

### C3-desk — Drop DeskHome desk override

RED (exit 1):

> not ok 2 - C3 DeskHome: provider-inclusive callers request only desk, one shared 60-second refresh
> # tests 10
> # pass 9
> # fail 1
> # skipped 0

GREEN (exit 0):

> # tests 10
> # pass 10
> # fail 0
> # skipped 0

### C3-cockpit — Drop FrontDeskCockpit desk override

RED (exit 1):

> not ok 7 - C3 FrontDeskCockpit: provider-inclusive callers request only desk, one shared 60-second refresh
> # tests 10
> # pass 9
> # fail 1
> # skipped 0

GREEN (exit 0):

> # tests 10
> # pass 10
> # fail 0
> # skipped 0

### C4 — Render a button for each row

RED (exit 1):

> not ok 3 - C4 C5 C6 C8 C9 DeskHome: real panel has inert desk rows, owner summaries, zone times and incomplete note
> not ok 8 - C4 C5 C6 C8 C9 FrontDeskCockpit: real panel has inert desk rows, owner summaries, zone times and incomplete note
> # tests 10
> # pass 8
> # fail 2
> # skipped 0

GREEN (exit 0):

> # tests 10
> # pass 10
> # fail 0
> # skipped 0

### C5 — Render today rows instead of older owner summaries

RED (exit 1):

> not ok 3 - C4 C5 C6 C8 C9 DeskHome: real panel has inert desk rows, owner summaries, zone times and incomplete note
> not ok 8 - C4 C5 C6 C8 C9 FrontDeskCockpit: real panel has inert desk rows, owner summaries, zone times and incomplete note
> # tests 10
> # pass 8
> # fail 2
> # skipped 0

GREEN (exit 0):

> # tests 10
> # pass 10
> # fail 0
> # skipped 0

### C6 — Omit incomplete note

RED (exit 1):

> not ok 3 - C4 C5 C6 C8 C9 DeskHome: real panel has inert desk rows, owner summaries, zone times and incomplete note
> not ok 8 - C4 C5 C6 C8 C9 FrontDeskCockpit: real panel has inert desk rows, owner summaries, zone times and incomplete note
> # tests 10
> # pass 8
> # fail 2
> # skipped 0

GREEN (exit 0):

> # tests 10
> # pass 10
> # fail 0
> # skipped 0

### C7 — Show a badge on error

RED (exit 1):

> not ok 5 - C7 DeskHome: every error sentence replaces data and removes the badge
> not ok 10 - C7 FrontDeskCockpit: every error sentence replaces data and removes the badge
> # tests 10
> # pass 8
> # fail 2
> # skipped 0

GREEN (exit 0):

> # tests 10
> # pass 10
> # fail 0
> # skipped 0

### C8 — Pass no timeZone to the shared service-time formatter

RED (exit 1):

> not ok 3 - C4 C5 C6 C8 C9 DeskHome: real panel has inert desk rows, owner summaries, zone times and incomplete note
> not ok 8 - C4 C5 C6 C8 C9 FrontDeskCockpit: real panel has inert desk rows, owner summaries, zone times and incomplete note
> # tests 10
> # pass 8
> # fail 2
> # skipped 0

GREEN (exit 0):

> # tests 10
> # pass 10
> # fail 0
> # skipped 0

### C9-desk — Remove DeskHome panel children

RED (exit 1):

> not ok 3 - C4 C5 C6 C8 C9 DeskHome: real panel has inert desk rows, owner summaries, zone times and incomplete note
> not ok 4 - C4 DeskHome: empty days and absent sections stay explicit
> not ok 5 - C7 DeskHome: every error sentence replaces data and removes the badge
> # tests 10
> # pass 7
> # fail 3
> # skipped 0

GREEN (exit 0):

> # tests 10
> # pass 10
> # fail 0
> # skipped 0

### C9-cockpit — Remove FrontDeskCockpit panel children

RED (exit 1):

> not ok 8 - C4 C5 C6 C8 C9 FrontDeskCockpit: real panel has inert desk rows, owner summaries, zone times and incomplete note
> not ok 9 - C4 FrontDeskCockpit: empty days and absent sections stay explicit
> not ok 10 - C7 FrontDeskCockpit: every error sentence replaces data and removes the badge
> # tests 10
> # pass 7
> # fail 3
> # skipped 0

GREEN (exit 0):

> # tests 10
> # pass 10
> # fail 0
> # skipped 0

### C10 — Default the new shape parameter to desk

RED (exit 1):

> not ok 16 - B8 Show older issues one expand=older request, renders its rows with chips, and Hide collapses without changing counts
> not ok 20 - B12 providers call only the doctor route; other roles call only the desk route and get one summary line
> not ok 24 - while Older is open each refresh carries expand=older, so a signed chart leaves the list even when the summary is unchanged
> not ok 25 - reopening Older before the previous request settles cannot let the older response win
> not ok 29 - hiding Older retires its in-flight request, so a late 502 cannot blank the card
> not ok 33 - a doctor response still pending when supplied data switches to the desk shape cannot land
> not ok 34 - without supplied data, a doctor response still pending at a switch to the desk shape cannot land
> not ok 35 - switching from the doctor to the desk role never renders the doctor's rows, not even for one frame
> not ok 38 - a request from before a doctor-desk-doctor round trip cannot settle when the same supplied object returns
> # tests 38
> # pass 29
> # fail 9
> # skipped 0

GREEN (exit 0):

> # tests 38
> # pass 38
> # fail 0
> # skipped 0

## C11 and live lanes

Fresh stack: `odos-sc-live`, Medplum port 18103. Named volumes: `odos-sc-live-postgres`, `odos-sc-live-redis`, `odos-sc-live-binary`; no shared pinned DR volumes were used.
`MEDPLUM_BASE_URL=http://localhost:18103/` was checked against config `baseUrl` byte-for-byte.
`MEDPLUM_CONTRACT_BOOTSTRAP=1` was set for the live integration command.

> Healthcheck passed: attempt 16/90, interval 2 s; baseUrl byte-identical.

`npm --prefix mcp run test:live-integration`:

> Bootstrap smoke: tests 12 / pass 12 / fail 0 / skipped 0.

The subsequent integration phase was interrupted when the UI scope blocker was identified; it produced no final summary and is **not passed**.
Role repair, authorization, and C11 browser proof were not run. No screenshot or browser request-URL evidence exists for this patch.
No claim of live AccessPolicy or served-route proof is made.

## G1 diff

```diff
     "requests",
+    "open-charts",
     "team-chat",
```

No other existing test line was edited.

## R1 harness corrections and in-progress defect

- Before R1, the base UI run began before MCP dependencies finished installing and could not resolve zod. The incomplete run was discarded. All three dependency trees were verified with `npm ls --all --json` before the successful fresh baseline.
- A focused invocation from the repository root used the wrong JSX configuration and reported React is not defined. Running from `ui/` corrected it without a source or expectation change.
- A new-test selector matched both the dock button and open panel by aria-label. It was narrowed to the button; expected values stayed unchanged.
- In-progress product defect: passing false children for other panels suppressed their stub content. The existing “Desk comms rail resolves hover…” test failed on missing Two-way messaging text. Both screens now pass undefined for other panels. Product-only correction; its existing assertion is unchanged. Focused suite after correction: 85/85.
- The Office timer assertion is a distinct product-contract/scope conflict and was not treated as a harness exception.

## Teardown

The task's active integration process was stopped. `docker-compose -p odos-sc-live -f docker-compose.dr-drill.yml -f <task-volume-override> down -v` removed only this task's live stack and volumes. `odos-sc-unit-pg` was removed. No stack reaper was used.

Final `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'`:

```
vf-prac1b-walk-db	Up 5 days	127.0.0.1:55481->5432/tcp
```

`vf-prac1b-walk-db` was left untouched.

## Risks, follow-ups, status

- Grant or reject the precise G2 fixture-line change above before resuming. Re-run the full UI suite and complete the live lanes in the prescribed order on a fresh stack after the scope ruling.
- No PR or bot review exists. Independent evaluator of record remains Claude Opus 5.5 (HUB); Grok 4.7 is advisory. NOT EVALUATED.
- Incomplete counts remain the accepted limit; the panel explains incompleteness and the badge follows returned counts.
- No new decision or terminology assertion was introduced: decisions/INDEX.md unchanged; Mandate 14 ledger rows added: none. Cross-repo follow-up is the kickoff's next scope ruling.
- Not done: Close as incomplete (D), waiting on results (E), Q4 admin-home owner summary, server/projection/policy changes, doctor-card changes beyond the allowed additive hook parameter, and the flow board.

blocked
