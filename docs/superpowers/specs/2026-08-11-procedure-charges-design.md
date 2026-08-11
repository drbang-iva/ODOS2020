# Encounter Procedure Charges Design

**Date:** 2026-08-11
**Status:** Approved with Amendment 1 conditions
**Branch:** `drbang-iva/procedure-charges`
**Base:** `main` at `137c742c`

## Goal

Extend the shipped single visit-charge selector into a complete encounter charge surface without changing the visit proposal's identity or lifecycle. A clinician may add any number of manual non-visit procedure charges, select each procedure's laterality and one diagnosis pointer, edit those choices before sign, and remove or revive each procedure independently. Accepted proposals continue to materialize only through the existing sign-cleanup path.

The prerequisite correctness fix is part of the same pull request but remains independently reviewable: charge laterality is projected into FHIR `ChargeItem.bodysite`, and professional claim laterality comes only from that FHIR element. Diagnosis laterality is never used as a substitute for what was performed.

## Non-negotiable boundaries

- No coverage, frequency, duplicate-billing, or payer-rule behavior.
- No automatic charge creation from diagnoses, findings, protocols, or documentation.
- No ranking, scoring, or recommendation of diagnosis pointers.
- No superbill, checkout, or claim-submission change beyond the laterality data path required by this design.
- No shipped CPT value or descriptor. The existing CPT guard remains green.
- No diagnosis-catalog, diagnosis-ledger, code-binding Markdown, or `FAMILY_RESOLUTION_MODES` change.
- No change to protocol proposal generation, protocol identities, protocol removal, or Phase 5 fixtures.
- No third-party scribe or cloud dependency.
- Adding nothing creates no modal, toast, required field, sign gate, or dismissal click.

## Confirmed current-state seam

At the approved base:

- `ChargeProposal.laterality` is required and accepts `OD`, `OS`, or `OU`.
- `buildChargeItem` does not read proposal laterality and emits no `ChargeItem.bodysite`.
- FHIR R4 `ChargeItem.bodysite` is `CodeableConcept[]`.
- `buildClaimDraft` derives a synthetic line-level laterality from linked `Condition.bodySite` values.
- `ProfessionalClaimChargeItemInput` adds a non-FHIR `laterality` property.
- `buildProfessionalClaim` copies that synthetic property into `Claim.item.bodySite.text`.
- Persisted-charge submission currently lets the request's synthetic laterality override the stored FHIR resource.

Populating `ChargeItem.bodysite` alone would therefore not reach the claim. The claim adapter and persisted-charge submission path must be corrected with the projection.

## Laterality source-of-truth contract

### Proposal and materialized ChargeItem

`ChargeProposal.laterality` becomes optional. Existing protocol proposals and the existing manual visit proposal continue to carry their current values. A new manual procedure proposal omits the property until the clinician selects `OD`, `OS`, or `OU`.

`buildChargeItem` remains the sole proposal-to-charge projection. When laterality is present, it emits exactly one `ChargeItem.bodysite` entry:

- `coding.system`: `https://odos2020.com/fhir/CodeSystem/laterality`
- `coding.code`: the selected `OD`, `OS`, or `OU`
- `text`: the same selected value

When laterality is absent, `bodysite` is absent. There is no default to `OU` and no diagnosis lookup.

This projection applies equally to existing protocol-generated proposals and new manual proposals. Focused protocol materialization tests must prove the existing proposal laterality now reaches `ChargeItem.bodysite` while the untouched Phase 5 suite remains green.

### Claim draft and submission

Professional claim laterality comes only from the FHIR ChargeItem being billed:

1. `buildClaimDraft` reads recognized `OD`, `OS`, or `OU` values from `ChargeItem.bodysite` and never reads `Condition.bodySite` for laterality.
2. The UI may keep a flat `laterality` display field in its editable draft model, but `buildProfessionalClaimInput` converts that value into `ChargeItem.bodysite`; it does not create a synthetic server property.
3. `ProfessionalClaimChargeItemInput` no longer declares a non-FHIR `laterality` property.
4. `persistClaimChargeItems` uses the stored `ChargeItem.bodysite` for a persisted charge and cannot accept a request-only laterality override. For an idless manual charge, any selected UI laterality is first represented as FHIR `bodysite` and persisted with the ChargeItem.
5. `buildProfessionalClaim` reads the ChargeItem's `bodysite` and emits the resulting value as `Claim.item.bodySite.text`.

An explicitly selected procedure laterality therefore wins because it is the only source. A bilateral diagnosis linked to an OD procedure produces OD on both the ChargeItem and Claim. A ChargeItem without laterality produces a Claim item without laterality even when its linked diagnosis is lateralized.

### Bodysite conflict warning

The diagnosis-conflict warning is removed because diagnosis body sites no longer participate in claim laterality.

The warning is deliberately repurposed only for malformed ChargeItem input: if one `ChargeItem.bodysite` array contains more than one distinct recognized laterality value, claim-draft assembly omits laterality and reports:

`ChargeItem/<id> omitted laterality because bodysite contains conflicting laterality values.`

Zero recognized laterality values means laterality is simply absent; that is a valid state and produces no warning. Non-laterality anatomy values are not reinterpreted as laterality.

## Enumerated claim-output changes

| Existing input | Previous output | New output | Reason |
|---|---|---|---|
| ChargeItem has no bodysite; one linked diagnosis has laterality | Claim inherited diagnosis laterality | Claim has no laterality | A diagnosis describes disease scope, not what procedure was performed. |
| ChargeItem has no bodysite; linked diagnoses disagree | Claim omitted laterality and emitted a diagnosis-conflict warning | Claim has no laterality and no warning | Diagnosis body sites are no longer claim-laterality inputs. |
| ChargeItem has OD bodysite; linked diagnosis is OU | Existing encounter-generated ChargeItems could not represent this path | Claim has OD | Performed-procedure laterality is authoritative. |
| ChargeItem has one recognized bodysite value | Synthetic request field was needed to reach Claim | Claim receives the value directly from ChargeItem bodysite | Removes the non-FHIR transport seam. |
| Persisted ChargeItem has bodysite and request attempts a different synthetic laterality | Request value could override stored state | Synthetic override is not part of the input contract | Persisted FHIR state is authoritative. |
| ChargeItem bodysite contains conflicting recognized values | Not handled as a ChargeItem conflict | Claim omits laterality and emits the repurposed warning | Fail visibly instead of choosing an eye. |

The pull request body must reproduce this inventory and list every changed existing test by name. At the approved base, the dx-derived assertions are in `mcp/tests/claimDraft.test.ts`:

- `buildClaimDraft reads ranked confirmed diagnoses and real per-charge pointers from a signed encounter` currently expects OS from `Condition/dx-b` and the diagnosis-conflict warning.
- `claim draft expands one bilateral eyelid Condition into two sequenced diagnoses and binds its charge to both` currently expects OU from the linked bilateral Condition.

Both expectations must change because neither ChargeItem currently has `bodysite`. Separate tests will then cover explicit ChargeItem bodysite, absent bodysite, conflicting ChargeItem bodysite, and OD procedure against an OU diagnosis.

The existing transport tests that populate the synthetic `laterality` property must be converted to populate FHIR `bodysite`. They are transport-contract updates rather than dx-derivation changes:

- `mcp/tests/claimmdFhir.test.ts` — `buildProfessionalClaim and Claim.MD preserve real per-line diagnosis pointers`
- `mcp/tests/claimHandlers.test.ts` — `submit reuses a stored ChargeItem without dropping its draft diagnosis pointers`
- `mcp/tests/claimHandlers.test.ts` — `submit persists idless ChargeItems once while keeping the Claim.MD payload on the original input shape`
- `ui/tests/submitClaims.test.tsx` — `encounter-prefilled lines preserve persisted ids, coding systems, diagnosis pointers, and laterality`

The pull request body must distinguish these four transport updates from the two corrected dx-derived expectations above.

## Procedure fee options

The procedure selector offers active non-visit concepts from the existing fee schedule only. The twelve keys in `VISIT_PROCEDURE_CONCEPT_KEYS` are excluded. Existing procedure concepts, including refraction and the five pre-existing protocol procedure concepts, remain available when active.

No new clinical code or fee concept is seeded. Billing code remains optional and practice-supplied. An option without a billing code is visibly labeled `Code unset`.

## Manual procedure proposal identity

Each row has a server-generated stable id with the prefix `manual-procedure-charge:` and a random UUID suffix. Its `planActionRef` is the same stable id. The row has:

- `protocolApplicationId`: absent
- `encounterId`: the route encounter
- `procedureConceptKey`: one active non-visit fee concept
- `units`: `1`
- `laterality`: absent, `OD`, `OS`, or `OU`
- `dxPointers`: empty or exactly one local Condition reference from this Encounter
- `evidenceRefs`: empty
- `coverageEvaluations`: empty
- `state`: `accepted`, `removed`, or `finalized`
- clinician-entered provenance with actor and timestamp

The procedure concept is immutable for a stable row. Selecting a different procedure creates a different row; it never rewrites an existing proposal into another charge.

The API permits multiple rows with the same procedure concept. It does not infer that a repeated concept is a duplicate or apply a frequency rule.

Removal is a soft state change to `removed`. Reviving the same proposal id changes it back to `accepted` while preserving its concept, laterality, diagnosis pointer, and identity. A finalized proposal or proposal with `chargeItemRef` is immutable.

## Isolation rules

Procedure handlers may mutate a proposal only when all of these are true:

- the id has the manual-procedure prefix;
- the proposal belongs to the route Encounter;
- `protocolApplicationId` is absent or null;
- `planActionRef` equals the stable proposal id;
- the concept is non-visit.

An id collision or mismatch returns a conflict and changes nothing. A protocol-generated proposal is never replaceable, removable, or revivable through this surface. The stable visit proposal is never replaceable, removable, or revivable through this surface.

The existing visit route retains its single stable proposal, identity validation, selector, and lifecycle. Its resolver must continue to ignore valid manual procedure proposals. Tests must prove both directions:

- procedure create, edit, remove, and revive leave the visit proposal byte-equivalent;
- visit change and removal leave every manual procedure proposal byte-equivalent;
- protocol proposals on the same Encounter remain byte-equivalent throughout both workflows.

## Encounter diagnoses

The read response offers the Encounter's valid local `Condition/<id>` diagnosis references in Encounter rank order, with a human display and rank where present. The server reads the referenced Conditions for labels but does not score, filter, or recommend them.

Creation defaults `dxPointers` to the one valid local Condition reference ranked `1` when exactly one such principal exists. Otherwise it starts empty. Laterality does not participate in that choice.

The clinician may set one offered diagnosis reference or clear the pointer at any time before sign. The server validates that the selected reference is present in this Encounter's diagnosis list. One procedure remains one charge with at most one pointer even when several diagnoses might justify it.

Empty `dxPointers` and absent laterality never block creation or sign cleanup.

## API surface

The protocol module adds:

- `GET /clinical-graph/protocols/encounters/:encounterId/procedure-charges`
  - requires `chart.read`;
  - returns active non-visit options, Encounter diagnoses, and all manual procedure proposals including removed rows.
- `POST /clinical-graph/protocols/encounters/:encounterId/procedure-charges`
  - requires `chart.write`;
  - accepts one active non-visit `procedureConceptKey`;
  - creates one stable accepted proposal with absent laterality and the principal-pointer default.
- `PATCH /clinical-graph/protocols/encounters/:encounterId/procedure-charges/:proposalId`
  - requires `chart.write`;
  - changes only `laterality`, the single `dxPointer`, or state between `accepted` and `removed`;
  - rejects an empty patch and all identity, Encounter, visit, protocol, inactive-concept, foreign-diagnosis, and finalized conflicts before saving.

The handlers write only `ChargeProposal` Basic rows. They never write a ChargeItem directly.

## Encounter UI

The existing `VisitCodeSelector` remains a separate control and keeps its current API. A sibling `ProcedureChargeList` renders below it in the Encounter header surface.

The add row contains:

- a non-visit procedure selector starting blank;
- an `Add procedure` button disabled until a procedure is selected.

Adding uses the server's principal-diagnosis default and leaves laterality unset. There is no automatic charge.

Each accepted procedure row shows and edits:

- procedure concept label;
- billing code or `Code unset`;
- laterality selector with `Laterality unset`, `OD`, `OS`, and `OU`;
- diagnosis selector with `No diagnosis selected` plus every offered Encounter diagnosis;
- `Remove`.

Removed rows are retained in server responses for lifecycle evidence but hidden from the normal active list. Revive behavior is proven through the API; this slice adds no history panel, restore button, or extra workflow.

Load and save failures render inline within the procedure list. They do not block the visit selector, other charting, or sign. Migrated encounters remain read-only through the existing disabled state.

## Materialization and lifecycle

Sign cleanup continues to select accepted proposals for the Encounter. Manual procedure proposals use the same validation, fee-definition resolution, pricing, idempotency identifier, ChargeItem creation, diagnosis-pointer projection, and finalization path as visit and protocol charges.

The only shared materializer changes are:

- allow `laterality` to be absent;
- project it to `ChargeItem.bodysite` when present.

No direct materialization route, coverage evaluation, frequency warning, retrospective rewrite, or duplicate-procedure warning is added.

## Test design

### Independently reviewable laterality group

Focused tests separate from procedure-list tests must prove:

1. OD, OS, and OU proposal values each materialize as one matching `ChargeItem.bodysite` entry.
2. An absent proposal value emits no `bodysite`.
3. Existing protocol-generated proposal laterality reaches `ChargeItem.bodysite` without changing protocol state or identity.
4. Claim draft uses ChargeItem bodysite when the linked diagnosis has a different laterality.
5. Claim draft emits no laterality for an absent bodysite even when the linked diagnosis is lateralized.
6. Conflicting diagnosis body sites no longer emit a laterality warning.
7. Conflicting recognized ChargeItem bodysite values omit laterality and emit the repurposed warning.
8. Persisted ChargeItem submission cannot be overridden by a non-FHIR request laterality field.
9. Professional Claim item bodySite is produced from the persisted ChargeItem bodysite.

Required mutation proof: remove the `buildChargeItem` bodysite projection, run the focused claim-laterality test, record the expected red output, restore the projection, and record the green output.

The PR body gets a standalone `Claim laterality correctness fix` section containing the behavior table, changed-test inventory, focused commands and counts, mutation red/green evidence, and the OD-procedure/OU-diagnosis resulting Claim item.

### Procedure-list group

Focused handler and UI tests must prove:

1. Any number of manual procedure proposals coexist with the stable visit proposal and protocol proposals.
2. Only active non-visit fee concepts are offered.
3. Each new row has a unique stable manual identity, absent protocol application, absent laterality, and the correct principal default.
4. No principal produces an empty pointer without blocking creation.
5. Laterality and the one pointer can be changed or cleared independently.
6. Removal and revival preserve identity and all other row fields.
7. Procedure mutations reject visit, protocol, foreign-Encounter, malformed, inactive, foreign-diagnosis, and finalized targets without collateral writes.
8. Visit mutation leaves every procedure and protocol proposal byte-equivalent.
9. The UI starts with no procedure selected, shows explicit unset states, adds no charge by itself, and keeps failures inline and non-blocking.

Required mutation proof: weaken procedure removal so it can target the visit proposal, run the isolation test, record the expected red output, restore the guard, and record the green output.

### Behavioral acceptance evidence

The focused end-to-end fixture must show:

1. One visit plus three manual procedures as four simultaneous accepted proposals and four resulting ChargeItems.
2. Removing one procedure leaves the visit, two other procedures, and protocol proposals unchanged.
3. Changing the visit leaves all procedures and protocol proposals unchanged.
4. An OD procedure materializes OD bodysite and produces an OD professional Claim item.
5. The same OD procedure linked to an OU diagnosis remains OD.
6. Choosing one of three Encounter diagnoses produces one proposal with exactly that one pointer.
7. Protocol-generated charges remain unchanged throughout.
8. Untouched protocol Phase 5 tests pass.
9. The CPT guard passes.

The evidence records proposal and ChargeItem objects from synthetic fixtures only. It contains no PHI or practice data.

## Final gates

Run and report the real output, totals, failures, and skips for:

```text
npm run preflight
cd mcp && npm run build
cd mcp && npm test
cd ui && npm run build
cd ui && npm test
```

Also report focused laterality tests, focused procedure-list tests, untouched protocol Phase 5 execution, both mutation proofs, the CPT guard, and `git diff --check`.

## Pull request and evaluation

The branch opens a non-draft pull request against `main`. Its body contains:

- summary and hard scope fences;
- a standalone claim-laterality section with every changed behavior and changed existing test;
- focused and full-gate commands with real counts;
- all nine behavioral acceptance results;
- both mutation proofs;
- synthetic proposal, ChargeItem, and Claim-item evidence;
- exact-head Greptile and PR-Agent status plus unresolved-thread count;
- explicit statement that Codex authored the change and did not evaluate it.

The pull request is not merge-ready until an independent Fable/Opus evaluation runs against the exact final head.

## Design decisions and follow-ups

- Keep one pull request because laterality projection is a prerequisite of usable per-eye procedure charges, while keeping the claim fix independently testable and independently documented.
- Keep visit and procedure APIs separate because their identity and cardinality rules differ.
- Do not introduce a generic charge-management abstraction.
- Do not add a removed-charge history surface in this slice; retained Basic state and explicit revive behavior preserve the lifecycle seam.
- Do not add coverage or frequency rules until verified `ProcedureChargeRule` data exists.
- No new PerformanceOD decision or ODOS `decisions/INDEX.md` entry is required because Amendment 1 supplies the controlling human-approved ruling and this document is its implementation design.
