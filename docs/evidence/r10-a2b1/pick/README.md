# Candidates and pick evidence

Contract rev 3.2 sections 3.3, 3.7, 3.8; candidate/pick-owned portion only.

- Current candidate instances use the reader's definitionViews, with contributors and real-id/projection-key identity. Current present canonical supports follow option, qualifier, recursive allOf, always/abnormal, and rule policies; numeric and measurement candidates have none. Deduplication unions supports by full canonical key.
- A shared pure `diagnosisDefinitionViews` adapter adds the newest live panel-context components from `projection.panels` to option views. It never reads raw observations; ambiguous projected contexts refuse. Candidates and pick both use this adapter. The reader itself remains unchanged. This narrow adapter is needed because the reader's definitionViews currently carry legacy snapshot numeric context but omit separate new-format panel numeric context.
- Supports are validated as a complete set before the first Condition transaction. Supported picks never add Observation evidence/entities; the client still owns bodySite and subsequent findings link. Measurement evidence remains intact. Page-two encounter diagnoses are reused.
- The full pick response retains Condition, Encounter, provenance, demotion/stranded-charge data and visit status. Applied responses are 200. Transaction refusals/conflicts and unknown transaction outcomes report failed/unconfirmed. A failed visit-status side effect after the Condition transaction reports applied with a visible error.

## Checks

`cd mcp && node --import tsx --test tests/diagnosisLinkL1.test.ts tests/diagnosisLinkL2.test.ts tests/diagnosisLinkL3.test.ts tests/diagnosisDemotionImpact.test.ts tests/diagnosisVisitStatus.test.ts`

128 tests, 128 pass, 0 fail; `focused-green.tap`. `npm --prefix mcp run build`: exit 0, `build.txt`. No PostgreSQL dependency in these five focused suites; they use synthetic in-memory FHIR/transaction clients. Live authorization and full suites are parent-owned.

## Mutation proof

Every mutant was applied alone, executed, then restored before its green run:

| Guard | Mutation | Red | Restored green |
|---|---|---:|---:|
| W10 | Supported pick adds support baseline Observation as evidence/entity | 1 failed | 1 passed |
| W29 | Measurement pick drops all evidence/entities | 1 failed | 1 passed |
| W30 | Candidates iterate raw observations rather than projected definitionViews | 1 failed | 1 passed |
| W35 | Skip whole support fact/current-baseline validation | stale and foreign guards fail | 4 passed |

Raw `W*-red.tap` and `W*-green.tap` accompany these results. Additional red/green evidence covers the initially absent contract behavior, mixed panel context, per-candidate linkability, and truthful response after Condition write. Existing assertion changes are listed with old/new locations and V/W mapping in `assertion-ledger.md`.

No clinical codes or FHIR URLs were introduced to production code. Tests reuse existing fixture/catalog constants and already-existing fixture system URLs. No policy/UI edits, containers, PR, push, merge or evaluation performed by this worker.

Status: author checks complete; NOT EVALUATED. Parent must integrate, run full verification/live proof, and obtain independent Claude evaluation. This PR remains HELD OPEN under A3.

## Existing-path validation status interpretation

Sections 3.1 and 3.8 explicitly leave measurement and catalog-search picks unchanged. Their existing validation HTTP statuses therefore remain (for example, missing laterality 422, missing diagnosis/absent discard target 404, and staged-family conflict 409), now with the typed `invalid` discriminator and `invalid-pick` reason. The generic 400 invalid row in section 3.3 governs new support validation; the listed new pre-rebuild/signed support exceptions retain 409/422. This preserves the explicitly unchanged path rather than silently changing its validation status contract. Applied pick responses universally use the newly specified HTTP 200.
