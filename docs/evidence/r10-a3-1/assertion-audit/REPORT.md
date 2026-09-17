# §6 assertion evidence audit — revision 2.6

Base: `1706d7c8417b04791471d4332b4ecd712883bf11`. Author evidence accounting of the current working diff; **NOT EVALUATED**.

The audit now includes changed tracked files under `mcp/src/__tests__` as well as `mcp/tests` and `ui/src`. Its 26 test/fixture files contain **2,950 original executable assertions**: **2,562 retained**, **388 mapped changes**, **0 unmapped assertions**, **0 invalid or ambiguous ledger anchors**. The 388 include **one explicit removal**, described below, rather than an invented replacement. There are 454 validated mapping records, including additional semantic mappings for assertions whose executable text is retained. `result.json` contains the exact base/final expressions and locations; `rev26-verification.log` contains the reproducible counts.

Previous revision evidence is preserved without modification in `rev25/`: result, report, verifier and source digests. Its narrower inventory counted 2,180 original assertions, 1,802 retained and 378 mapped. These historical counts are not the current scope.

`rev26-normalized-mappings.json` normalizes the reader, protocol and premise replay lanes' existing ledgers into exact AST anchors. It adds:

- Strict panel envelope classification (W71), shared history projection and legacy-row preservation (V18/V21/V23), and eight explicit overview expectation replacements (V27).
- The original protocol search budget after separating exactly pinned R10 guard searches, and the prevalidation/seed prefix ordering (V24/W91/V23/W108). The retained protocol limits remain 24/52 total searches, 4/5 definition searches and 6/10 rule searches.
- Premise replay's current qualifier round trip, overview qualifier normalization, canonical completeness, section void and malformed-record controls (V18/V23/V26/V27/W76/W81). The two opposite completeness assertions retain identical text elsewhere in the helper context; their semantic reassignment is explicitly recorded in the normalized ledger and original replay ledger rather than inferred from the retained count.

**Explicit removal:** `mcp/tests/fixtures/r10/premise-replay.ts:54` at the base asserted HTTP 200 from the obsolete shared snapshot save format. The current fixture injects historical snapshots explicitly to exercise historical read behavior (V23); that injection has no replacement HTTP status assertion. The ledger records the removal with its exact old expression, V23, source evidence and rationale. Current canonical save success and typed qualifiers are independently asserted by E12 (V18). This is not counted as a retained assertion or silently mapped to an unrelated assertion.

The parser still validates `assert` / `assert.*` calls, normalized within their test/helper context. Existing restricted known test renames remain unchanged. Explicit removal entries require a real base anchor, V/W mapping, evidence path, reason and empty after list. No broad rename exception or assertion waiver was added. New assertions are not treated as deleted originals. AST accounting does not establish fixture semantic equivalence or replace behavioral mutations and live proof.

Fixture-only deltas are also part of the evidence: the reader lane's 35 exact overview leaves and six catalog identity replacements; the protocol lane's Encounter/search scoping ledger; and the replay lane's before/after ledger. Original `legacy-baseline.json` and all five `parity-divergences.json` records remain byte-identical. `source-digests.json` now reproducibly binds **48 files**: audited source, normalized and original ledgers, fixture data, and the verifier itself. Separate rev2.5 live-test migration evidence remains supplemental because its newly added test has no assertion baseline at `1706d7c8`.

Reproduce from the task worktree root:

```sh
node docs/evidence/r10-a3-1/assertion-audit/verify.cjs
```

Observed exit 0: `originalAssertions=2950 retained=2562 mappedChanges=388 explicitRemovals=1 gaps=[] ledgerIssues=[]`. All 48 source digests were independently recomputed after generation and matched. Scoped `git diff --check` exited 0.

This integration changed evidence only. No production/test changes, test runs, mutations, live calls, containers, commits, or evaluation verdict were made by this audit step. Lane test and mutation evidence is linked through the underlying ledgers; independent evaluation remains separate.


Evidence housekeeping: renamed the reader and protocol proof directories from `rev26-reader-fixtures` / `rev26-protocol-fixtures` to `rev26-reader-proof` / `rev26-protocol-proof`. Their raw SHA-bearing proof logs were being classified as fixture data by the existing PHI guard. Only evidence directory names and metadata references changed; no test guard was modified. Parent retained the failed full-run log and reported the unchanged guard passing after relocation. This audit regenerated all ledger paths and 48 source hashes, with zero gaps/issues/mismatches. All 14 original source files recorded in the preserved rev2.5 digest set remain byte-identical; the original legacy capture and five divergence records also remain byte-identical to HEAD.
