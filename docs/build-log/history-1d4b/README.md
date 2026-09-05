# History Slice 1d-4b — coder evidence

Base freshly fetched: `538aa92fe4653030dbc70a31c18275f0d91c9869`.
Branch: `drbang-iva/history-slice-1d4b`. Session: ODOS-HISTORY-1D-4B.

Author checks only. NOT independently evaluated; hand to Fable/Opus at the final PR head.

## What shipped behaviour does this change?

The HPI entry sheet now consumes `itemizedSubjectSections`: comprehensive visits show the
full ROS table open, with fourteen catalog-driven systems, explicit Reviewed checkboxes,
Yes/No answers, derived last-asked dates, stale flags, and “ROS notable for” text. Follow-up
presentation on an active complaint defaults ROS to folded with “Complaint-directed” in the
header; it can be opened manually. Both states are proven through the actual App `/clinic`
route against synthetic local Medplum. Neither bulk gesture is present.

Answers save as sequential independent single-answer requests. A ten-tap burst persists all
ten without exceeding the existing conditional transaction guard. Each successful unit advances
the existing persisted-answer snapshot; there is no bulk operation or progress ledger. Already
queued autosave callbacks can send empty aggregate refreshes after the answers drain.

Reviewed is an explicit gesture: exactly one individual act with one target. Unmark writes a
retraction targeting the original act; Undo uses the existing observation-void primitive on the
retraction. The original remains byte-identical, including its resource version. The act read
route makes Unmark and Undo available after reopening/reloading the sheet. Retry retains the
same gesture identifier if a write or its following refresh fails. History Clear is available
for review-only entries, including after reload, and the shared void classifier recognizes both
item reviews and retractions as History. Confirmed Clear voids both while retaining the records.

The fold summary is the server's `subjectSectionSummaries` text, including the registered
coverage, positive-answer and method tokens. Bulk method attribution remains visible for
existing bulk acts without exposing a bulk gesture. Once ROS is Charted, Exam Overview uses
that itemized summary; the live example shows “Eyes reviewed” plus partial/unreviewed system
fractions and “Review method: individual.” Legacy complaint ROS and Social History semantics
are unchanged.

## Corrections to kickoff assumptions

At the base, `/clinical-graph/history/review` already dispatched all three act kinds through
its union handler despite the two item writers being private. This change exports the writers
and adds explicit individual-review/retraction routes reusing that handler and the unchanged
persistence/idempotency comparators.

The existing `lastReviewed` derivation includes answer timestamps as well as review acts.
This seam is preserved: retracting the only review of an **unanswered** item removes its date;
an answered item can retain its answer-derived date, and prior unretracted evidence can also
remain. A review checkbox represents an active explicit act on this encounter, not merely a
date. This distinction was raised to the operator during the task; no change to the ratified
derivation was authorized. Stale means never asked or dated before the current UTC calendar
year; it is a display flag, with no measure-compliance or clinical-due-date claim.

## Files

- `mcp/src/clinical-graph/hpi-endpoint.ts`: explicit handlers, encounter act read, per-target
  validation behind the outer envelope, writer exports. Existing comparators unchanged.
- `mcp/src/clinical-graph/encounter-void-endpoint.ts`: classify item reviews/retractions under
  their declared History section for the existing Clear/Undo primitive.
- `mcp/src/clinical-graph/history-item-routes.ts`, `mcp/src/index.ts`: real route registration
  with the existing caller dependency factory and chart.read/chart.write checks.
- `ui/src/components/charting/HpiSection.tsx`: ratified definition consumer, bounded answer
  saves, shared answer identity callback and summary refresh after answer/clear operations.
- `ui/src/components/charting/HistoryRosSection.tsx`: grouped ROS controls and retraction Undo.
- `mcp/tests/historyRosHttp.test.ts`, `mcp/tests/helpers/historyRosFixture.ts`,
  `ui/tests/historyRosBrowser.test.tsx`: HTTP and browser regression guards.
- `mcp/scripts/prove-history-ros-surface.ts`: reproducible synthetic persistence/App-route proof.
- `ui/tests/clinicalGraphRouting.test.tsx`: caller inventory 54 → 55; shared helper guard retained.
- `scripts/fhir-read-grant-check.ts`: existing service write inventory line coordinates refreshed;
  no grants, exclusions, call sites or policy behavior added.
- This directory: synthetic screenshots and command evidence.

## Checks and counts

Real output: [checks.txt](checks.txt), [regressions.txt](regressions.txt),
[browser.txt](browser.txt), [http.txt](http.txt), [live-proof.txt](live-proof.txt).

- Prior 1a/1b/1c and 1d-1 through 1d-4a backend tests: **128/128**, untouched.
  Engine 12, answer encoding 3, HPI endpoint 37, HPI pagination 15, FHIR search 9,
  item-review 23, item-review definitions 2, ROS/definitions 27.
- Prior UI History tests: **25/25**, untouched (24 component cases and one Chromium case).
- New HTTP contract: **1/1**, exercising six malformed targets, individual cardinality,
  bulk refusal, idempotent retry, immutable retraction and rehydrated act reads.
- New browser cases: **3/3**, using real production HPI handlers and their actual guard;
  FHIR storage is an in-memory fixture in these repeatable tests.
- Full UI: **1,238 passed, 0 failed, 0 skipped**.
- Full MCP: **4,242 tests; 4,185 passed, 0 failed, 57 skipped**. Explicitly ungated for
  unavailable live integrations; this command received no credentials.
- Earlier 1d-2 live pagination suite: **1/1**, unchanged, including 600/1,001/5,000 reads,
  indexed ROS exclusion and the 5,001-row HTTP 409 refusal ([pagination-live.txt](pagination-live.txt)).
  The port 18103 seed hit its existing 429 write quota; the successful rerun used the existing
  dedicated local `odos-history-1d2` stack at port 18403. No configuration changed.
- Earlier 1d-4a live ROS proof: **7/7 scenarios**, unchanged ([ros-regression-live.txt](ros-regression-live.txt)).
- Both package builds pass. UI retains its existing large-bundle warning.
- Write inventory regression: **14/14**. Proxy census: all 24 backend families covered;
  advisory, not a live routing verdict. `git diff --check` clean.

## Mandate 17

[mutations.txt](mutations.txt) retains break output, including assertion details. The restored
browser run is [browser.txt](browser.txt).

| Mutation | Observed guard |
|---|---|
| Replace single-answer units with the entire delta | RED: ten taps return **HTTP 413**; comprehensive case fails |
| Make an answer also call the review gesture | RED: expected 0 item acts, actual 1 |
| Make retraction PUT entered-in-error onto the original | RED: original byte/version equality fails |
| Force initial and follow-up-change fold state open | RED: expected aria-expanded false, actual true |
| Bypass outer target-array schemas with z.any | Six malformed client targets still refused by per-target server validation; HTTP test remains GREEN |

A first fold mutation changed only the initial state and stayed green because the follow-up
effect still folded it. Mutating both controls forced the wrong behavior and failed the
follow-up test; the ineffective probe is not counted as proof. All production mutations were
restored. Removing the shared clinical graph helper import also fails the updated routing test;
restoration passes 8/8 ([routing-mutation-red.txt](routing-mutation-red.txt),
[routing-mutation-green.txt](routing-mutation-green.txt)).

## Review fixback

PR-Agent identified that review-only ROS did not enable History Clear. The new browser case
failed first with the control absent (expected 1, actual 0), then exposed the shared void
classifier returning a zero-item preview because item acts were classified outside History.
The parent now receives persisted act presence on load/refresh, and the existing classifier
recognizes the two shipped item-act codes. The restored run passes **28/28** (three new browser
cases plus the unchanged 25 prior UI cases). Actual App + Medplum confirms that a review-only
entry can be cleared and that both review and retraction remain stored as entered-in-error.
Evidence: [review-clear-red.txt](review-clear-red.txt), [review-clear-classifier-red.txt](review-clear-classifier-red.txt),
[review-clear-green.txt](review-clear-green.txt), [live-proof.txt](live-proof.txt).

## Local proof boundaries

`prove-history-ros-surface.ts` runs the actual App, RouteSwitch, PatientRoute, EncounterCharting
and HPI entry sheet at `/clinic?patientId=…&encounterId=…`, via a dedicated loopback Vite server
on port 15134. Real handlers read/write synthetic resources in the existing local Colima
contract stack at port 18103; no service was stopped and no schema or stored policy changed.
The harness binds the supplied synthetic admin token to a provider role and supplies limited
ancillary catalog reads. It **does not prove constrained-role AccessPolicy enforcement** or
unrelated chart features. Some unrelated harness routes return 404; those are not ROS failures.
The Playwright context and test listener are closed after proof.

Run from the task root with `MEDPLUM_BASE_URL`, `MEDPLUM_ADMIN_EMAIL`, and
`MEDPLUM_ADMIN_PASSWORD` supplied privately:

```
node --import tsx mcp/scripts/prove-history-ros-surface.ts
```

No new medical terminology codes, FHIR canonical URLs, regulatory claims, schema definitions,
or registry entries: **Mandate 14 new ledger rows: 0**. The existing ratified declarations and
bindings are consumed unchanged. No new architecture decision: companion `decisions/INDEX.md`
unchanged. The date interpretation above remains visible for the independent evaluator.

CI run count and exact final-head bot/check state are reported in the PR description, avoiding
a self-referential evidence commit. No deployment or merge is claimed.
