# Visit Billing Codes Design

**Date:** 2026-08-11
**Status:** Approved
**Branch:** `drbang-iva/visit-billing-codes`
**Base:** `main` at `21c9a65b`

## Goal

Let a practice enter its licensed billing codes in Fee Schedule settings and let a clinician select, change, or remove one visit-code proposal during an encounter without shipping AMA CPT content. The selection must use the existing `ChargeProposal` lifecycle and materialize only through the existing sign cleanup.

## Non-negotiable boundaries

- No AMA CPT code or descriptor ships in source, data, tests, comments, or this design.
- The practice supplies CPT values at runtime. HCPCS Level II values may ship only after Mandate 14 verification.
- No code recommendation, E/M computation, documentation scoring, auto-selection, superbill, checkout, procedure-charge picker, claim-submission change, diagnosis-catalog change, or coverage rule is included.
- Refraction ships as a fee-schedule concept only. It is excluded from the visit selector and receives no dedicated proposal behavior.
- Diagnosis and coverage ledgers remain untouched. One new procedure-code provenance ledger contains only the two verified HCPCS rows.
- Existing protocol-generated charge behavior remains unchanged. The Phase 5 protocol test file is not edited.
- Visit-proposal laterality is `OU`, but `buildChargeItem` continues to omit laterality. This slice must not add laterality carry-through.

## Shipped concepts

The existing procedure seeds remain. Thirteen concepts join the same Fee Schedule surface:

| Concept key | ODOS label | Shipped billing code | Visit selector |
|---|---|---:|---:|
| `comprehensive-exam-new` | Comprehensive eye exam — new patient | unset | yes |
| `comprehensive-exam-established` | Comprehensive eye exam — established patient | unset | yes |
| `intermediate-exam-new` | Intermediate eye exam — new patient | unset | yes |
| `intermediate-exam-established` | Intermediate eye exam — established patient | unset | yes |
| `office-visit-new-straightforward` | Office visit — new, straightforward | unset | yes |
| `office-visit-new-low` | Office visit — new, low complexity | unset | yes |
| `office-visit-new-moderate` | Office visit — new, moderate complexity | unset | yes |
| `office-visit-established-straightforward` | Office visit — established, straightforward | unset | yes |
| `office-visit-established-low` | Office visit — established, low complexity | unset | yes |
| `office-visit-established-moderate` | Office visit — established, moderate complexity | unset | yes |
| `routine-vision-exam-new` | Routine vision exam — new patient | `S0620` | yes |
| `routine-vision-exam-established` | Routine vision exam — established | `S0621` | yes |
| `refraction` | Refraction | unset | no |

The two HCPCS values and their source-verbatim descriptors are recorded only in `data/code-bindings/visit-billing-codes-phase0-ledger.json`. The UI continues to use the ODOS labels above.

## Fee-schedule representation

`ProcedureFeeScheduleItem` gains optional `billingCode?: string`. Settings exposes a `billingCode` text field while retaining `canCreate: false`.

At the API boundary, a supplied value is trimmed and uppercased. Blank becomes absent. Nonblank values must be alphanumeric; validation does not require a CPT-specific shape and therefore does not reject HCPCS or CPT Category II/III forms.

The existing `ChargeItemDefinition.code` carries both identities:

1. When present, the practice billing coding is first so existing downstream claim-draft readers see the billable value.
2. The ODOS procedure-concept coding remains present and is resolved by its existing code system rather than array position.

Recognized letter-leading values use the existing HCPCS system. Other accepted runtime values use the existing CPT adapter seam. When `billingCode` is absent, only the ODOS concept coding is stored. Saving price, active state, or billing code preserves the other fields and increments the existing definition version.

## ChargeProposal model seam

`ChargeProposal.protocolApplicationId` becomes `protocolApplicationId?: string | null`. Missing or null means manually added. A non-null value, including an invalid or empty value, remains protocol-linked and must resolve to an active confirmed `ProtocolApplication` for the same encounter and patient.

`materializeAcceptedChargeProposals` changes only the linkage condition:

- Protocol-linked proposals receive the existing application validation unchanged.
- Manual proposals skip only that application lookup.
- Units, procedure concept, diagnosis-pointer, patient, money, and safe-integer checks remain unchanged.
- A proposal with `chargeItemRef` does not create another `ChargeItem`; it follows the existing finalized/idempotent path.
- `buildChargeItem` remains the sole projection and continues to omit proposal laterality.

An orphaned protocol proposal must continue to throw. The existing Phase 5 suite must pass without modification.

## Manual visit proposal handler

The protocol module gains a read and mutation route at:

`/clinical-graph/protocols/encounters/:encounterId/visit-charge`

The read requires `chart.read`; mutation requires `chart.write`. Both use the existing authenticated FHIR client and `ProtocolBasicStore<ChargeProposal>`. The handler never writes a `ChargeItem`.

One stable row represents the manual visit selection:

- Proposal id: `manual-visit-code:<encounterId>`
- `planActionRef`: `manual-visit-code`
- `protocolApplicationId`: omitted
- `procedureConceptKey`: one of the twelve visit concept keys
- `units`: `1`
- `laterality`: `OU`
- `state`: `accepted` when selected, `removed` when cleared
- `evidenceRefs`: empty
- `coverageEvaluations`: empty
- provenance: clinician-entered actor and timestamp

On initial creation, `dxPointers` defaults to the one valid `Encounter.diagnosis` Condition reference ranked `1`; otherwise it is empty. Empty pointers never block selection. Changing the visit code preserves the proposal id and existing `dxPointers`. This slice does not add a diagnosis-pointer editor; that remains a flagged follow-up for the future charge panel.

The stable id, manual sentinel, absent application id, and membership in the visit-concept set are checked together. A conflicting row fails closed rather than overwriting a protocol or procedure charge. Any number of other encounter proposals may coexist and are never changed by visit selection.

Removing a selection updates the row to `removed`; it never deletes the Basic. Reselecting revives the same row as `accepted`. A finalized proposal is not rewritten.

## Encounter UI

A compact `Visit code` selector renders below the encounter header so it is present in both diagnosis and structure views. It lists active visit concepts with the ODOS label and the current `billingCode`, or visibly indicates that the value is unset.

The blank option means no selected visit proposal. Initial load never selects a value. Changes persist immediately through the manual proposal route. The control adds no modal, toast, required step, signing gate, or dismissal click. Load or save failure is shown inline and does not block charting or signing.

Refraction and all non-visit procedure concepts are excluded from the options.

## CPT-literal guard

A test scans shipped files under `mcp/src`, `ui/src`, and `data` for standalone CPT-shaped tokens in strings, comments, and data text. The scanner distinguishes procedure-shaped text from program quantities, dates, ports, pixel values, hyphenated terminology codes, and URL components. Existing Markdown verification ledgers under `data/code-bindings` remain byte-identical; the scanner may exclude those paths or allowlist an exact file-and-token pair. Any remaining allowances are exact file-and-token entries for pre-existing non-procedure values; the list must stay small and named.

The guard reports the file, line, and rejected token. A mutation proof temporarily inserts a prohibited five-digit string into the shipped visit seed, records the exact failing output, removes the mutation, and records the green output. No prohibited value remains in the branch, tests, documentation, or PR diff.

Existing files under `mcp/tests` and existing Markdown files under `data/code-bindings` remain byte-identical. The diagnosis and coverage ledgers are not changed.

## Mandate 14 ledger

`data/code-bindings/visit-billing-codes-phase0-ledger.json` follows the existing phase-0 shape with `mandate`, `accessDate`, `sources`, and two code rows only. Each row copies the exact code and descriptor from two agreeing CMS Alpha-Numeric quarterly files accessed on 2026-08-11:

- April 2026 Alpha-Numeric HCPCS file
- July 2026 Alpha-Numeric HCPCS file

The ledger contains no coverage statements, diagnosis families, CPT content, or procedure-to-diagnosis mapping.

## Verification design

TDD cycles must prove:

1. Thirteen new concepts seed into Fee Schedule; only the two verified HCPCS rows are prefilled.
2. `billingCode` normalizes, persists on `ChargeItemDefinition`, round-trips after reload, and may remain absent.
3. A manual accepted proposal materializes without a protocol application.
4. A proposal with a populated but missing application still throws.
5. Existing protocol materialization and the untouched Phase 5 suite remain green.
6. Visit selection creates at most one manual visit proposal and never changes other proposals.
7. Change preserves diagnosis pointers; remove marks the proposal removed; reselect revives it.
8. Principal diagnosis defaults only on initial creation; no principal produces an empty list without blocking.
9. The selector is passive, starts blank, excludes refraction, and exposes unset concepts.
10. Materialization carries the configured billing code when present and still records a concept-only charge when it is unset.
11. For a materialized charge whose concept has a billing code, the existing positional `firstCoding()` claim path returns that billing code and its system rather than the ODOS concept key. This contract is pinned in a new MCP test without editing existing `mcp/tests` files.
12. End to end: select a visit code, observe an accepted manual proposal with absent `protocolApplicationId`, sign, and inspect a created `ChargeItem` carrying the visit concept, configured billing code, and principal diagnosis pointer.
13. The lexical guard is mutation-proven red then green.

Final gates are the exact commands from the brief: root preflight, MCP build and full tests, UI build and full tests, focused protocol Phase 5 execution, the lexical grep, rendered encounter evidence, stored `ChargeItemDefinition`, stored manual proposal, and resulting `ChargeItem` resources.

## Explicit non-goals and follow-ups

- A future procedure-charge picker may create additional manual `ChargeProposal` rows for refraction, imaging, pachymetry, gonioscopy, and other procedures.
- A future charge panel may edit diagnosis pointers and coverage review state.
- A separate slice may project laterality to `ChargeItem` without changing this slice's protocol behavior.
- A pre-existing claim defect remains for concepts without `billingCode`: the positional claim assembler can submit the ODOS concept coding as `productOrService`. This slice narrows that defect for configured concepts but does not decide whether uncoded lines should be blocked, warned, or omitted. The PR body must state this risk plainly.
- Claims, invoices, checkout, superbills, automated coding, and retrospective ChargeItem rewrites remain out of scope.
