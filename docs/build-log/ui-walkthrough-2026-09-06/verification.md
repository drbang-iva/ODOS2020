# Live-walkthrough fixback verification — 2026-09-06

Base: `4fbfa5f94b828fb5b2fb33b8ab247cc277327dd9`

All browser data below is synthetic. Browser guards ran in headless Google Chrome at 1440 px.

## Findings

- P0 was not an autosave timer race. The failing browser guard captured `window.confirm → useExamEntrySheetGuard.requestTransition → onCancel`; the native modal synchronously suspended the renderer until the host answered. The replacement uses the existing in-app destructive-confirm surface. All three immediate-navigation paths keep the JavaScript event loop live while the prompt is open, Keep retains the sheet, and Discard completes the requested transition.
- P1 had two roots. Wearing and Refraction axis values were intact in the DOM but clipped by 24 px of horizontal input padding inside a 105 px grid column. IOP's editable picker let pointer hover change the active option while Enter was intended to commit typed text, so typed `16` selected hovered `15`. Auto-Refraction remained the passing control.
- P2 had no Wearing read/hydration path. The new scoped history endpoint returns the latest complete capture and the UI refuses editing or Save until that read succeeds. Wearing persistence remains append-only. An unchanged hydrated Save is a no-op; a blank request is rejected before any write.
- P3 reproduced as label overflow in the fixture, rather than an empty binding. The summary text measured 132.56 px inside a 108.27 px button. Content sizing and flex layout keep the label and chevron within the control.
- P4 changes both binocular PD pickers from 0.5 mm to 1 mm options.
- P5 moves the unchanged Add complaint block after active complaints and before the first subject section.

## Mandate 17 RED/GREEN evidence

| Priority | RED against the base behavior | GREEN after repair |
| --- | --- | --- |
| P0 | `node --import tsx --test --test-name-pattern='P0' tests/uiWalkthrough.test.tsx`: 3 tests, 0 pass, 3 fail. Each failure recorded a native dialog and the blocking stack through `ExamEntrySheet.tsx` `requestTransition`. | Same command: 3 tests, 3 pass, 0 fail. No native dialogs; each in-app prompt remained responsive for three timer ticks and completed Keep/Discard behavior. |
| P1 | `node --import tsx --test tests/uiWalkthrough.test.tsx`: Wearing `120` clipped (`available:13`, `textWidth:23.31`, `scrollLeft:10`); Refraction `180` clipped (`available:13`, `textWidth:23.80`); IOP expected `16`, actual `15`. Auto-Refraction `175` passed. | `node --import tsx --test tests/uiWalkthrough.test.tsx tests/wearingHydration.test.tsx`: 14 tests, 14 pass, 0 fail. IOP also asserts the POST payload contains `16`; deliberate ArrowDown selection still produces `17`. |
| P2 UI | `node --import tsx --test tests/wearingHydration.test.tsx`: 3 tests, 1 pass, 2 fail. Hydrated OD sphere expected `-2.00`, actual blank; failed history left Save enabled. | Hydration guards pass: all standard values reopen, unchanged Save makes 0 writes, a genuine blank makes 0 writes, read failure keeps Save disabled, and a late old-encounter response cannot replace the new encounter. |
| P2 server | `node --import tsx --test tests/pretestEndpoint.test.ts`: 13 tests, 12 pass, 1 fail because `handleWearingHistoryRequest` did not exist. | `node --import tsx --test tests/pretestEndpoint.test.ts tests/refractionHistoryEndpoint.test.ts tests/customFields.test.ts`: 32 tests, 32 pass, 0 fail. Removing the 1,000-row partial-read refusal makes its guard fail: expected 409, actual 200. |
| P3 | The walkthrough browser guard failed: label bounds ended at 744.08 px while the button ended at 707.78 px. | The same guard passes and the working dropdown behavior remains covered. |
| P4 | The walkthrough browser guard failed because the picker exposed `62.00, 62.50, 63.00, 63.50, 64.00 mm`. | Both distance and near guards pass with exactly `62 mm, 63 mm, 64 mm` around 63. |
| P5 | `node --import tsx --test --test-name-pattern='P5' tests/uiWalkthrough.test.tsx`: 1 test, 0 pass, 1 fail; Add complaint followed the subject-section article. | Same command: 1 test, 1 pass, 0 fail; adding Glaucoma leaves the order complaint article → Add complaint → Family History. |

Supplementary mutations also failed as required: deleting the Wearing HTTP route produced 1/1 failure in the route census (`98 !== 99`), and deleting the stale-response check produced 1/1 failure (`-2.00 !== -3.00`). Both mutations were restored before final verification.

Greptile's first review found that timestamp-only grouping could combine independent captures saved in the same millisecond. The added equal-timestamp regression was RED at 0/1 because it reopened all three pairs from two captures. Each save now assigns a stable `WEARING_CAPTURE_ID` to every Observation, and the reader groups by that ID while isolating the legacy timestamp fallback from identified captures. The restored guard passes 1/1; mutating the capture-ID component out returns it to the same 0/1 failure.

## Live synthetic persistence proof

A disposable Medplum 5.1.8/PostgreSQL 16/Redis 7 stack on dedicated ports accepted a full Wearing pair through the real capture handler and FHIR client. Direct FHIR read returned OD axis 180. A blank request returned HTTP 400 and left the one Observation byte-equivalent. The browser then hydrated OD `-2.00 / -0.50 × 180` and OS `-1.75`; unchanged Save made zero POSTs, and reload still showed axis 180.

The browser proof routes the real Wearing component's HTTP requests to the real endpoint handlers and Medplum client. It does not exercise the production Express router or a non-Chrome browser host.

## Broad checks

- UI serial suite: `node --import tsx --test --test-concurrency=1 tests/**/*.test.tsx` → 1,258 pass, 0 fail, 0 cancelled, 0 skipped.
- The standard parallel UI command was run three times and hit existing browser-startup/resource timeouts in `Collect payment` and the chart-bar browser test; both focused files pass (12/12), and the full serial suite is green.
- MCP full suite with a disposable PostgreSQL instance and `ODOS_ALLOW_UNGATED_MCP=1`: 4,204 pass, 0 fail, 0 cancelled, 57 skipped. The harness recorded 41 live-stack tests as ungated, including live authorization; the flag only makes the exit code reflect executed tests.
- MCP endpoint/history/route targeted suite after the capture-ID fixback: 43 pass, 0 fail.
- FHIR read-grant checks: 14 pass, 0 fail.
- Persistent definition-route checks: 10 pass, 0 fail.
- UI and MCP TypeScript/production builds: exit 0. Vite reports its existing 1.83 MB chunk-size warning.
- Tier 0 proxy census: 24 backend route families, 27 proxy entries; all covered. The census is advisory by design.

No medical code, terminology binding, FHIR artifact URL, or regulatory citation changed, so no Mandate 14 ledger row was needed. This fixback makes no new architectural decision, so `decisions/INDEX.md` was not changed.
