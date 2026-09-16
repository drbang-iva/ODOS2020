# Integration assertion ledger

Contract rev 3.2. Author proof; NOT EVALUATED.

| File:line | Before | After | V/W mapping |
|---|---|---|---|
| mcp/tests/findingDefinitionStore.test.ts:481 | `clinicalRoutes.length === 104` | `=== 105` | W-f: new audit-repair POST route |
| mcp/tests/findingDefinitionStore.test.ts:485 | `routeDependencies.length === 49` | `=== 50` | W-f: repair receives persisted definitions through the same dependency factory |
| mcp/tests/searchParamContract.test.ts:180 (override formerly at 48) | Expected override set contains `diagnosis-findings.encounter-resources` | Removed obsolete override; all remaining call sites remain statically resolved or explicitly matched | W-c/W-g: endpoint now loads through the current reader and shared collector; removed generic direct-search helper has no call site |

Inventory proof: 18 tests, 18 pass, 0 fail (`inventory-green.tap`). Mutating audit-repair registration from POST to DELETE makes the route-count guard fail (`route-inventory-red.tap`, exit 1); restore passes. Restoring the obsolete search override produces three failures (`search-inventory-red.tap`, exit 1); restore passes. No unrelated registry entries or assertions were relaxed.

## Disposable runtime prerequisite

The stock image default FHIR quota of 50,000 units prevented the pre-existing 5,001-answer bulk-history fixture from completing, both in the initial full run and standalone. The private task runtime config now sets `defaultFhirQuota: 1000000`; rate limiting remains enabled and all canonical AccessPolicies are unchanged. The server was restarted. Standalone history pagination then passed 1/1, including 5,000 answers returned and 5,001 refused with HTTP 409 across 11 pages. No production configuration was changed.

Task-owned operator credentials and identity-state files were moved from the root `.odos` directory into `.odos/r10-a2b1/operator-state/`. They remain private and are sourced into live test processes. This keeps subprocess CLI fixtures with deliberately different synthetic project IDs from discovering unrelated operator state. After isolation, the two affected setup-wizard suites passed 22/22 without assertion changes.
