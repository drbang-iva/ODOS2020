# R10 A2a capability source verification

Access date for every source below: 2026-09-16. Sources were opened in this session. Source support does not substitute for the disposable gate; see gate-results.json for observed behavior.

| Claim | Primary source 1 | Primary source 2 | Agreement and scope |
|---|---|---|---|
| `_tag` is a common token search parameter over `meta.tag`. | [HL7 FHIR R4 search, common parameters](https://hl7.org/fhir/R4/search.html#tag) (accessed 2026-09-16). | [Medplum v5.1.30 search tests, Search by _tag](https://github.com/medplum/medplum/blob/v5.1.30/packages/server/src/fhir/search.test.ts#L3345-L3359) (accessed 2026-09-16). | Agree on system-and-code token matching. Medplum source example is Patient; Provenance under ODOS roles is a live-gate obligation. |
| A single token parameter accepts comma-separated alternatives as OR. | [HL7 FHIR R4 search, combining parameters](https://hl7.org/fhir/R4/search.html#combining) (accessed 2026-09-16). | [Medplum v5.1.30 search tests, Comma separated value](https://github.com/medplum/medplum/blob/v5.1.30/packages/server/src/fhir/search.test.ts#L1475-L1496) (accessed 2026-09-16). | Agree on comma-OR behavior; the Medplum example uses ServiceRequest code. Tag-specific behavior under both logins requires G-d. |
| Conditional create searches the supplied If-None-Exist query; a unique existing match is returned without a create. | [HL7 FHIR R4 conditional create](https://hl7.org/fhir/R4/http.html#ccreate) (accessed 2026-09-16). | [Medplum v5.1.30 FhirRepository.conditionalCreate](https://github.com/medplum/medplum/blob/v5.1.30/packages/fhir-router/src/repo.ts#L241-L289) (accessed 2026-09-16). | Agree on search-based conditional creation and the existing-match branch. Medplum requests a serializable transaction. Combined with the verified _tag search claim, this supports the proposed key in principle; G-a decides concurrent behavior under real policies. |
| FHIR R4 Provenance has no top-level identifier element. | [HL7 FHIR R4 Provenance structure](https://hl7.org/fhir/R4/provenance.html#resource) (accessed 2026-09-16). | [Medplum fhirtypes 4.5.2 Provenance definition](https://unpkg.com/@medplum/fhirtypes@4.5.2/dist/Provenance.d.ts) (installed package inspected 2026-09-16). | Both element inventories omit identifier. The audit key uses meta.tag. |

No clinical terminology code or new public FHIR artifact URL is introduced by this gate. Existing ODOS builders and the existing policy compiler supply resource shapes.

This source ledger is documentary; runtime code does not consume its rows. The live gate is executable. No registry entry was added.
