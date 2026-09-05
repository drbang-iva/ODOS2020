# History 1d-4a author evidence

Base: `54e1b802a6a12bf5afe784ee67fc4dde7789e49f`. Branch: `drbang-iva/history-slice-1d4a`.
Status: authored and locally verified; independent evaluation pending. No evaluator marker or operator label.

## Behavior and scope

ROS is an encounter-scoped declaration with 54 local answer options across 14 systems, a grouped
symptoms section, and one “ROS notable for” text section. Jaw pain and scalp tenderness belong to
Eyes in catalog data. The engine registers reviewed_systems, positives and method; an unknown
summary token throws in both renderers, including production, rather than silently disappearing.

The current generic HPI UI renders every `subjectSections` declaration. To preserve the requested
backend-only split, the definition response exposes ROS in `itemizedSubjectSections` instead.
Existing Ocular/Medical/Social definitions remain in `subjectSections`. No UI files were changed.
The record response adds `subjectSectionSummaries`; the overview uses the same shared projection.

Retraction request: the existing review endpoint accepts `action: "items-review-retracted"`,
`gestureId`, exactly one `targets` entry and `retracts: "Observation/<original>"`, alongside the
patient/encounter/section identity. No method field. It validates the original's patient,
encounter, live status and exact target. A separate immutable Observation uses code
`history-item-review-retraction`, action `items-review-retracted` and `derivedFrom` to the original.
It reuses the existing governed target extension; there is no new extension URL.

A retraction suppresses only its referenced act's contribution to the named target. Answers and
other reviews still contribute their dates. The original act is never edited. Retrying the same
gesture returns the same persisted act; changing kind, target or original refuses. Undo invokes
the shipped Observation void primitive on the retraction itself. The existing conditional-create
and conflict handling mechanic is shared; the old items-reviewed and legacy no-change shapes stay.

## What shipped behaviour does this change?

Social History completeness is unchanged: four required answers, even if tobacco has a review
act. ROS alone declares reviewed_items_min=1; individual and bulk review acts count. A system is
reviewed only when all catalog items are dated at or after this encounter; partial coverage is a
fraction. Positive answers and notes remain visible, even when the review act is retracted.

The overview's ROS clause uses the itemized summary when ROS is Charted, otherwise the legacy
aggregate attestation. Neither representation synthesizes the other. The tests and live proof
preserve a negative legacy answer alongside a positive itemized answer without overwriting either.
Current completeness uses this encounter's entries; historical acts still supply lastReviewed
without making a new encounter Charted. Encounters without a start use only their own dated entries.

## Before and after

| Scenario | Base | Proposed |
| --- | --- | --- |
| Retract A from {A,B} | request unsupported (400) | A contribution removed; B unchanged; original bytes/version unchanged |
| Void that retraction | no retraction to void | A date restored through the shipped primitive |
| Three of eight Eyes items reviewed | no itemized coverage summary | Eyes 3/8; never Eyes reviewed |
| Unknown summary token | empty text | throws |
| One tobacco review, three required answers missing | not Charted | not Charted |
| Charted itemized ROS + legacy aggregate | overview uses aggregate only | overview chooses itemized; aggregate unchanged |

The initial RED run recorded 22 tests: 12 pass, 10 fail for missing ROS behavior. Some RED failures
were missing declaration/renderer APIs. The two canonical registry tests separately failed before
definitions existed. During test setup, a direct UI command from the repository root used the
wrong JSX configuration (React is not defined); rerunning unchanged tests from ui/ passed 25/25.
The first live script used an incorrect literal aggregate system; using the existing exported
system constant fixed the proof harness. No production workaround was introduced for either.

## Checks

- New ROS contracts and definitions: **27 pass, 0 fail, 0 skipped** (`focused.txt`).
- Untouched 1a/1b/1c + 1d-1/1d-2/1d-3 backend regressions: **101 pass, 0 fail** (`regressions.txt`).
  historyTemplateEngine 12; historyAnswerObservation 3; hpiEndpoint 37; hpiPagination 15;
  fhirSearch 9; historyItemReview 23; historyItemReviewDefinitions 2.
- Untouched UI History regressions: **25 pass, 0 fail** (24 component, 1 browser).
- Broader backend including overview: **131 pass, 0 fail** before three additional characterization cases.
- Full backend run: **4,238 tests, 4,181 pass, 0 fail, 57 skipped**. Explicitly ungated; no credentials
  were supplied to that command. Three subsequent characterization tests also pass in the focused run.
- Full UI: **1,235 pass, 0 fail, 0 skipped**.
- MCP build, UI build, script typecheck: exit 0. UI retains its existing chunk-size warning.
- Preflight: **0 warnings, 0 hard blocks**. Proxy census: all 24 backend families covered by 27 entries;
  advisory. `git diff --check`: exit 0.

## Live proof

`node --import tsx mcp/scripts/prove-history-ros.ts` against the existing local synthetic Medplum
stack at 18103: **7 scenarios pass**. Real persistence, retry versions, target retraction,
unchanged original bytes, undo through the void endpoint, conflicting legacy/itemized results,
overview selection and malformed target refusal are exercised (`live-proof.txt`). This uses a
synthetic admin client and does not claim constrained-role AccessPolicy enforcement.

The unchanged pagination test ran on the existing synthetic stack at 18403: **1/1 pass**, including
600/1,001/5,000 answers, 25 acts, indexed exclusion of 600 encounter-scoped answers and HTTP 409 at
5,001 rows across 11 pages (`pagination-live.txt`). Neither stack was restarted or reconfigured.

## Mandate 17

`mutations.txt` contains exact commands, mutations, assertions and source hashes after restoration.

| Mutation | RED | Restored GREEN |
| --- | --- | --- |
| Retraction removes B with A | exit 1 | exit 0 |
| Retraction edits original status | exit 1 | exit 0 |
| Per-item default makes Social Charted on one review | exit 1 | exit 0 |
| Any partial coverage counts as reviewed | exit 1 | exit 0 |
| Unknown-token fallback returns empty | exit 1 | exit 0 |
| Legacy aggregate synthesizes itemized answer on read | exit 1 | exit 0 |
| Remove action CodeSystem registry entry | exit 1 | exit 0 |

## Governance and remaining scope

Mandate 14 ledger rows 62–63 record two-primary-source R4 verification with access dates. The two
local CodeSystem definitions and registry are enforced by tests. Ledger rows themselves are
**documentary, not enforced**. Local ROS slugs are application answer identities; no external
medical terminology code is asserted. The target remains JSON-in-string, so direct endpoint
validation remains load-bearing; tests reject unknown fields, missing sectionKey and wildcards
in each of the four target positions for both actions.

Companion decision/INDEX update: PerformanceOD branch `drbang-iva/history-1d4a-seam`, commit
`0235ef6c`, records the consumer seam as proposed pending separate adjudication. Follow-up folding
is specified in the design but has no current ROS consumer to verify. 1d-4b must consume the new
field and prove that behavior in the browser. No ROS UI, bulk gesture, Social reminder, or merge
is included here. CI and bot status are reported on the PR at its final head.
