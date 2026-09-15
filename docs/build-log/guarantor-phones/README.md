# Guarantor phones and textability — item 1b-iii

**NOT EVALUATED.** Codex authored this implementation. A separate Claude Opus session must evaluate the exact PR head before merge.

## Summary

Registration, the chart guarantor editor, and Create new guarantor share the patient phone slots and textability question. Patient exports delegate to the same lossless phone mechanic. A shared demographic merge carries name, telecom, address, and only the refusal marker; target role and operation extensions survive. Phone types are staff-selected, with Cell as the new-slot default.

The editor retains its full owned projection and an immutable phone snapshot. No-refusal comparisons normalize omitted, empty, and unrelated-only resource extensions. The projecting owned hash adds `noTextableNumber: true` only for an effective refusal; other phases are unchanged. Attach undo retains the last child snapshot; transfer correction projects the previous Person.

## Baseline and anchors

Fetched `origin/main`: `52c6ec4926e95e78344082add8522e74743ffb33`. Its only commit after `02cdf89e0b964cb442bd42287c86435102fcccc9` changes unrelated plan code. No in-flight PR overlapped the scope at isolation. The registration lost-reply comparator is at line 580 in the baseline (the contract gives an approximate older range); its JSON-normalized full-field comparison already includes extensions and needed no production change.

## Projection write sites

- `ui/src/lib/guarantor-editor.ts:172`: child projection.
- `ui/src/lib/guarantor-editor.ts:195`: Person update.
- `mcp/src/clinic/guarantor-link-operation.ts:557`: initial projection.
- `mcp/src/clinic/guarantor-link-operation.ts:562`: fresh-resource rebuild.
- `mcp/src/clinic/patient-registration-endpoint.ts:444`: initial RelatedPerson, with role extensions constructed first; both registration modes use the same merge.

Search found no remaining spread of `projectResponsiblePartyDemographics` at a write site. The component's `demographics` alias at `ResponsiblePartiesControl.tsx:17` also uses the complete owned projection. Equality consumers remain `guarantor-editor.ts:34` and `guarantor-link-operation.ts:77`; both inherit refusal-aware equality. Recovery changes only `guarantorOwnedHash`'s projecting set at line 241. `intentMatches` at line 245 continues using exactly that hash, with no alternative-hash fallback. The existing full-resource registration reply comparator is unchanged.

## Refusal-writer audit

The complete pre-change `rg -n 'odos-no-textable-number|NO_TEXTABLE_NUMBER'` output is [refusal-writers-before.txt](refusal-writers-before.txt). The sole shipped writer is Patient-typed `applyPatientTextableAnswer`, `mcp/src/clinic/patient-telecom.ts:41–44` at the baseline. Other production hits declare constants or read the marker. Test fixtures, prior evidence and canonical definitions are not shipped write paths. In particular, the old reader fixture manually seeded a refusal on a child; that test-only construction does not establish a reachable pre-C2 journal.

## T1–T13 mutation proof

Each row is GREEN → named mutation RED → restored GREEN. Complete test names, commands, original/mutated source fragments and output/counts are in [mutations/results.json](mutations/results.json), with one log per stage. Exit-code triplets below are green/red/restored.

| Guard | Exact failing test name(s) | Exit codes |
|---|---|---|
| T1 | T1 Person and RelatedPerson answer leaves one marker and clears refusal on number selection | 0 / 1 / 0 |
| T2-merge | T2 merge preserves every target role and operation extension | 0 / 1 / 0 |
| T2-component | T2 real editor name-only save keeps refusal on Person and both children | 0 / 1 / 0 |
| T3 | T3 real editor selecting a number clears refusal on both children | 0 / 1 / 0 |
| T4-raw | T4 writer-derived guarantor without refusal remains verified for every absent representation | 0 / 1 / 0 |
| T4-empty | T4 writer-derived guarantor without refusal remains verified for every absent representation | 0 / 1 / 0 |
| T5 | T5 attach projects refusal=true and correction restores the required snapshot, T5 attach projects refusal=false and correction restores the required snapshot, T5 transfer projects refusal=true and correction restores the required snapshot, T5 transfer projects refusal=false and correction restores the required snapshot, T5 consolidate projects refusal=true and correction restores the required snapshot, T5 consolidate projects refusal=false and correction restores the required snapshot | 0 / 1 / 0 |
| T6 | T6 lost projecting reply plus competing refusal pauses interfered without domain writes | 0 / 1 / 0 |
| T7 | T7 lost registration reply refuses to match a child whose refusal changed | 0 / 1 / 0 |
| T8 | T8 guardian blank selected Phone 2 refuses before all writes | 0 / 1 / 0 |
| T9 | T9 guardian refusal prevents SMS and the marked Phone 2 controls delivery | 0 / 1 / 0 |
| T10 | T10 real editor preserves email third phone old and period-bounded identities | 0 / 1 / 0 |
| T11 | T11 refusal profile accepts Patient Person and RelatedPerson | 0 / 1 / 0 |
| T12 | T12 exact pre-C2 projecting journal resumes with no-refusal child | 0 / 1 / 0 |
| T13 | T13 existing-guarantor initial child refusal before attach with none reply, T13 existing-guarantor initial child refusal before attach with registration reply | 0 / 1 / 0 |

The shifted service-write inventory entry has its own negative control: delete the entry → ungranted Person write reported; restore → green. See `inventory-entry-red.txt` and `inventory-entry-restored.txt`. No permission or policy rule was changed.

## Regression and build checks

| Check | Result |
|---|---|
| Focused MCP guarantor, registration, insurance, profile suites | 214 passed / 0 failed / 0 skipped |
| Focused UI guarantor and patient phone/registration suites | 123 passed / 0 failed / 0 skipped |
| Full MCP: `ODOS_ALLOW_UNGATED_MCP=1 npm test`, from `mcp/`, disposable `ODOS_POSTGRES_URL` | 4,992 tests; 4,941 passed / 0 failed / 51 skipped |
| Full UI: `npm test`, from `ui/` | 1,556 passed / 0 failed / 0 skipped |
| MCP `npx tsc --noEmit -p mcp/tsconfig.json` | exit 0, no diagnostics |
| UI `npx tsc --noEmit --skipLibCheck`, from `ui/` | exit 0, no diagnostics |
| Scripts `npx tsc -p tsconfig.scripts.json --noEmit` | exit 0, no diagnostics |
| `npm run preflight` | 0 warnings, 0 hard blocks |
| Proxy census | all 25 route families have entries; advisory |

The MCP run deliberately reports its missing broader credentialed integration configuration: 43 explicitly logged live skips are part of the 51 total skips. This is not a claim that all live authorization suites ran. The separate scoped Medplum proof below did run.

`test-preservation.json` records 214 original test bodies in 14 frozen files. Only two exact `Phone 1 (home)` → `Phone 1` selectors changed, with operator authorization; every original behavioral assertion in those files is unchanged. Top-level registration fixture inputs use the new wire schema. Two reader tests outside that frozen set now distinguish child-owned role extensions from the guarantor-owned refusal, matching the revised contract.

## Exact legacy journal

`mcp/tests/fixtures/guarantor-pre-c2-journal.json` is the serialized output of the exact pre-C2 engine at `02cdf89e0b964cb442bd42287c86435102fcccc9`, with a committed projecting write's reply lost. It is not a hand-built journal. [legacy-journal-generation.json](legacy-journal-generation.json) records the emitting head and interruption. `generate-pre-c2-journal.ts` reproduces it given a clean detached checkout at that head. The no-address/no-birth-date synthetic case is established before the old engine writes its journal. New fixtures capture real registration writers and transport reads/writes through JSON serialization.

## Live proof

[Live result](live-result.json) and [every recorded domain request / final response](live-requests.json.gz) show:

1. A minor registered with parent Home Phone 1 and Cell Phone 2 marked; a sibling registered against the same Person and the real attach operation completed.
2. The actual `/clinic?patientId=…` chart route opened its demographics dialog. In its guarantor editor, Neither projected to the Person and both children; both SMS resolutions became absent.
3. Selecting the original Cell number removed both refusals and both resolved `864-555-0102` again. The shared reader renumbers the marked entry to Phone 1 on reload, as patient behavior already requires.
4. Real Medplum 5.1.30 accepted both updated canonical definitions, Person writes, and RelatedPerson writes. Real synthetic staff membership policies authorized the UI requests. No application authorization changes were made.
5. Zero browser page errors. No SMS was sent. Ancillary communications-preference and clinical-graph services were not provisioned; those are explicitly outside this fixture.

The fixture is a separate Compose project `guarantor-phones-live`, loopback Medplum port 28970, PostgreSQL 28971, Redis 28972. Full database tests used a separate `item1b_tests` database. Browser proof used task-owned Vite ports 28974/28975, both closed after proof. Fixture containers are stopped, not removed; `fixture-stopped.json` records final state.

## Mandate 14 and scope

No medical code or external clinical/regulatory citation changed. The canonical change extends ODOS's own refusal context from Patient to Patient/Person/RelatedPerson. The registry has no context-pinning field, so it needs no row change. No new decision was made, so no decision-index or medical-code ledger row is required. No cross-repository implementation follow-up is introduced.

## Delivery state

Implementation and author-side evidence are complete. Independent Opus evaluation is still required. CI/bot results and the final PR head belong in the delivery message; this authored file does not issue an evaluation verdict. No `Evaluated-by` marker or operator override label is posted by this session.

Full suite TAP logs and the full domain trace are gzip-compressed without content changes. The live proof script emits `live-requests.json`; the bundle archives that exact JSON as `.json.gz`. Mutation stage outputs are plain text in `mutations/`. Typechecks exited 0 with no diagnostics.

## Bot review adjudication

CodeRabbit's request to remove ContactPoint markers on Neither was rejected: the approved patient R1 rule intentionally retains them for conversation lookup while the resource refusal suppresses delivery. Applying the proposed change makes frozen patient K7 fail; restoring it makes K7 green.

Three coverage suggestions were accepted: T12 now checks the final refusal is absent, T5 checks both corrected consolidate children, and T3 checks the actual selected number is the sole marked number on the Person and both children. Phone 2 is the Home number in this fixture after the reader sorts Cell first, so the assertion uses number identity rather than an incorrect raw-array position. No production source changed in this review follow-up.

`review-guards/results.json` and its stage outputs record four additional green/red/restored controls: forced refusal during final release (T12), corrupted second corrected child (T5), omitted selected marker (T3), and the rejected Neither change (patient K7). Focused follow-up runs passed 11/11 MCP recovery tests and 22/22 UI guarantor/patient-phone tests. The full-suite evidence above was captured before these assertion-only additions; final-head CI reruns the suites. Production source hashes and live-proof applicability are unchanged.
