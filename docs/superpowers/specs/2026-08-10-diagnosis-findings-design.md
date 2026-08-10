# Diagnosis Findings Design

**Status:** approved by the operator on 2026-08-10

## Scope

Replace the selected-diagnosis findings placeholder with an offered/charted findings table, add explicit finding presence, populate the unassigned-findings rail zone, and expose the same encounter findings in the structure view. This is slice 2 of 4. It does not add prior-exam carry-forward, protocol actions, specificity, MDM changes, or changes inside the 39 section components.

## Clinical state model

`FindingInstance.presence` is required and accepts only `present` or `absent`. Presence is independent of `FindingInterpretation`; neither field supplies, defaults, or implies the other. The UI and storage distinguish:

- no atomic or section assertion: never asked;
- an offered gradeable row without a grade: grade unanswered;
- `presence: present` plus `interpretation: normal`: present-and-normal;
- `presence: absent`: examined and explicitly absent.

Offered rows never default either presence value. An absence is created only by a clinician action.

## FHIR Observation representation

Each diagnosis-workspace assertion is one atomic `Observation` with an ODOS-local finding code, encounter, subject, laterality, provenance, and top-level `valueBoolean`:

- `true` means present;
- `false` means absent;
- no atomic Observation means no atomic presence assertion.

Top-level `Observation.valueBoolean` is reserved exclusively for presence on finding Observations. A boolean clinical value is stored as an `Observation.component.valueBoolean`, never as the top-level value. The projector enforces this distinction and tests cover the collision.

Grade is an optional component using only the configured grade scale from the finding definition. No grade component is written until the clinician chooses a grade. The structure definition stable key and atomic option code form the local finding identity; display and section tag come from the catalog definition.

The existing referral renderer needs no special branch: it renders the finding label with `Yes` or `No`, so an absent atomic finding reads as `<finding>: No`. This slice covers that behavior with a focused regression test and does not change referral formatting.

## Diagnosis binding ownership

The binding has one storage home: the diagnosis `Condition.evidence.detail` references the finding Observation. The Observation does not store a reverse diagnosis edge and does not use `Observation.focus`.

Assigning a finding appends its Observation reference to `Condition.evidence.detail` only when the reference is not already present. Reassigning removes the reference from other visit diagnosis Conditions before appending it to the selected Condition. Recording standalone removes any visit-diagnosis evidence reference and leaves the Observation intact. The read model derives finding-to-diagnosis direction by indexing visit Conditions' evidence references.

This reuses the existing Condition evidence contract and avoids overloading `Observation.focus`, which already means Device focus for Ortho-K and has an unreliable Medplum search path in this repository.

## Offered findings read model

A dedicated encounter findings endpoint reads the diagnosis catalog, finding definitions, visit Conditions, and encounter Observations. For the selected diagnosis it returns:

- the diagnosis definition and its materialized `applicableFindingDefinitionIds`;
- offered atomic finding rows expanded from existing diagnosis-candidate mappings;
- charted atomic rows bound through Condition evidence;
- structure-charted rows normalized from the latest section Observation per section and laterality;
- the searchable full atomic catalog;
- unassigned rows and a structure-key grouping projection;
- `canWrite`.

Materializing `applicableFindingDefinitionIds` exposes the existing diagnosis-definition field. It does not persist a second reverse index. Atomic rows are deduplicated by finding identity plus laterality. Charted rows sort before offered rows.

Existing structure Observations may be grouped under an existing visit diagnosis only when their configured mapping yields exactly one matching visit Condition. Zero or multiple matches stay unassigned. This grouping does not propose, create, or persist a diagnosis.

## Mutation route

The mutation endpoint accepts explicit actions:

- assert `present` or `absent`;
- clear an atomic assertion;
- set or clear a grade;
- set or clear an explicit laterality override;
- assign an Observation to one visit diagnosis;
- record an Observation standalone.

The endpoint validates patient, encounter, finding identity, grade membership, laterality, and visit-diagnosis membership at the boundary. Repeating the same assertion updates the existing logical Observation instead of creating a duplicate. Clearing changes that Observation to `entered-in-error`; it does not delete clinical history. New Observations are preliminary and use the existing clinical write-source headers and provenance pattern.

GET requires `chart.read`; mutation requires `chart.write`. Each registered route has direct 401 and 403 tests.

## UI

The selected diagnosis renders an aligned findings table with clinical labels: Finding, Exam section, Presence, Grade, Laterality, and Finding actions. Offered rows are muted; charted rows are solid and float to the top. Clicking an offered row asserts present. A separate minus affordance asserts absent. Gradeable rows render an explicit unanswered option. Inherited laterality is muted; an override is solid.

The footer search orders selected-diagnosis candidates before the full catalog. Re-clicking an asserted presence clears it; all actions refresh the read model.

The diagnosis rail renders the reserved Unassigned findings zone only when populated. Each row can be assigned to a visit diagnosis or recorded standalone. The tray never suggests or creates a diagnosis.

The structure view receives a lightweight overlay grouped by the endpoint's controlled section key. It shows atomic findings charted from the diagnosis side without changing any section component. Existing structure charting appears in the diagnosis read model after the view reloads.

## Testing and proof

Tests are written first and observed red before implementation. Coverage includes:

- presence round-trip for present and absent, including reload;
- boolean clinical value stored in a component while presence stays top-level;
- binding through idempotent `Condition.evidence.detail` append, reassignment, and standalone;
- offered rows from materialized applicable definition IDs;
- latest structure Observation normalization and unique/ambiguous/unmatched grouping;
- add/search ordering, grade validation, laterality inheritance/override, and logical deduplication;
- separate GET and mutation 401/403 route tests;
- rendered charted, offered, absent, unassigned, and by-structure overlay states;
- referral rendering of an absent finding as `<finding>: No`.

Mutation proof removes the `valueBoolean: false` projection and the Condition evidence append in turn; the named tests must fail, then pass after restoration.

Final proof includes all requested TypeScript, full-suite, preflight, production-build, exact-head eval-worktree, screenshot, and PR-review gates.
