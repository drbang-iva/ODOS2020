# Guarantor G-2a author bundle

**NOT EVALUATED. Do not merge without a fresh independent evaluation at the PR head.**

The demographics editor now contains a separately saved Responsible parties control. Editing a guarantor updates its Person first, then each linked RelatedPerson with conditional writes. Results identify each patient. Reopening classifies projection differences and offers repair even with a clean form. Repair reads the current Person and writes only divergent children using fresh versions.

Base: `9cdc65f73c6767d0546d8c5b9625e0efed1c0129`. Application source verified at `2f7d9471d9fa818e99652f5f26affcee7a27a7da`; later evidence-only commits do not change these source bytes.

## Files and commits

- `mcp/src/clinic/responsible-party-demographics.ts` and `patient-registration-endpoint.ts`: one shared demographic builder/projection. Extracted the Person caller in `9304b2c6`, checked G-1 11/11, then migrated RelatedPerson in `9d1ccf9e`, checked 11/11 again.
- `ui/src/lib/guarantor-editor.ts`: indexed reads, cardinality refusal, preflight, parent-success barrier, conditional child writes, trailing-parent verification, and selective repair.
- `ui/src/components/patient/ResponsiblePartiesControl.tsx` and `PatientDemographicsEditor.tsx`: independent control, raw name/contact/address preservation, patient-specific results, clean-form repair, and dirty-repair refusal.
- `ui/tests/guarantorPropagation.test.tsx` and `guarantorEditor.test.tsx`: 15 transport-backed guards and 4 rendered-control tests.
- `ui/tests/fixtures/guarantor-live.html` and `.tsx`: production PatientRoute/PatientOverview browser fixture.
- `docs/build-log/guarantor-g2a/`: sanitized evidence and reproduction scripts.
- `c205a96c`: editor/writer/guards. `2f7d9471`: explicit superseded repair status and appearance-token correction.

## Verification

See `baseline/README.md` and `final/README.md` for commands, exact counts, durations, and limitations. All eight requested focused inventories retain **49 / 99 / 32 / 29 / 11 / 20 / 3 / 17**, with zero failures/skips. New focused guards: **15 writer + 4 UI**, all passing. Both package builds pass. Preflight: **0 warnings, 0 hard blocks**. Proxy census: all 24 backend route families covered by the existing 27 proxy entries (advisory only).

The complete UI suite at the final application source has **1,468 passed, 0 failed, 0 skipped**, exit 0.

The complete MCP suite has **4,704 tests: 4,656 passed, 0 failed, 48 skipped**. Its wrapper exits 1 because 41 tracked live-stack tests are unconfigured. This is unchanged from base and does **not** establish authorization coverage; no opt-out was used. The dedicated synthetic staff HTTP proof covers this slice's existing Person and RelatedPerson write authority.

## Every required guard was broken and restored

The complete focused suite is green after restoration. Each listed writer mutation produced one failed test; 18 independent writer mutations were executed. UI mutations additionally caught handler bypasses and loss of loaded contact data. No required guard in this inventory is decorative.

| Guard | Observed green | Deliberate break producing red |
|---|---|---|
| Q1 | Persisted Person and children have edited name, phone, address | Omit child writes |
| Q2 | Fresh child's SMS resolution yields new phone | Omit propagation; independent resolver assertion |
| Q3 | Both children's distinct role/legal fields, periods, unrelated extensions preserved | Flip one child's consent sentinel |
| Q4 | No outgoing Patient write; Patient reread unchanged | Issue unchanged Patient PUT |
| Q5a | Stale parent in preflight means zero writes | Skip version preflight |
| Q5b | Parent becomes stale after preflight; parent 412, no children | Remove parent If-Match |
| Q6a | Stale child in preflight means zero writes | Skip version preflight; independent child assertion |
| Q6b | Late child conflict preserves competitor and identifies Leo | Remove child If-Match |
| Q7 | Both link orders update A/B by id; decoy unchanged | Update only first linked child |
| Q8 | Fail A, then B; correct patient labeled; unreadable/lost results unknown | Label by guardian; classify unknown as mismatched |
| Q9a | Repeat converged edit writes nothing | Remove unchanged short circuit |
| Q9b | Repair writes only divergent B; second pass zero writes | Rewrite converged children |
| Q9c | Prior generation explicitly superseded; current generation reconciled | Use prior Person; independently remove structured superseded status |
| Q10 | Zero Person match read-only; direct save handler refuses creation | POST Person despite disabled control; bypass writer refusal |
| Q11 | Clean mount offers repair for mismatched patient | Discard mount classification |
| Q12 | Multiple Person matches refused with ids | Pick first Person / bypass save cardinality guard |
| Q13 | Competitor between final child reread and trailing Person reread is superseded | Omit trailing Person reread |

Writer mutation recipes, commands, red output, and restored green: `writer-mutations/`. UI equivalents: `ui-mutations/`. The Q9c reporting omission and styling preflight failure were corrected during author verification; their final checks pass.

## Live HTTP proof

`live/README.md` describes the exact harness and its limits. Production editor/writer code ran against disposable Medplum **5.1.30-9b1bd92**, with transaction bundles absent and an unchanged staff policy bound to both synthetic patients.

- **Q5b:** competitor committed after preflight, before Person PUT; editor **412**, zero children.
- **Q6b:** competitor committed after Person's 200, before children; editor **200 / 200 / 412**. Sam updated; Leo's competing edit preserved and named in the UI.
- **Q9b:** UI repair wrote only Leo's RelatedPerson, **200**; Person/Sam versions unchanged. Fresh second repair: **zero writes**.
- All editor write sets exclude Patient; Patient content, decoy, and role/legal fields remain unchanged.

Serialized HTTP sequences and fresh persisted reads are in `live/*.json`; the screenshots show partial and repaired states. Credentials, runtime configuration, and sessions are excluded.

## Boundaries and follow-ups

No AccessPolicy change, Patient write, Person creation for unlinked parties, matching/backfill, insurance-writer change, comms-resolver change, feature flag change, or background reconciler. Only name, telecom, and address are editable. A newer Person generation is explicit in results; failed rereads remain unknown.

No new clinical codes or canonical FHIR URLs are introduced in application source. Existing registration construction is reused. **Mandate 14 ledger: no new rows. Decisions/INDEX.md: unchanged; this implements an accepted contract, with no new decision.** No cross-repo edits.

The full application shell and unrelated MCP communication controls are outside the browser fixture. Local full-suite results do not gate live authorization. Independent evaluator must read the actual diff and exact-head bot findings. **Status: implemented and author-verified; NOT EVALUATED. No merge performed.**
