# Correspondence C1 Verification Ledger

Access date: 2026-07-30.

| Assertion | Source 1 | Source 2 | Status | Consumer |
|---|---|---|---|---|
| LOINC `57133-1` is the active code for “Referral note.” | [LOINC 57133-1](https://loinc.org/57133-1) | [HL7 C-CDA Referral Note](https://build.fhir.org/ig/HL7/CDA-ccda-2.1-sd/StructureDefinition-ReferralNote.html) | verified 2026-07-30 | `mcp/src/correspondence/correspondence-document.ts` |
| FHIR R4 `DocumentReference.content` is `1..*`; each repetition has one `Attachment`, may identify an additional format with `Coding`, and `context.related` may reference the source `ServiceRequest`. | [HL7 FHIR R4 DocumentReference definitions](https://hl7.org/fhir/R4/documentreference-definitions.html) | Installed `@medplum/fhirtypes` 4.5.2 `dist/DocumentReference.d.ts` (`content: DocumentReferenceContent[]`, `attachment: Attachment`, `format?: Coding`, `related?: Reference<Resource>[]`) | verified 2026-07-30 | `mcp/src/correspondence/correspondence-document.ts` |
| WeasyPrint 69.0 supports `--pdf-variant pdf/a-3u` and `- -` selects stdin input plus stdout output. | [WeasyPrint 69.0 API reference](https://doc.courtbouillon.org/weasyprint/stable/api_reference.html) | [WeasyPrint v69.0 release](https://github.com/Kozea/WeasyPrint/releases/tag/v69.0) plus local pinned-container `weasyprint --version` and `--help` proof | verified 2026-07-30 | `mcp/src/correspondence/weasyprint-renderer.ts`; `docker/weasyprint.Dockerfile` |

The PDF/A row also has executable evidence: the pinned local container rendered a
synthetic letter whose decoded XMP declares `pdfaid:part="3"` and
`pdfaid:conformance="U"`.
