# Revision 3 fixback — author evidence, NOT EVALUATED

The evaluator's NEEDS-WORK comment at 1c74aaed is addressed by four action-denial route tests and two paused-operation UI tests. The contract front matter was fetched from PerformanceOD main and confirmed REVISION 3 on 2026-09-14. PerformanceOD remained read-only.

## Changes

GuarantorScreenError retains the response body from both the screen API and the shipped correction client. A 409 with task calls onReload once, resets/closes the new screen and history, and never renders Review again or sends a second request. A task-free 409 keeps K9's explicit Review again path. The engine, draft/history behavior, routes, editor save/repair, pending buttons and registration have no retained diff.

## Mandate 17

Each row is command exit codes: green 0, deliberate break red 1, restored 0. All source mutations were restored immediately, including the explicitly authorized temporary constructor mutation. The transport fixtures, staff competitor and assertions were unchanged during each mutation.

| Break | Green | Red | Restored | Failing tests |
| --- | --- | --- | --- | --- |
| Remove search handler action check | 0 | 1 | 0 | K6 search denies staff without guarantor.link before FHIR searches or writes |
| Remove create handler action check | 0 | 1 | 0 | K6 create denies staff without guarantor.link before FHIR searches or writes |
| Remove Operation constructor action check | 0 | 1 | 0 | K6 draft denies staff without guarantor.link before FHIR searches or writes; K6 history denies staff without guarantor.link before FHIR searches or writes |
| Treat task-bearing 409 as stale | 0 | 1 | 0 | K15 paused create reloads once and closes without Review again or a second create; K15 paused Undo reloads once and closes without a second correction |

`mutation-results.json` and matching TAP files retain exact outcomes. K6 is now an enforced automated guard; this supersedes the revision-2 decorative route-only control. No registry entry, policy or audit event type was added.

## Real Chromium proof

Command: `G2B2A_BROWSER_ONLY=1 G2B2A_PAUSED_MOVE=1 G2B2A_EVIDENCE_DIR=docs/build-log/guarantor-g2b2a/revision3 node --import tsx docs/build-log/guarantor-g2b2a/live-proof.mjs`.

The fixture remained loopback, Medplum 5.1.30-9b1bd92 at 768 MiB, real service identity, synced staff policy, synthetic Projects, transaction-bundles absent. Seven captures cover the previous five flows plus paused Move and completed recovery. A real competing destination PUT is injected after create validation, immediately before its destination attach PUT. Editing before create validation would produce a stale 409, not the required recorded pause; no engine behavior is modified.

The create returns 409 with task, active=true and phase=attach-pending. Chromium shows the section automatically reloaded with Complete and Correct; Review again is absent and exactly one create request was sent. Fresh reads show the child claimed and temporarily unowned. Complete returns 200/completed; fresh Task, owner and child reads verify recovery and protected-field preservation. `live-proof.json` includes application source hashes; `live-fhir-http.json` retains real HTTP evidence.

## Follow-ups

NOT EVALUATED: the same separate Claude evaluator must evaluate the new head. Existing disclosed limits remain: orphan zero-link Persons are excluded, history considers 50 operations, and phone matching is exact digits (no country-code equivalence). Malformed trusted-history plans remain the evaluator's non-blocking follow-up. No changes address these unrelated limits.

Final CI, bot results and fixture shutdown are reported in the PR and delivery bundle.

## Final local checks

Full UI: 1517 passed, 0 failed, 0 skipped; UI build and preflight pass (0 warnings, 0 hard blocks). Full MCP: 4815 total, 4749 passed, the same 6 baseline claimReadModelStore database-hook failures, 60 skipped. Focused backend 73/73; focused UI 40/40. Named shipped counts: operation 38, routes 2, policy 5, Person 11, editor 9, UI operations 14; all unchanged. `checks.json` and `named-counts.json` retain commands and actual output counts.
