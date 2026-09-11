# Existing-test changes by authorized class

All line numbers refer to the final implementation source. Exact comparisons remain exact. No existing assertion was removed or loosened beyond the specifically ruled behavior.

| Class | File:line | Change |
|---|---|---|
| Additive field | `mcp/tests/commsApi.test.ts:1000` | Added `patientVersion: { writtenAgainst: "1", current: "2" }` to exact clear response. |
| Additive field | `mcp/tests/commsApi.test.ts:1056` | Added `patientVersion: { writtenAgainst: "1", current: "1" }` to exact no-op response. |
| Additive field | `mcp/tests/commsApi.test.ts:1120` | Added `patientVersion: { writtenAgainst: "1", current: "2" }` to exact authenticated clear response. |
| S1 fixture-fidelity ruling | `mcp/tests/commsApi.test.ts:2087` | Transaction returns the written Patient resource and bare `Patient/<id>` location. |
| S1 fixture-fidelity ruling | `mcp/tests/commsPreferencesRoutes.test.ts:13` and `:30` | Optional response switches support new fallback/omission tests; normal response carries returned Patient version and bare location. Existing write/assertion behavior preserved. |
| Pre-cleared Engage legacy gate | `ui/tests/engageSheet.test.tsx:123` | Old legacy-consent copy assertion becomes the unavailable-matrix notice; this unchanged fixture has no valid matrix response. |
| Pre-cleared Engage legacy gate | `ui/tests/engageSheet.test.tsx:125` | Marketing Text disabled `true` becomes `false` after removing the legacy UI gate. The unavailable matrix defers enforcement to the server. |
| Required adjacent companion, new test | `ui/tests/engageSheet.test.tsx:160` | Withheld matrix disables Marketing Text and Email despite no legacy record; exact assertions at `:176` and `:177`, copy at `:178`. |

Only these three existing test files changed. Other tests are new files. No slot-rename test change, inventory/count change, or test-only campaign literal substitution was needed for this slice. No new medical terminology, FHIR artifact URL, or vocabulary code was minted; no new verification ledger row is required.
