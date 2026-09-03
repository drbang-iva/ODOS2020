# Delete controls — restraint pass (2026-09-02) — evidence

Design: `performance-od/decisions/2026-09-02-odos-delete-controls-restraint-design-proposal.md` (§8 is the build list).
Base: `0c9c3ea2` (origin/main at branch time). Styling only; the void primitive, scopes, sign gate, confirm rule, Undo ledger, and outcome messages are untouched.

## What is in this folder

| File | What it is |
|---|---|
| `alert-counts.json` | §6 computed-style count of alert-coloured elements (`--odos-alert` = `rgb(226, 92, 106)`) per surface and state, before (base) and after (head), from a real Chromium at 1440×1000. |
| `mutation-report.json` | Mandate 17: each mutant applied to `ui/src`, the guard file run, the file restored; pass/fail and the guard that fired. |
| `screenshots/before/*-rest.png` | Base at rest: Pupils, IOP, VA, Auto-refraction. |
| `screenshots/after/*-rest.png`, `*-edit.png`, `*-dialog.png`, `*-signed.png`, `*-rest-squint.png` | Head at rest, with Edit engaged, with the section Clear dialog open, signed, and the 6 px squint of the resting view. `pupils-clear-chart-dialog.png` is the tier-3 dialog. |
| `harness/restraint.html`, `harness/restraint.tsx` | The Vite page that rendered the real components with the real stylesheet and every network call answered in-page (synthetic data, no server, no login). Copy to `ui/dev-harness/` to run; the base checkout runs the same file with the `ConfirmDestructiveProvider` lines removed. |
| `harness/shoot.mjs` | Playwright capture: navigates each surface, presses Edit, opens the dialogs, records counts and screenshots. |
| `harness/mutate.py` | The mutation runner. |

## §6 result — the count

| Surface | Before, at rest | After, at rest | After, Edit engaged | After, Clear dialog open | After, Escape | After, signed |
|---|---|---|---|---|---|---|
| Pupils | 4 | 0 | 0 | 1 (`button.odos-confirm-destroy`) | 0 | 0 |
| IOP | 4 | 0 | 0 | 1 | 0 | 0 |
| VA | 4 | 0 | 0 | 1 | 0 | 0 |
| Auto-refraction | 4 | 0 | 0 | 1 | 0 | 0 |

Before, the four were: the tier-3 chrome button, `Clear <Section>`, and the per-value × controls (two, or three on Auto-refraction). After, the dialog's confirm button is the only alert-coloured element and focus lands on Keep (`focused: "odos-confirm-keep 'Keep'"` in every dialog row). Per-value Removes: 0 at rest, 2 (3 on Auto-refraction) with Edit engaged, 0 signed.

## Guards (`ui/tests/deleteControlsRestraint.test.tsx`) and their breaks

| # | Guard | Mutant applied at the boundary | Result |
|---|---|---|---|
| 1 | Nothing red at rest — class strings in the rendered tree AND the stylesheet's rules for the feature's selectors | M1a: alert border/text back on Clear · M1b: the chrome clear-all alert override back in `charting.css` | RED both, guard 1 |
| 2 | Removes absent until Edit, one per recorded value, gone on Done | M2: render Removes ignoring edit state | RED, guards 2 and 3 |
| 3 | Edit state ends when the section empties — the next value recorded **in the same mount** opens at rest | M3: drop the `hasRecorded` reset | RED, guard 3 |
| 4 | Closed encounter: Edit / Clear / Clear chart present-but-disabled with the tooltip, no Remove, even with nothing recorded; and a section in edit state when the encounter signs loses its Removes without a remount | M4: hide Edit when nothing recorded on a closed encounter · M3b: drop the closed reset in the provider · M2c: drop both closed checks | RED all three, guard 4 |
| 5 | 44 px on Edit/Done/Remove/Clear (`min-h-11`) and on Clear chart/Keep/confirm (`min-height: 44px`) | M5: quiet token back to `py-0.5` | RED, guard 5 |
| 6 | Clear opens `role="alertdialog"`, `window.confirm` not called, only the confirm button wears `.odos-confirm-destroy` | M6: route Clear through the `window.confirm` fallback | RED, guards 6, 7, 8 |
| 7 | Focus on Keep; Escape, backdrop, Keep resolve false and void nothing | M7: initial focus on the confirm button | RED, guard 7 |
| 8 | Copy verbatim; retired strings absent under `ui/src` | M8: tier 3 back to the long string · M8b: tier 2 back to `Clear {label}` | RED both, guard 8 |
| 9 | Fallback refuses with no surface | M9: resolve `true` | RED, guard 9 |

**One equivalent mutant, reported rather than counted.** M2b (drop only `RemoveValueButton`'s own `closed` check) stays GREEN. The outcome — no Remove on a signed chart — is guarded at the provider, which resets edit state when the encounter closes (M3b alone is RED; M2c, dropping both, is RED). The button's own check exists to prevent a one-frame flash of Removes between the sign and the provider's effect; react-test-renderer flushes effects inside `act`, so that frame is invisible to it. The check is defense in depth, not a boundary these tests can see.

**Two guards were rewritten after their first mutant survived.** Guard 3 first proved a remount (a new React key), which resets state whether or not the effect exists; M3 stayed green. It now removes the last value, then saves a new one (Normal OU → Save) without unmounting. Guard 4 first proved only a fresh signed render; the sign-during-edit transition is what the provider reset is for, so it is now in the guard.

## What these tests cannot see

- Computed colour and layout. react-test-renderer has neither; guard 1 asserts the two inputs a browser combines (class strings, stylesheet rules by selector). The computed-style count above is the browser-side check and was taken in the harness, not on the live app.
- The live app behind login. The harness stubs `fetch` in-page; no authentication flow was driven (repo security policy). The operator's live walkthrough remains the check that the controls still work end to end on the real stack — nothing in this pass touched what they do.
- The one-frame flash M2b protects against (above).

## Suites at head

- `ui`: 1225 tests, 1225 pass, 0 fail, 0 skipped (base 1215 / 0 skipped; +10 in the new guard file).
- `mcp` (`ODOS_ALLOW_UNGATED_MCP=1 npm test`): 4095 tests, 4041 pass, 0 fail, 54 skipped — identical skip count to base (39 live-stack). One earlier head run failed `tests/bulk-data/boundary.test.ts` "job IDs are opaque"; it generates 1000 random IDs and asserts none contain a word like `DOB`; it passed at base, passed 3/3 when re-run alone, and passed in the final run. Filed as a separate task; not touched here.
- `npx tsc --noEmit` clean in `ui` and `mcp`; `npm run typecheck:scripts` clean; `npm run preflight`: 0 warnings, 0 hard blocks.
