# Diagnosis Carry-Forward Design

**Status:** approved by the operator on 2026-08-10

## Scope

Add slice 3 of 4: an automatically rendered Previous exams zone, unbounded encounter paging through the patient's recorded history, explicit one-diagnosis pull-forward, and visible copy-forward provenance. The slice reuses the existing diagnosis workspace, diagnosis-pick identity, and diagnosis-findings model. It does not change by-structure behavior, section component internals, protocols, MDM, claims, PM scenes, scheduling, or backup/DR.

## Previous-exam read model and bounds

The server returns four prior encounters per page. Four is the only encounter-page size and is stated in the API payload. The first request starts before the current encounter date; later requests follow the FHIR search bundle's standard `next` link through an opaque, server-validated cursor. There is no total encounter cap. The client appends pages as a visible Load older encounters sentinel enters view and keeps the control keyboard-accessible as a manual fallback.

Every returned encounter includes all references in `Encounter.diagnosis`; diagnoses within an encounter are deliberately unbounded. Each diagnosis includes its recorded display, exact coding identity, laterality, active explicit finding snapshots, checked/current-condition state, and visit date/type. Conditions with `refuted` or `entered-in-error` verification status are excluded. Finding snapshots come only from active evidence-linked Observations with an explicit top-level boolean presence; no finding, grade, laterality, or diagnosis is inferred.

The empty-history response is a successful page with no encounters and no cursor. The UI renders the plain empty state `No previous exams recorded.` without an empty framed list.

## Diagnosis identity and idempotency

Diagnosis matching always includes laterality. For ODOS catalog diagnoses, the existing catalog stable key and the exact right/left/bilateral/unspecified bucket form the identity. A previous Condition without an ODOS catalog identifier uses its literal sorted coding set plus literal Condition text and laterality; this is exact recorded identity, not a terminology crosswalk or clinical inference.

The read model marks every matching prior row checked and supplies the current Condition reference. Clicking a checked row only selects that current Condition. The pull endpoint repeats the same match under the write lock boundary; if a concurrent or repeated request finds the diagnosis already present, it returns the existing reference without creating or changing resources.

## Atomic pull transaction

An unchecked pull validates the current Encounter, source Encounter, source Condition, patient, diagnosis membership, and non-retracted state. It re-reads the current Encounter immediately before building the write bundle and computes the new rank as `max(existing positive rank) + 1`; rank gaps are preserved.

One FHIR transaction contains:

1. a POST for a new confirmed encounter-diagnosis Condition with the prior code and laterality values, rewritten ODOS visit identifier when available, and evidence references only to new present-finding Observations;
2. a PUT for the current Encounter with `If-Match` and one appended diagnosis component;
3. one POST per prior-present explicit finding, each a new preliminary Observation on the current encounter with copied grade and laterality values;
4. one POST Provenance resource targeting the new Condition, current Encounter, and new finding Observations and identifying the immediately prior Condition plus all prior explicit finding Observations as source entities.

Transaction resources use `urn:uuid:` full URLs so references are resolved atomically by the FHIR server. Any failed entry fails the whole operation. Prior resources are never mutated, and current resources never reuse a prior Observation as the charted finding.

Prior-absent Observations are source entities in the same Provenance but do not receive current-encounter Observation copies. The findings read model resolves those source Observations into offered rows showing the prior absent value, grade, and laterality. Reasserting absent or changing it to present remains one explicit clinician click.

## Provenance and edit aging

Carry Provenance is identified by the existing FHIR Provenance activity code `CREATE` with activity text `Diagnosis pull-forward`; no new medical code, terminology artifact, or canonical URL is introduced. The carry resource links the new targets to the immediately prior source resources.

The read model computes, rather than stamps, display state:

- `pulled from <date>` comes from the source Condition's encounter;
- `edited` means a later Provenance targets the carried Condition or any of its new finding Observations;
- a finding keeps its `carried` tag only while its carry Provenance is the latest Provenance targeting that Observation;
- `unchanged since <date>` walks the actual prior-Condition carry chain while each source Condition remained unedited, stopping at the oldest unedited source encounter;
- a detected provenance cycle stops traversal and returns a visible provenance-integrity warning. Cycle detection is not a history cap.

Existing finding mutations already create target Provenance. Diagnosis laterality changes already create target Provenance. The encounter diagnosis problem-status update is narrowed to target both the Encounter and the affected Condition so that a status edit flips this diagnosis's carry state. Rank-only changes remain Encounter ordering edits and do not claim that the clinical diagnosis values changed.

## UI

Previous exams sits between This visit and Common in the diagnosis rail and loads automatically. Encounters are newest first, labeled with recorded date and visit type. Each diagnosis is a checkbox-like clinical row showing display, laterality, and all explicit finding/grade summaries. Checked rows select the matching This visit diagnosis; unchecked rows invoke the atomic pull.

The selected workspace header renders a provenance line whenever the diagnosis came from a previous exam. Unedited carries and edited carries have distinct text and appearance. The findings table renders `carried` only for unchanged present copies and renders prior absent values as offered history, not charted assertions.

The component uses the existing dark-default appearance tokens and appearance modes. No change is made to the by-structure view's behavior.

## Authorization, failure behavior, and proof

GET previous exams requires `chart.read`; POST pull requires `chart.write`. Both methods have direct 401 and unauthorized-role 403 tests. Boundary failures return explicit 4xx responses; transaction conflicts return 409 and require reload/retry. The UI preserves already loaded pages on a later-page failure and displays the named error beside the paging control.

Tests are written and observed red before implementation. Server coverage includes page ordering/cursors, all-diagnoses-per-encounter behavior, retraction filtering, laterality-safe identity, atomic transaction content and `If-Match`, present versus absent handling, rank-gap preservation, idempotency, rollback response handling, provenance aging, and 401/403 cases. UI coverage includes automatic history load, checked selection, unchecked pull, multi-page append, empty state, carried/offered distinctions, edit aging, and the three-encounter unchanged chain.

Mutation proof removes the current Encounter transaction entry, the absent-as-offered projection, and the laterality portion of the identity in turn; the named tests must fail, then pass after restoration.
