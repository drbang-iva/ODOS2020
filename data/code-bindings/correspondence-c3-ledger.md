# Correspondence C3 Verification Ledger

Access date: 2026-07-31.

The WestFax rows verify only endpoint and payload details consumed by this slice. No live account
or real fax was called. FHIR element names were also checked against installed
`@medplum/fhirtypes` 4.5.2 declarations for `DocumentReference`, `AuditEvent`, `ServiceRequest`,
`Patient`, `Task`, and `Binary`; C3 does not create `Binary` or `Task`.

| Assertion | Source 1 | Source 2 | Status | Consumer |
|---|---|---|---|---|
| Unread inbound discovery uses `Fax_GetProductsWithInboundFaxes` with `Filter=None`; each returned product is queried with `Fax_GetFaxIdentifiers` and `FaxDirection=Inbound`. | [WestFax official SDK `FaxInterfaceRaw.cs`](https://github.com/westfax/SDK-Fax/blob/master/SDK/WF.SDK.Fax/FaxInterfaceRaw.cs) | [WestFax API values reference](https://westfax.com/knowledge-base/api-parameters-and-return-values-decoded/) | verified 2026-07-31 | `mcp/src/fax/westfax-adapter.ts` |
| ID-scoped descriptions use `Fax_GetFaxDescriptionsUsingIds` with `FaxIds1..n`; inbound caller number is `FaxCallInfoList[].OrigNumber`, and `PageCount` is description metadata. This is the documented ID-scoped alternative to the broader `Fax_GetFaxDescriptions` step in the accepted protocol. | [WestFax official Postman collection](https://github.com/westfax/API-Postman/blob/master/WestFaxApi_Postman_collection.json) | [WestFax official SDK fax models](https://github.com/westfax/SDK-Fax/blob/master/SDK/WF.SDK.Fax/ModelsExternal/FaxIdClasses.cs) | verified 2026-07-31 | `mcp/src/fax/westfax-adapter.ts` |
| PDF retrieval uses `Fax_GetFaxDocuments`, JSON `FaxIds1..n`, and `Format=pdf`; the response carries `FaxFiles[].ContentType` and base64 `FileContents`, plus `PageCount`. | [WestFax official Postman Fax_GetFaxDocuments request](https://www.postman.com/westfax/westfax-s-public-workspace/request/t0gsupr/fax-getfaxdocuments) | [WestFax inbound fax API walkthrough](https://westfax.com/fax-api/) | verified 2026-07-31 | `mcp/src/fax/westfax-adapter.ts`; `mcp/src/fax/inbound-fax.ts` |
| `Fax_ChangeFaxFilterValue` accepts `Filter=Retrieved` to mark a fax read; `None` is unread and `Removed` is deleted. | [WestFax official SDK `FaxInterfaceRaw.cs`](https://github.com/westfax/SDK-Fax/blob/master/SDK/WF.SDK.Fax/FaxInterfaceRaw.cs) | [WestFax API values reference](https://westfax.com/knowledge-base/api-parameters-and-return-values-decoded/) | verified 2026-07-31 | `mcp/src/fax/westfax-adapter.ts`; `mcp/src/fax/inbound-fax.ts` |
| FHIR R4 `DocumentReference` supports an optional `subject`, one-or-more `content.attachment` values, `identifier`, `date`, and `context.related`; an `Attachment` may carry inline base64 `data` and a MIME `contentType`. | [HL7 FHIR R4 DocumentReference](https://hl7.org/fhir/R4/documentreference.html) | [FHIR build DocumentReference](https://build.fhir.org/documentreference.html) | verified 2026-07-31 | `mcp/src/fax/inbound-fax.ts`; `mcp/src/desk/correspondence-block.ts` |
| FHIR REST conditional create uses `If-None-Exist` with search criteria; the token `identifier` search is `system\|value`, providing a server-enforced natural key for retry idempotency. | [HL7 FHIR R4 conditional create](https://hl7.org/fhir/R4/http.html#ccreate) | [HL7 FHIR R4 token search](https://hl7.org/fhir/R4/search.html#token) | verified 2026-07-31 | `mcp/src/fax/inbound-fax.ts` |
| FHIR R4 `AuditEvent` carries `type`, `action`, `recorded`, `outcome`, `agent`, `source`, and `entity`; C3 reuses the existing local correspondence audit code system for attach and promote events. | [HL7 FHIR R4 AuditEvent](https://hl7.org/fhir/R4/auditevent.html) | [FHIR build AuditEvent](https://build.fhir.org/auditevent.html) | verified 2026-07-31 | `mcp/src/fax/inbound-fax.ts` |

The six C3 extension URLs are ODOS-local vocabulary registered in
`data/canonical-extensions/registry.json`; they assert no external medical or billing code.
