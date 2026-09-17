# §6 assertion evidence audit

Base: `1706d7c8417b04791471d4332b4ecd712883bf11`. This is an author evidence-accounting check of the current working diff, not an independent implementation evaluation.

The 14 modified existing test/fixture files contain 2,180 original executable assertions. The context-aware TypeScript AST check accounts for 1,802 retained assertions and 378 assertions with exact base/final mappings to existing V/W rows. There are **0 unmapped original assertions and 0 invalid or ambiguous ledger anchors**. `verification.log` has the per-file counts; `result.json` includes every resolved mapping and its source ledger. `source-digests.json` binds the result to the audited test and ledger bytes.

The audit parses `assert` and `assert.*` calls, compares normalized AST text within the same test/helper context, and validates ledger before and after expressions against real source locations. Explicit known fixture-test renames are allowed only for the OH seed-contract migration and the unknown Undo slot status rename. The W84 old-audit rename and W71 strict-panel rename have individual exact ledger mappings, including unchanged expressions whose fixture semantics moved. New assertions are not treated as deleted original assertions. This checks accounting and executable anchors; it does not establish semantic equivalence of fixtures or replace the family mutation/live proofs.

Evidence-only repairs:

- `core-assertion-migrations.json`: exact base/final locations; added the retained W84 retry assertion and all 11 retained assertions in the W71 panel fixture migration. The latter now starts with one valid panel owner and rejects an older second owner; it does not preserve the superseded newest-timestamp selection claim.
- `library/link-l2-assertions.json`: nine exact mappings copied from the existing V18/V30 Markdown assertion report, matched within each original test context.
- `release/carry-assertion-migration.json`: nine individual exact T1–T3 assertion mappings supplement the original whole-test evidence and existing W73/W74/W75/W126 mapping.
- `release/void-assertion-migration.json`: 16 individual exact lifecycle helper/T10–T14 mappings under existing V26/W76–W78/W127. T14's replacement is exact 422.
- `release/t22-assertion-migration.json`: three exact original T22 assertion mappings to executable real-handler/fixed-ID, attempted/persisted, and Observation classification assertions under W87a/W87b/W129/V35; explanatory rationale is separate from the expressions.
- `overview/assertion-migrations.json`, `protocol/assertion-migrations.json`, and `release/t17-t21-assertions.json`: refreshed executable text/location anchors without changing their existing contract mapping.

No application or test source was changed for this audit. Existing ocular, carry, and lifecycle family ledgers remain the detailed migration evidence and were included in validation. Supplemental file-scope inspection found the 34 modified tracked files and all new source/scripts/tests/evidence within §4's allowed categories; there are no UI, policy, role, or seed changes. `scope-files.txt` records that inventory.

Reproduce from the task worktree root:

```sh
node docs/evidence/r10-a3-1/assertion-audit/verify.cjs
```

Observed exit 0; summary: `originalAssertions=2180 retained=1802 mappedChanges=378 gaps=[] ledgerIssues=[]`. `git diff --check` also exited 0. This audit ran no tests, mutations, live calls, or containers. No commits were created. Status: evidence accounting complete; independent evaluation remains separate.
