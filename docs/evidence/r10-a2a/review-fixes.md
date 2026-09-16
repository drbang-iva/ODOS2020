# Author response to first bot review — NOT EVALUATED

The five CodeRabbit findings on PR #613 at `a5cc847a497addc2bec36facb7a8f8bdb20f9cd0` were verified. Code changes are in `1816ac0acf97f5fc6891876459188ac06b6730ce`; this is author verification, not an independent verdict.

| Finding | Resolution | Evidence |
|---|---|---|
| Local home path in W16 evidence | The runner sanitizes the home prefix as well as the checkout prefix; retained text and compressed logs were rescanned. | Runner regression; refreshed W16 red output; sanitizer report |
| Missing private backup directory | Create the private directory before writing backups. | Fresh-directory runner regression |
| Interrupted child counted as red | Require an integer nonzero exit; interrupted runs fail and restore the source without emitting a successful guard summary. | Interrupted-child runner regression |
| Audit tag can belong to a different Observation | Match tag and Observation target on lookup and verify conditional-create responses. Wrong-target audit debt remains pending; it cannot permit marker replacement. Reassertion cannot accept the wrong target either. | Three library regressions, plus refreshed W19/W20 live guards |
| Error detail containing "audit" changes classification | Only the audit lookup has the audit-failure boundary. Observation/Condition 404 and upstream failures retain their typed categories regardless of message text. | Reader regression |

The approved audit-key protocol remains unchanged: conditional create is still keyed only by `_tag`. A key already bound to the wrong target is refused as inconsistent data, preserving the marker; the writer does not create another Provenance with that key by broadening its conditional query. The capability gate was rerun with freshly compiled provider/staff policies, and all 15 actual writer proofs passed at the fix commit.

- Library regressions: [4 failed before the changes](checks/review-regressions-red.txt); [all 256 focused tests passed afterward](checks/review-regressions-green.txt).
- Runner regressions: [3 failed before the changes](checks/runner-regressions-red.txt), [3 passed afterward](checks/runner-regressions-green.txt). The tests run the actual runner in temporary fixtures with controlled child-process results.
- All 17 required guard mutations were rerun after the fixes, each red then green.
- Full MCP: 5,445 passed, 0 failed, 52 skipped. UI source is unchanged by these fixes; its rebased-tree run remains 1,629/0/0. MCP build and preflight reran successfully.
- The four authorized changes to existing assertion statements are unchanged. No handler, route, UI, client, policy, dependency, or lockfile changed.

If imported or externally modified data binds an audit key to a different Observation, that inconsistency requires correction outside this library's write path. The library fails closed and retains audit debt.
