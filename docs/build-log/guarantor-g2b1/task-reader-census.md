Operator ruling: no normal workflow surfaces the operation Task. Generic FHIR visibility is accepted; the arbitrary lab-submit parent validation gap is pre-existing and separately filed. The lab module is unchanged. S5 excludes foreign-code and non-service-authored based-on Tasks.

# Task reader census at a13fc1ea6322d29fa38216fbc06d03dffd079175

Static census by a read-only subagent, checked against selected source by the coding session. Root: `.`. No live reader/policy proof is claimed.

Result: creating the specified guarantor operation Task alone does not cause it to appear in any identified current domain list/UI route. Intentional generic reads can return it. Conditional arbitrary-reference paths exist. The operator accepted premise #4 after distinguishing normal workflow surfaces from caller-supplied references; the ruling above governs this census.

## Surfaces that can expose or associate the operation

| Path/line | Trigger and effect |
|---|---|
| mcp/src/index.ts:866,2108,2840 | fhir_search accepts resource_type Task and returns the whole Bundle. Raw operation visibility, already disclosed by round-1 E5. |
| mcp/src/index.ts:4522,4537,4951; mcp/src/fhir/myopiaManagement.ts:317 | aggregate_myopia_treatments expands arbitrary activity intervention references. An additional CarePlan reference to the operation yields it as activities[].resource. G-2b creates no such CarePlan reference. |
| mcp/src/lab-orders/lab-order-handlers.ts:57,66,76; adapters/manual-lab-order-adapter.ts:125,159; adapters/ocuco-gatekeeper-lab-order-adapter.ts:129,172 | Caller-supplied operation ID is accepted as clinicalOrder without optical-kind validation. Creates a different lab-transmission Task basedOn it. Only that transmission enters the board. Actual manual handler/adapter reproduced with synthetic in-memory transport: reader-lab-probe.json. Ocuco path source-inspected only. UI OpticalOrder.tsx:960,827 uses its newly created optical Task, so normal operation creation does not trigger this. |

## Domain readers and parsers

Paths in the table are relative to the root above. Each row covers all listed call sites, not just the search query.

| Reader | Operation disposition |
|---|---|
| mcp/src/desk/desk-summary.ts:355,361,366,372,431 | Four query families require optical, claim-rejected, ERA, or statement-run coding. No operation row. |
| mcp/src/desk/desk-summary.ts:199,227,275,282,476 | Post-query projections require the matching coding/status. No operation count even when supplied in memory. |
| mcp/src/claims/claim-read-model-projector.ts:16,39 | Broad Task load reads operation internally; claim projection excludes irrelevant Task signals. |
| mcp/src/claims/claim-read-model.ts:66,76; claim-search.ts:88,177,190,237,242 | Requires claim/ERA code and Claim/ClaimResponse focus; rows originate from Claims. No operation row. |
| mcp/src/claims/claimmd-handlers.ts:1243; era-worklist.ts:174,183,540 | ERA batch queries and parser require known ERA code/business status. Excluded. |
| mcp/src/claims/claimmd-handlers.ts:1269,1277; era-worklist.ts:384,392,429,458 | Coded query plus isEraWorklistTask. Excluded. |
| mcp/src/claims/era-worklist.ts:331,347,418,439,467 | Snapshot/status/action parsers assert worklist kind. Refused. |
| mcp/src/claims/claimmd-handlers.ts:1697,1732 | Direct-ID read can fetch operation internally, then parser refuses before update/successful worklist response. |
| mcp/src/reporting/reporting.ts:250,255 | Uses projected ERA items/batch counts. Excluded. |
| mcp/src/reporting/margin-ledger.ts:153,377,384 | Query and projection require era-line-linkage plus known worklist status. Excluded. |
| mcp/src/statements/statements.ts:201,205,211,214 | Statement/run coded searches plus post-query validation. Excluded. |
| mcp/src/statements/statements.ts:508,534,1241 | Statement parser/latest-run require exact code and completed status. Refused/ignored. |
| mcp/src/statements/statements.ts:685,720 | IDs originate from freshly created statement run; recovery validates run code. No normal collision. |
| mcp/src/comms/education-sequence-operations.ts:72,140; comms-api.ts:135 | Query/parse require education-review coding without a system, enrollment focus, reason/ID/time. Excluded. |
| mcp/src/comms/education-sequence-operations.ts:130 | Post-create lookup checks expected focus/patient/reason/identifier/row/code. Excluded. |
| mcp/src/watchers/watcher-routes.ts:238; watcher-task.ts:22 | Query requires watcher code; reconciliation requires condition key. Excluded. |
| mcp/src/watchers/watcher-projections.ts:56,66,243,252 | isWatcherTask requires watcher code plus condition key. Excluded. |
| mcp/src/watchers/watcher-routes.ts:161,169 | Direct-ID read can fetch internally; terminal status or absent watcher code/key refuses it. |
| mcp/src/clinic/clinic-summary.ts:218,188 | Lab-transmission query before board projection. Excluded. |
| mcp/src/lab-orders/lab-order-handlers.ts:297,305,269 | Worklist query/post-filter require lab-transmission kind; sheet calls guarded storedLabOrderExport. Excluded/refused. |
| mcp/src/lab-orders/lab-order-handlers.ts:350; adapters/manual-lab-order-adapter.ts:84,203; adapters/ocuco-gatekeeper-lab-order-adapter.ts:89,213,229 | State/action reads can fetch internally; transmission assertion/stored-export check refuses operation. |
| mcp/src/lab-orders/adapters/manual-lab-order-adapter.ts:126; adapters/ocuco-gatekeeper-lab-order-adapter.ts:130 | Duplicate queries and predicates require transmission coding and matching basedOn. Excluded. |
| mcp/src/fhir/labOrderStatus.ts:190,206,332,345,403,509 | Operation cannot become a successful board row. Direct artificial injection increments unprojectableCount; current callers' coded queries/filters prevent that route. |
| mcp/src/jobs/syncOcucoGatekeeperJobStatus.ts:72,84 | Own identifier namespace; artificial collision would still lack lab transport status. Excluded/refused. |
| mcp/src/optical-order-lifecycle-service.ts:48,72 | Direct read then optical business-status gate. Refused. |
| mcp/src/optical-order-lifecycle-service.ts:60,65 | Low-level helper accepts generic Task identity, but only found production caller is gated transition above. No independent operation path. |
| ui/src/lib/optical-order.ts:369,373,513 | Direct read then optical status requirement; scene uses its newly created optical Task. Refused. |
| mcp/src/authz/documentPrintAuditEndpoint.ts:33,74,84 | Direct read returns audit ID rather than Task contents; operation has no for, so Patient equality fails with 403. |
| mcp/src/claims/claimmd-handlers.ts:1609,1616,2255 | Identifier-only dedup reads use producer-specific namespace/value; alternative query uses claim code/focus/status. Specified operation identifier does not match. |

## Generic transports and other dynamic readers

| Reader | Scope |
|---|---|
| mcp/src/fhir-client.ts:525,580,608,641,677,721,753 | Raw read/search/project/page/history/version methods; Task-capable, no operation discriminator. |
| mcp/src/fhir-search.ts:62,108,146,187 | Generic bounded/all-page helpers; caller selects resource. |
| mcp/src/watchers/fhir-pagination.ts:24 | Generic pagination; current Task callers use watcher coding. |
| ui/src/lib/fhir.ts:249,261,405; ui/src/lib/fhir-search.ts:17 | Raw search/page/read/pagination; no generic FHIR browser scene found. |
| Scheduling, claim draft, eligibility, clinical carry/undo dynamic readers | Restrict expected resource types; current inputs exclude Task. |
| Patient overview, diagnosis findings, protocol, day ledger, office channel, referral, fax, series tracker, education worker helpers | Current callers pass non-Task types. |
| mcp/src/reminders/reminder-engine.ts:379,431,773; mcp/src/index.ts:5755 | Library permits arbitrary campaign resource type; runtime builds Appointment-only campaigns. Artificial Task configuration fails patient resolution for specified operation. |
| mcp/src/bulk-data/router.ts:63,114,290; mcp/src/smart/authorization-server.ts:321 | Injected fixture exporter, not live Task reader; production defaults exclude Task. Serializer can transport an explicitly injected Task. |
| Audit UI and builder-only references | Display audit references without Task dereference; Task creation/type declarations are not readers. |

## Method and limits

Repository-wide Task/Task-reference searches, dynamic read/search/history/version calls, raw FHIR URLs, include/revinclude searches, and TypeScript AST enumeration across production TS/TSX in mcp/src and ui/src. AST found 552 named read/search-family calls (including non-FHIR stores), 37 Task-literal read/search/helper calls, plus education's resourceInPractice Task call. Traced filters, parsers, returned data and UI callers. Test files excluded from production inventory. This is static completeness by the stated method, not live proof of every reader or server/policy behavior.
