# Guarantor G-2b-2b author evidence

This build implements Revision 4 B0-B4: attach an unowned responsible party to an existing guarantor from registration or the chart, and undo that attach as a correction that leaves the responsible party unowned. It does not change transfer, consolidate, correct-of-transfer, insurance, statements, communications, transaction-bundle policy, or the G-2b-R owned-field classifier and terminal rules.

This is author-side evidence at code head `22b190d93cb62701b9f2690f6547e015524022bd`; the later evidence commit changes only this build log. **NOT EVALUATED.** Claude must evaluate the final PR head independently.

## Premise and anchors

- Contract: `performance-od` `origin/main` at `3e94fa339773d1bcc2af4b1da2a380bf0e297d69`; front matter says **REVISION 4**. The local companion checkout was stale, so the read-only contract and its three companion decisions were read from the fetched `origin/main` git objects.
- ODOS base: `44afa37c37fc269bd89688c7dc90417f3b473ec0`.
- G-2b-R premise passed: intents carry `ownedHash`; recovery classifies against owned fields; a second in-progress correction is refused; `Run.complete` begins with step 0-prime.
- P6 at the built head: plan schemas `21-29`; endpoint-shape validation `99-117`; optional source/destination loading `160-170`; attach admission `172-183`; step 0-prime and the destination-only fence path `331-348`; correction admission `620-649`; attach/unlink movement and verification `467-546` in `mcp/src/clinic/guarantor-link-operation.ts`.
- P7 at the built head: strict `existing` schema `47-65`; pre-write authorization/read/shape checks `203-251`; ordered post-grant attach `254-285`; bundle emits a RelatedPerson but no Person for `existing` `370-419` in `mcp/src/clinic/patient-registration-endpoint.ts`.

Baseline dependency installs: MCP added 262 packages and audited 263 (7 moderate and 2 high advisories); UI added 150 and audited 151 (0 advisories). Baseline MCP was 4,848 tests: 4,780 pass, 7 fail, 61 skipped. The seven local failures were the pre-existing PostgreSQL hook refusals in claims read-model tests 700-705 and the DR child-process missing-root-loader test 1560; CI is authoritative. Baseline UI was 1,535/1,535 passing. Baseline preflight reported 48 grants, 902 operations, 38 service-write call sites, 0 warnings, and 0 blockers. Baseline guarantor files were MCP 92 tests and UI 69 tests.

## Mandate 17

The initial built guard run was MCP 19/19 and UI 5/5. Each mutation below was applied only long enough to observe the named red result, then removed and the named test rerun green. Production mutations were never committed.

| Guard | Deliberate break and observed red | Restored result |
| --- | --- | --- |
| A1 | Skipped the attach claim; `A1: two concurrent chart attaches admit one winner...` failed because the losing attach made 2 Person PUTs, expected 1. | 1/1 pass |
| A2 | Skipped the empty-owner admission; `A2: attach refuses an already-owned RelatedPerson...` saw 5 writes, expected 0. | 1/1 pass |
| A3 | Put the absent source back in the fence loop; `A3: a destination edit after validation pauses attach...` returned 500 on Complete, expected 200. | 1/1 pass |
| A4 | Classified the moved attach version as not landed; `A4: Complete classifies a landed attach after reply loss...` returned 409, expected 200. | 1/1 pass |
| A5 | Projected destination details during unlink; `A5/A15: correcting a completed attach unlinks...` found a projecting RelatedPerson PUT, expected none. | 1/1 pass |
| A6 | Omitted both possible detach paths; `A6: unlink takes over a pending attach whose Person write landed` returned 409, expected 200. | 1/1 pass |
| A7 | Always detached even with no owner; `A7: unlink of a pending attach before the attach landed...` found a detaching Person PUT. | 1/1 pass |
| A8 | Allowed a correction of an unlink; `A8: correcting an unlink is refused without a Task` returned 409, expected 422. | 1/1 pass |
| A9 | Added an existing Person PUT to the registration transaction; `A9: registration with an existing guarantor commits no Person...` found a Person entry. | 1/1 pass |
| A10 | Threw the attach conflict out of registration; `A10: an attach claim conflict after the registration bundle preserves 201...` returned 409, expected 201. | 1/1 pass |
| A11 | Moved `guarantor.link` admission after MRN reservation; `A11: registration with an existing party requires guarantor.link...` saw 1 reservation write, expected 0. | 1/1 pass |
| A12 | Skipped existing-Person practice/active/link checks; each of the foreign, inactive, and unsupported-link `A12` cases returned 201, expected 422. | 3/3 pass |
| A13 | Validated the raw `existing` payload instead of its resolved Person demographics; `A13: a financially responsible existing Person without a complete address...` returned 201, expected 400. | 1/1 pass |
| A14 | Offered an Attach button on `ambiguous`; `A14: ambiguous ownership never offers Attach` observed `true`, expected `false`. | 1/1 pass |
| A15 | Set `active: false` while releasing the unlink; `A5/A15: correcting a completed attach unlinks...` compared `false` with the preserved `true`. | 1/1 pass |
| A16 | Used full-resource equality for release-intent recovery; `A16: lost unlink release cannot overwrite a later completed attach` returned 409 repeatedly, expected 200. | 1/1 pass |
| A17 | Used full-resource equality for Person detach-intent recovery; `A17: lost unlink detach plus a staff rename completes...` returned 409, expected 200. | 1/1 pass |
| A18 | Made transfer/consolidate source optional in both schema and `readPlan`; `A18: only attach and correct-of-attach may omit...` read the malformed transfer far enough to return 500, expected 422. | 1/1 pass |

The registry inventory remains at 38 service-write call sites. The new registration wiring calls the already-registered guarantor engine; it adds no `executeTransactionAsActor` call site and no audit event type. The registry-forced exact line pins changed for the existing guarantor engine transaction and for nine later `mcp/src/index.ts` entries displaced by the new route registration; no inventory count or classification changed.

## Real-server HTTP proof

[Runtime](live-runtime.json), [project and policy state](live-resource-state.json), [staff authentication](live-staff-auth.json), [policy sync](live-policy-sync.json), [58 assertion results and the transaction trace](live-http-results.json), and [audit rows](live-http-audits.json) record the executed lane.

- Own compose project `g2b2b-attach`; pinned Medplum `5.1.30-9b1bd92`; loopback ports 29190-29195; two synthetic practice Projects plus the isolated bootstrap Project; `transaction-bundles` absent; real ODOS service identity; two non-admin staff tokens under the synced policy. All clinical data is synthetic.
- Nine required schedules passed: A1, A3, A4, A6, A16, A17, A9, A10, and A11. Totals: 58 assertions, 233 service transactions, 20 authenticated route requests, and 37 guarantor audit writes.
- A1 held the two real RelatedPerson claim PUTs at one barrier; one Task completed, one failed `claim-conflict`, and the child had one owner.
- A3 landed a real staff edit after validation and before D's conditional attach; the operation paused `attach-pending`, and Complete fenced only D.
- A4 dropped the in-process reply only after Medplum committed the attach PUT; the persisted Task had one unresolved `attaching` intent, and Complete issued no second attach PUT.
- A6 corrected an in-progress attach whose Person write had committed; correction completed, cancelled the original, removed D's link, and released the claim.
- A16 and A17 each drop a reply only after a committed write. The captured Tasks respectively contain the unresolved `releasing` and `detaching` intents. Complete uses the shipped owned-field rule: A16 preserves the later owner without a new RelatedPerson write; A17 preserves the staff rename, frees the child, and permits the later attach.
- A9 and A10 traverse the actual `POST /clinic/patients` route with `kind: "existing"`. A9's committed bundle has zero Person entries and the post-grant attach reports `linked`. A10 holds two real claims after the registration bundle; the competitor wins, the registration still returns 201 with a failed Task ID, and its Patient remains readable.
- A11 uses the real authenticated staff token and synced policy result, then removes only `guarantor.link` from the injected route authorization state. The actual registration endpoint returns 403 before a service transaction or MRN reservation. The fixture policy itself is not mutated because all shipped practice roles currently carry the action.

## Chromium proof

[Browser result](browser-proof.json) records 38 assertions, 136 browser requests, zero page exceptions, exact source hashes, final FHIR ownership, and screenshot hashes. Chromium used the unmodified Vite application, the actual `/patient/new` and `/clinic?patientId=...` routes, real staff authentication, real route registrars, and the disposable Medplum server. Unrelated communications and Series Tracker routes were not mounted; their 404 notices are outside the captured Responsible parties panels.

- [Registration existing guarantor on chart](registration-existing-chart.png): the operator typed a person party, chose the unique **Already on file?** result, registered, and the chart loaded that Person with both children verified.
- [Failed attach on missing chart](failed-attach-missing.png): a real failed `claim-conflict` Task makes the chart display `No linked guarantor record. The guarantor attach did not finish.` and offers **Attach a guarantor**.
- [Chart attach linked](chart-attach-linked.png): search, draft, confirmation, reason, and the real create route completed; a fresh Person search shows the new sole owner.
- [Undo returns to missing](attach-undo-missing.png): **Guarantor changes** exposed the completed attach, Undo called its correction route, and a fresh Person search returned zero owners.

## Mandate 14 ledger

No new SNOMED, ICD-10, CPT, HCPCS, LOINC, RxNorm, NDC, UCUM, FDA, DICOM, regulatory citation, external FHIR artifact URL, or specific compliance-date claim was introduced. The change reuses the already-shipped ODOS-internal guarantor CodeSystem and StructureDefinition identifiers. Therefore no terminology/artifact ledger row is required. The Medplum version and transaction-bundle absence above are executed runtime observations captured from the disposable server, not normative claims.

## Promise boundary

Registration commit and guarantor attach are deliberately separate. An attach outcome never changes the registration result. A crash after registration and before attach leaves a readable patient whose responsible party loads `missing`; staff can use the chart's Attach flow. The implementation does not promise atomic registration-plus-attach and does not put or post an existing Person in the registration bundle.

The task's own fixture containers are stopped, not removed, after final verification. They remain available for the independent evaluator and no other compose project is touched.
