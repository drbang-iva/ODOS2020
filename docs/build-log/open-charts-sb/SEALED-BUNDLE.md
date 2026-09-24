# Open Charts B — doctor card on Clinic home: sealed coder bundle

Clinic home now shows an **Open charts** card where "Awaiting your signature" used to be. Providers get the doctor card from slice A's `/clinic/open-charts`: Today (calm), the last clinic day (alarm, with its date as the heading), Older (warning, count and oldest date, with a Show older button that fetches `?expand=older` once), and Needs review. It has a My charts / All providers toggle; My charts also includes Unassigned. Each row lists its reason chips, and nothing says "ready to sign". Other roles get one line from `/clinic/open-charts/desk`. The waiting-strip chip reads **Open charts**. Its number is what is behind (last clinic day plus Older, the caller's own), with "N today" beside it. `/clinic/summary` now reads the stored practice time zone and maps the zone failures to the same 409/502 `{ code }` responses as the open-charts routes.

Coder: Claude Opus 5.5 (medium). Evaluator: Codex (GPT-5.6 Sol, high). Kickoff: `performance-od/decisions/2026-09-23-odos-open-charts-sb-doctor-card-codex-kickoff.md`, with the operator overrides of 2026-09-23 (Claude codes, Codex evaluates). Branch `drbang-iva/open-charts-sb-doctor-card`, base `205d95c8d53cdfbca1bc28a6b1d05d735f53f405`. The PR URL and final head SHA are in the handoff response. No merge and no policy change (rule 20). Iris sync is not needed.

## Operator ruling taken mid-slice

Rule 18 asked for the slice A response types to be imported into the UI as types. At the base that fails: `ui` `tsc --noEmit --skipLibCheck` exits 0, but adding a single `import type { Doctor, Desk } from "…/mcp/src/clinic/open-charts"` gives **19 errors**. They are all TS6133/TS6196 unused-variable errors in mcp clinical-graph files that the import pulls into the UI program. I stopped and reported. The operator granted **ruling A**: add a new import-free file `mcp/src/clinic/open-charts-types.ts`, and have `open-charts.ts` re-export the same public types from it. The type block moved verbatim. `diff` of base lines 12–43 against the new file shows only two changes: `OwnerCount` and `Completeness` gained `export`, because `open-charts.ts` still uses them internally. The public export list of `open-charts.ts` is unchanged, and mcp `tsc` exits 0.

## Files

- New: `mcp/src/clinic/open-charts-types.ts` (ruling A) · `ui/src/lib/open-charts.ts` · `ui/src/scenes/clinic/OpenChartsCard.tsx` · `ui/tests/openChartsCard.test.tsx` · `mcp/tests/clinicSummaryTimeZone.test.ts` · this directory.
- Edited: `mcp/src/clinic/open-charts.ts` (ruling A: the type block became one import plus one re-export) · `mcp/src/clinic/clinic-routes.ts` (3.1, `handleClinicSummary` only) · `ui/src/lib/clinic-summary.ts` (3.2) · `ui/src/scenes/ClinicHome.tsx` (3.5; `SignatureCard`, `ageLabel` and `dateLabel` deleted because they were no longer used) · `ui/src/styles/clinic-home.css` (3.6, 23 lines appended, 0 removed).
- Granted tests: G1 `mcp/tests/clinicRoutes.test.ts` (+1 setup line) · G2 `ui/tests/clinicHome.test.tsx` · G3 `ui/tests/patientOverview.test.tsx`.
- Not touched: `mcp/src/index.ts`, `authz/*`, `policy/*`, `data/`, `scripts/`, `.github/`, `deploy/`, package manifests, `ui/src/scenes/frontdesk/*`, `.claude/launch.json`, `ui/vite.config.ts`.

## Premises P1–P7 (read at `origin/main` = `205d95c8`)

All hold. The only drift is one line reference in P1: the summary-error strip replacement is at `ClinicHome.tsx:151`, not `:152`. P4 was checked by running it. The §0.5 server change added exactly one mcp failure (`GET /clinic/summary authenticates once…`), and with G1 that file ran 7/7. P7 was checked live through the served front door: `/clinic/open-charts` and `/clinic/open-charts/desk` each returned 401 with no auth.

## G1–G3

- **G1:** one added setup line, `serviceFhir: { search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }) } as never`. No assertion changed.
- **G2:** the render passes an inline `initialOpenCharts` doctor fixture. The two signature extractions and assertions are replaced. The chip must show the card's *behind* number, computed from the rendered card as last-clinic-day rows plus the rendered "N older". The chip must also read `Open charts`. A non-vacuity check pins that number to 4: on the last clinic day, one of mine plus one Unassigned (another provider's row is hidden), plus 2 of mine in Older. The order setup, extractions and assertions are unchanged.
- **G3:** the second half re-renders `ClinicHome` with an `initialOpenCharts` fixture and clicks the row inside `clinic-open-charts-card`. It asserts `{ kind: "overview", patientId: "open-chart-patient" }`. The flow half is unchanged.

## Mandate 17: broken → red → restored → green

Every mutation ran in a detached disposable worktree at `75b43484`. Each mutant was checked to be present before its run, restored with `git checkout`, and `git status --porcelain` was empty before the green re-run. mcp runs used a dedicated Postgres container (`odos-sb-unit-pg`) via `ODOS_POSTGRES_URL`.

| Guard | Break | RED | GREEN |
|---|---|---|---|
| B1 | summary passes `deps.timeZone` | `not ok 1 - B1 …stored practice time zone…` · 3 tests / 2 pass / 1 fail | 3 / 3 / 0 |
| B2 | handler falls back to env on `practice-time-zone-invalid` | `not ok 3 - B2 …maps practice time-zone failures…` · 3 / 2 / 1 | 3 / 3 / 0 |
| B3 | alarm class dropped from last-clinic-day group | `not ok 1 - B3` · 11 / 10 / 1 | 11 / 11 / 0 |
| B4 | Today rows sorted by name | `not ok 2 - B4` · 11 / 10 / 1 | 11 / 11 / 0 |
| B5 | *mine* excludes Unassigned | `not ok 2 - B4`, `not ok 3 - B5`, `not ok 4 - B6`, `not ok 11 - B13` · 11 / 7 / 4 | 11 / 11 / 0 |
| B6 | *mine* Older uses `older.count` | `not ok 4 - B6`, `not ok 11 - B13` · 11 / 9 / 2 | 11 / 11 / 0 |
| B7 | `duplicate-fee` shows "Fee not classified" | `not ok 5 - B7`, `not ok 6 - B8` · 11 / 9 / 2 | 11 / 11 / 0 |
| B8 | Show older requests without `expand` | `not ok 6 - B8` · 11 / 10 / 1 | 11 / 11 / 0 |
| B9 | incomplete note omitted | `not ok 7 - B9` · 11 / 10 / 1 | 11 / 11 / 0 |
| B10 | client renders the raw code | `not ok 8 - B10` · 11 / 10 / 1 | 11 / 11 / 0 |
| B11 | time formatted without `timeZone` | `not ok 9 - B11` · 11 / 10 / 1 | 11 / 11 / 0 |
| B12 | every role uses the doctor route | `not ok 10 - B12` · 11 / 10 / 1 | 11 / 11 / 0 |
| B13 | Today counted in *behind* | `not ok 7 - waiting strip counts…` (G2), `not ok 21 - B13` · 21 / 19 / 2 | 21 / 21 / 0 |
| G3 | card rows wired to a no-op instead of `openPatient` | `not ok 1 - Clinic flow and unsigned-chart clicks…` · 49 / 48 / 1 | 49 / 49 / 0 |
| §3.2 | summary client ignores `code` | `not ok 8 - B10` · 11 / 10 / 1 | 11 / 11 / 0 |

B11 sets `process.env.TZ = "Asia/Tokyo"` during the assertion and restores it afterwards.

## Suites, typechecks, preflight

The worktree had no `.odos/` during the unit runs, so there were no operator files to move aside (rule 14). The mcp suite used the CI globs under zsh recursive globbing, with `ODOS_POSTGRES_URL` pointed at `odos-sb-unit-pg`. A first base run under macOS `/bin/bash` 3.2, which has no `globstar`, collected a smaller set; it was discarded and re-run.

| Check | Base `205d95c8` | Head `75b43484` |
|---|---|---|
| mcp (CI globs) | tests 6470 · pass 6411 · fail 0 · skipped 59 | tests 6473 · pass 6414 · fail 0 · skipped 59 (+3 new) |
| `npm --prefix ui test` | tests 1871 · pass 1871 · fail 0 | tests 1882 · pass 1882 · fail 0 (+11 new) |
| `npm run typecheck:scripts` | exit 0 | exit 0 |
| mcp `npx tsc --noEmit` | exit 0 | exit 0 |
| ui `npx tsc --noEmit --skipLibCheck` | exit 0 | exit 0 |
| `npm run preflight` | 0 warnings, 0 hard blocks | 0 warnings, 0 hard blocks |

## Live lanes (rule 13 order), fresh stack `odos-sb-live` on 18103

`MEDPLUM_BASE_URL=http://localhost:18103/` matches the `baseUrl` in `medplum.dr-drill.config.json` byte for byte. The stack came up with `docker-compose -p odos-sb-live -f docker-compose.dr-drill.yml up -d postgres redis medplum-server` (this host has no `docker compose` plugin). The healthcheck gate polls every 2 s for up to 90 attempts; it passed on **attempt 12**.

| Lane | Result |
|---|---|
| Smoke (bootstrap) | tests 12 · pass 12 · fail 0 |
| Integration | tests 218 · pass 218 · fail 0 · exit 0 |
| Seeder (`operator-identity`) | exit 0 |
| `repair-practice-roles` (`GITHUB_ACTIONS=true` on this command only) | exit 0 |
| `sync-practice-role-policy-rules --apply --bootstrap-service-identity` | exit 0 |
| Authorization (`MEDPLUM_CONTRACT_BOOTSTRAP=1`, operator env sourced) | tests 78 · pass 78 · fail 0 · exit 0 |

### B14 browser proof

The harness is untracked and lives outside the repo. It creates synthetic **single-role humans**, one provider-only and one staff-only, through Medplum invite. Each is bound to the exact `ODOS Provider` or `ODOS Staff` AccessPolicy, matched by exact name plus practice-role tag, because a composite policy also carries the provider tag. The harness also creates a runtime-service client (project admin, no clinical policy) and five synthetic patients. Their visits, relative to today in `America/New_York`:

- today, mine
- today, an Unassigned walk-in
- today, another provider's
- last clinic day (Sep 22), mine
- Older (Sep 17), mine

It then runs the MCP server from source on 127.0.0.1:24333 with `ODOS_TIMEZONE=America/New_York` and **no stored setting**, and Vite on 127.0.0.1:25174. Vite uses a wrapper config that loads `ui/vite.config.ts` unchanged and re-points only the three Medplum proxies (`/fhir`, `/auth`, `/oauth2`) from 8103 to 18103. Chrome is driven with playwright-core. The integration lane's own fixture encounters share the project and also appear; they are correct rows, not noise from this slice.

- **Provider, My charts** (`b14-provider-mine.png`): Today shows the provider's own visit and the Unassigned walk-in. It hides the other provider's visit. The last-clinic-day heading reads "Tuesday, Sep 22" and holds the provider's visit. Older reads "2 older · oldest Apr 25". The chip is `3 Open charts · 7 today`, class `is-alert`.
- **Provider, All providers with Older expanded** (`b14-provider-all-older.png`): the other provider's visit appears with its owner, "Contact lens fitting · 8:48 PM · with you · Olive Otherdoc". Show older made one `/clinic/open-charts?expand=older` request and rendered the Sep 17 visit with the chip "Nothing charted". The count stayed "2 older · oldest Apr 25". No text matches `/ready to sign/i`.
- **Staff** (`b14-staff-summary.png`): one line, "Open charts: 7 today · 1 from Tuesday, Sep 22 · 2 older". No rows and no chips. The chip is `3 Open charts · 7 today`.
- **Routes:** the provider called only `/clinic/open-charts` and `?expand=older`. Staff called only `/clinic/open-charts/desk`. `/clinic/summary` returned 200 for both roles on the fresh stack, using the env zone with no setting. There were zero page errors. The Vite dev build runs React.StrictMode, so each mount fetches twice.

Harness-only corrections (rule 15; no expected value, product request or product file changed):

- The policy tag system constant was fixed.
- The composite policy was excluded by exact name.
- Day arithmetic moved to the local practice date (UTC had already rolled to Sep 24).
- A full-page capture overlaid the sticky app header, so it was replaced with a card capture at a 2400 px viewport.
- One run timed out waiting for the card right after login; an identical rerun passed.
- In my own new test file: HTML-entity decoding, restricting the chip scan to one group, a scheduled flow row so the chart button makes no FHIR fetch, a more specific Hide lookup, and unmounting inside `act` so effect cleanup runs before the harness restores `window`.

## `docker ps` after teardown

```
odos-grokgate-base-rerun 127.0.0.1:25440->5432/tcp
vf-prac1b-walk-db 127.0.0.1:55481->5432/tcp
```

Both belong to other sessions and were not touched. `odos-sb-live` was brought down with `down -v`, and `odos-sb-unit-pg` was removed.

## Outside §4: reported, not edited

- `docker-compose.dr-drill.yml` pins its volume names (`name: odos_dr_drill_*`), so `-p odos-sb-live` does not scope them. `down -v` removed volumes with those names. I did not check whether they existed before `up`. The evidence says the database was fresh: every fixture row the card listed dates from 02:40–02:45Z, which is this session's integration run, and no older row appeared in any group. Any other DR-drill user of those names on this host would collide the same way. That is a follow-up for the compose file.
- `ui/vite.config.ts` hard-codes the Medplum proxy target `http://localhost:8103`. Live proofs on 18103 need a wrapper config or a port forward.

## Fixback 1: CodeRabbit review at `5b129123`

CodeRabbit posted four threads, then one more in a second wave at `947d54d3`. PR-Agent failed at this head: the diff came to 36,389 tokens against its 32,000 limit and was pruned, the same limit slice A's PR #663 hit. Its config is in `.github/`, which is outside §4, so it was reported and not changed.

| Thread | Verdict | Change |
|---|---|---|
| L96 a refresh error leaves old counts on the chip | Valid: the chip kept its old number while its class went grey | A failed refresh now replaces the state with `{ error }`. The chip shows "—" and the card shows the sentence. |
| L99 an older in-flight refresh can overwrite a newer one | Valid: there was no sequence guard | A request counter; only the newest request may settle the state. |
| L195 expanded Older rows survive a refresh | Valid | The expansion is cleared when the Older summary (count, oldest date, byOwner) changes. An unchanged refresh keeps it open, so it does not collapse every 60 s. Remaining gap: within one refresh, one of the same owner's Older charts is signed and another opens on the same date. |
| L126 (second wave) same-summary change in Older membership | **Escalated; resolved in fixback 2 by operator ruling (Older refreshes while open).** At fixback 1: This is the remaining gap noted on L195. Closing it means re-fetching `?expand=older` on each refresh while expanded, or having the refresh carry `expand=older`; either contradicts §0.5 "Show older fetches once per open". | None. Operator decision. The counts shown are always current. |
| L133 qualify incomplete desk counts and never show `is-ok` when incomplete | **Escalated; operator ruled 2026-09-24 to leave as is (accepted limit).** At fixback 1: §0.5 fixes the exact desk line and the chip tones (`is-alert` iff behind > 0), and B9 limits "at least" to the doctor card's Older. Changing either changes the design contract. | None. Operator decision. |

Mandate 17 at `93777b4c`, in a disposable worktree:

| Guard | Break | RED | GREEN |
|---|---|---|---|
| F1 | error keeps the previous `data` | `not ok 12 - a failed refresh drops the old counts…` · 14 / 13 / 1 | 14 / 14 / 0 |
| F2 | any response may settle the state | `not ok 13 - a slow older refresh cannot overwrite a newer one` · 14 / 13 / 1 | 14 / 14 / 0 |
| F4 | invalidation effect removed | `not ok 14 - expanded Older rows stay open…` · 14 / 13 / 1 | 14 / 14 / 0 |
| F4b | invalidate on every refresh (`[olderSource, data]`) | `not ok 14` · 14 / 13 / 1 | 14 / 14 / 0 |

At `93777b4c`: `npm --prefix ui test` gave 1885 tests, 1885 pass, 0 fail (+3). ui `tsc` exit 0. Preflight 0 warnings, 0 blocks. Only UI files changed, so the mcp suite and live lanes were not re-run. B14 ran at `5b129123`; the fixback touches only the refresh and expansion-invalidation paths, which the three tests above guard.

## Fixback 2: Codex FAIL at `8a95e303`

Codex (evaluation record `performance-od/decisions/2026-09-24-odos-open-charts-sb-pr664-eval.md`) returned FAIL with five findings. Operator rulings, 2026-09-24:

- **Finding 3 (incomplete counts):** leave as is. A practice would need about 1,000 open charts before a bounded read comes back incomplete, so the §0.5 desk line and chip tones stand. This is recorded as an accepted limit, not changed.
- **Finding 4 (Older freshness):** Older **refreshes** while it is open. This amends §0.5 "Show older fetches once per open". Show older still issues one `?expand=older` request when clicked. After that, each 60 s refresh also carries `expand=older` while Older is open, so its rows and its counts always come from the same response.
- **New, operator request:** the Show older list is grouped by age from the practice's today. The groups are **Up to a week** (0–7 days), **Over 1 week** (8–30), **Over 30 days** (31–60), **Over 60 days** (61–90) and **Over 90 days** (91+). Empty groups are omitted, and rows keep the server's order within each group. This is UI only; the collapsed Older line and the server are unchanged.

| Finding | Change |
|---|---|
| 1 Show → Hide → Show lets the earlier response win | Show older now goes through the same numbered request path as the refresh, so only the newest request may settle the state. Unmount also invalidates any request still in flight. |
| 2 unguarded timer cleanup and chip-vs-toggle | New tests: the interval is registered once at 60,000 ms, is cleared on unmount, and nothing fetches afterwards; the chip's number, text and tone do not change when the card is toggled, using a fixture where mine and all differ. |
| 4 a signed chart can stay listed in an open Older | The refresh carries `expand=older` while Older is open, as ruled above. This replaces fixback 1's aggregate-fingerprint invalidation. |
| 5 two added comments in `open-charts-types.ts` | Removed. `diff` against base lines 12–43 now shows only the two `export` keywords. |
| 3 incomplete counts | No change (operator ruling). |

Mandate 17 at `eb88c164`, in a disposable worktree. Each mutant was checked to have landed, the tree was clean before each GREEN, and the tests ran against `ui/tests/openChartsCard.test.tsx` (18 tests):

| Break | RED | GREEN |
|---|---|---|
| R1 any response may settle (no request numbering) | `not ok 13 - a slow older refresh…`, `not ok 15 - reopening Older before the previous request settles…` · 18 / 16 / 2 | 18 / 18 / 0 |
| R2 unmount does not clear the interval | `not ok 16 - the 60-second refresh is registered once and cleared…` · 18 / 17 / 1 | 18 / 18 / 0 |
| R3 refresh period 30 s | `not ok 16` · 18 / 17 / 1 | 18 / 18 / 0 |
| R4 chip follows the card toggle (10-edit, two-file mutant that lifts the scope into the hook) | `not ok 17 - the waiting chip counts the caller's charts whichever way…` · 18 / 17 / 1 | 18 / 18 / 0 |
| R5 Hide leaves the refresh expanding | `not ok 14 - while Older is open each refresh carries expand=older…` · 18 / 17 / 1 | 18 / 18 / 0 |
| R6 refresh drops `expand` while open (the old snapshot behaviour) | `not ok 14` · 18 / 17 / 1 | 18 / 18 / 0 |
| R7 "Over 1 week" starts at 7 days | `not ok 18 - Show older groups rows by age…` · 18 / 17 / 1 | 18 / 18 / 0 |
| R8 "Over 90 days" starts at 90 days | `not ok 18` · 18 / 17 / 1 | 18 / 18 / 0 |
| R9 within-group order reversed | `not ok 18` · 18 / 17 / 1 | 18 / 18 / 0 |

Full battery at `eb88c164`: mcp tests 6473, pass 6414, fail 0, skipped 59; `npm --prefix ui test` tests 1889, pass 1889, fail 0 (1885 − 1 replaced + 5 new); all three typechecks exit 0; preflight 0 warnings, 0 blocks.

Live, on a fresh `odos-sb-live2` stack on 18103. `docker volume ls` showed no `odos_dr_drill_*` or `odos-sb*` volumes before `up`. An untracked override gave all three volumes unique `odos-sb-live2-*` names, and they were created fresh. The healthcheck passed on attempt 12. Smoke 12/12, integration 218/218, seeder/repair/sync exit 0, authorization 78/78. B14 was re-run with one added 40-day-old visit:

- Provider My charts: own visit and the Unassigned walk-in shown, the other provider's visit hidden. The last clinic day reads "Wednesday, Sep 23". Chip `4 Open charts · 7 today`, `is-alert`.
- All providers: the other provider's visit is shown with "Olive Otherdoc".
- Show older showed the groups **Up to a week / Over 30 days / Over 90 days**. It made one `?expand=older` request on click, and after a 65 s wait with Older open a second `?expand=older` request, the refresh. The rows were still shown and the count was unchanged ("3 older · oldest Apr 25").
- Staff: one line, "Open charts: 7 today · 1 from Wednesday, Sep 23 · 3 older", with no rows or chips. The only route called was `/desk`.
- `/clinic/summary` 200 for both roles, no page errors. The front door returns 401 unauthenticated.

The three screenshots in this directory are from this run. Teardown: `down -v` removed only the `odos-sb-live2-*` volumes; `odos-sb-unit-pg` was removed. `docker ps`: `vf-prac1b-walk-db 127.0.0.1:55481->5432/tcp` (not touched).

## Risks and follow-ups

- **Literal §0.5 reading:** `/clinic/summary` with `practice-time-zone-unreadable` (502) shows "Open charts are unavailable right now." in the Today's-flow error slot, because §0.5 says the same three codes render the same sentences. If the operator wants different summary wording, that is a one-line change to the map in `ui/src/lib/open-charts.ts`.
- On a summary error the whole waiting strip is still replaced by "Unavailable", including the new chip. That behaviour pre-dates this slice (P1) and was left unchanged.
- **Accepted limit (operator ruling, finding 3):** when a bounded read comes back incomplete (`complete: false`), the desk line shows plain counts and the chip can be green at zero. The doctor card's Older still says "at least" plus the incomplete note (B9).
- **Refresh cost while Older is open:** each 60 s refresh asks the server to compute reasons for every Older row. This only happens while a doctor has Older expanded.
- A failed Show older request now shows the card's error sentence, like any failed refresh, rather than an error confined to the Older section.
- Refresh runs only when `window.setInterval` exists, the same gate as the Office poller. Server-rendered and window-less test renders never fetch or start timers.
- If `roles` ever arrive after the first render, the desk route would be called before the doctor route. In the live run roles had already resolved at mount, so staff called only desk and provider only doctor.
- Out of scope and not done: front-desk badge and panel (C), Close as incomplete (D), waiting on results (E), Q4 admin home, the flow board's ✎ flag and row-order note, other `ODOS_TIMEZONE` readers, the #661 evidence follow-up.

Status: needs-review
