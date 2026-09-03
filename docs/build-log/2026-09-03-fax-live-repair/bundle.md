# WestFax inbound repair — author evidence

Status: needs independent Opus evaluation and operator post-merge live verification.
Tested source commit: `c35877f452362755cf8af54e84bef70b40de31dd`.
Base: `bc86574fd41fe7f0a528d9619cda44cf8e4d0c0a`.
Branch: `drbang-iva/fax-live-repair`.
Author worktree: `/Users/ericr.bang/GitHub/odos-fax-live-repair`.

Inbound requests now carry a rolling UTC StartDate (30 days by default, configurable
with WESTFAX_INBOUND_LOOKBACK_DAYS, integer 1–365). The ID-based worker call and its
25-ID batching remain intact. The operator helper calls the date-range descriptions
endpoint once, using the same multipart builder and parser. No polling interval,
Filter=None/Retrieved transition, outbound fax, or Desk UI changes were made.

The parser drops Reference and retains FaxCallInfoList[0].OrigCSID as senderIdentifier.
The saved fax stores it in the existing caller-metadata extension. The default
suggestion path accepts exact normalized Practitioner/Organization names alongside
the existing fax-number lookup, then requires one patient across the complete
matching inbound-referral results. It remains advisory: no DocumentReference.subject
is assigned. A CSID alone without an existing matching referral produces no suggestion.
Truncated directories/referrals and multiple patient candidates produce no suggestion.

## Files

- `.env.example`: bounded lookback and operator invocation.
- `mcp/src/fax/westfax-adapter.ts`: dates, shared descriptions parsing and read-only helper.
- `mcp/src/fax/inbound-fax.ts`: sender persistence and referral-based suggestion wiring.
- `mcp/scripts/verify-westfax-live.mjs`: env-only operator script, parsed JSON output,
  suppressed provider/transport errors, no read-state mutation.
- `mcp/tests/fixtures/westfax.ts`: complete captured field structure with synthetic values.
- `mcp/tests/westFaxAdapter.test.ts`, `inboundFax.test.ts`, `verifyWestFaxLive.test.ts`:
  request, parser, default-poller, persistence, matching, and operator-script checks.
- `mcp/tests/searchParamContract.test.ts`: Practitioner/Organization name-query inventory.
- `scripts/fhir-read-grant-check.ts`: four existing audit call-site locations moved by
  one line after the import change; grants and exclusions are unchanged.
- This evidence directory: command output, mutation failures/restorations, fixture diff.

## Checks

Exact commands and verbatim output excerpts: [verification.txt](verification.txt).

| Check | Result |
| --- | --- |
| Original four fax suites at base | 40 passed, 0 failed |
| Corrected adapter tests before repair | 6 passed, 4 failed |
| Final fax + script + search contract + fixture guard | 55 passed, 0 failed, 0 skipped |
| Fax/supporting tests plus read-grant inventory tests before fixture value correction | 68 passed, 0 failed |
| `cd mcp && node scripts/run-tests.mjs` | 4,108 tests: 4,053 passed, 0 failed, 55 skipped; exit 1 |
| `cd mcp && npm run build` | `tsc`, exit 0 |

The canonical runner deliberately exits 1 because 40 of the skipped tests require
an unavailable live Medplum stack. No opt-out was set. These are not passing live
authorization tests. WestFax was never contacted; every WestFax test used synthetic
responses and substituted fetch at the transport boundary. Real credentials were
not read, requested, or used.

## Mandate 17

Mutations ran in `/tmp/odos-fax-live-repair-mutants` detached at the tested source SHA.
Each mutation was checked with `rg` before execution; each was restored and
`git status --porcelain` was empty before GREEN. Each run covered 38 tests.

| Mutation | Confirmed change | RED | Restored GREEN |
| --- | --- | --- | --- |
| StartDate removed | request field absent, rg exit 1 | 35 passed, 3 failed | 38 passed, 0 failed |
| OrigCSID extraction removed | extraction absent, rg exit 1 | 35 passed, 3 failed | 38 passed, 0 failed |
| Reference parsing reintroduced | parser present, rg exit 0 | 36 passed, 2 failed | 38 passed, 0 failed |
| CSID argument removed from poller | argument absent, rg exit 1 | 37 passed, 1 failed | 38 passed, 0 failed |
| CSID persistence removed | stored value absent, rg exit 1 | 36 passed, 2 failed | 38 passed, 0 failed |
| Exact-name guard weakened to prefix match | prefix check present, rg exit 0 | 37 passed, 1 failed | 38 passed, 0 failed |

The dynamic search-query inventory validates declared parameter names, but omission
of an individual query variant is not enforced by that inventory. It is not claimed
as an omission guard. The executed matcher tests assert the emitted name queries.

## Fixture correction

[fixture.diff](fixture.diff) contains the new full synthetic response;
[adapter-tests.diff](adapter-tests.diff) shows the old mock being replaced and the
request/parser assertions. The normal fixture has all captured top-level and
FaxCallInfoList fields, including OrigCSID, and no Reference, Category, or OCR field.
Reference exists only in explicit negative-test inputs.

```diff
- Reference: "synthetic caller metadata",
- FaxCallInfoList: [{ OrigNumber: "8645550199" }],
+ FaxCallInfoList: [{
+   CallId: "synthetic-call",
+   CompletedUTC: "2026-09-02T14:00:00Z",
+   TermNumber: "1999999984",
+   OrigNumber: "0123456789",
+   TermCSID: "Synthetic Receiving Practice",
+   OrigCSID: "Synthetic Referral Practice",
+   Result: "Success",
+   CallPageCount: 2,
+   FilterFlag: "None",
+ }],
```

## Follow-up and limits

The operator runs `cd mcp && node scripts/verify-westfax-live.mjs` after merge, with
WESTFAX_USERNAME, WESTFAX_PASSWORD, and WESTFAX_PRODUCT_ID already supplied through
the process environment. The script does not load a credential file or require a
callback URL. Optional WESTFAX_BASE_URL and WESTFAX_INBOUND_LOOKBACK_DAYS are documented
in `.env.example`. Keep printed account metadata local; do not paste it into a PR.

This is a descriptions-read check, not proof of the whole ingestion workflow or live
FHIR name-index behavior. Live WestFax and real Medplum enforcement remain unproven.
Older faxes outside the lookback are excluded. CSIDs must match stored referrer names
exactly after case/whitespace normalization; no OCR or classification was added.
The operator's console read-state workflow decision remains open and unchanged.

No new medical code or FHIR artifact URL was introduced; Mandate 14 ledger rows: 0.
No new product/workflow decision was made; PerformanceOD decisions/INDEX.md unchanged.
Cross-repo follow-up: none required for this repair. The separate read-state workflow
decision remains with the operator.

## References checked

Accessed 2026-09-03. Captured shape and multipart behavior came from the operator's
repair brief; fixture values are invented and satisfy the existing synthetic-data guard.

- [WestFax official Postman reference](https://www.postman.com/westfax/westfax-s-public-workspace/documentation/6mip0lp/westfax-api?entity=request-404845-6d40ba71-83da-47f6-984e-eabc7ffde56b): date-range and ID-based descriptions endpoints, StartDate.
- [WestFax response reference](https://westfax.com/knowledge-base/api-parameters-and-return-values-decoded/): OrigCSID in FaxCallInfoList.
- [FHIR R4 string search](https://www.hl7.org/fhir/R4/search.html#string) and
  [Medplum search documentation](https://www.medplum.com/docs/search/basic-search):
  name-part/prefix querying, followed by local exact whole-name comparison.

NOT EVALUATED. Codex authored this implementation; independent Opus evaluation must
read the final PR head, actual diff, and evidence before merge.
