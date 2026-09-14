# S7 UI review fixback evidence

Both reported defects were reproduced before implementation. This is author-side regression proof against the approved S7 flow; it is not an independent evaluation.

## Repair checks a matching child's claim

The fresh snapshot had a matching child `a` and a mismatched sibling `b`. A claim landed on `a` after the snapshot read, during the existing ownership check, before the repair loop. The old early match shortcut skipped `a`'s claim check and accepted a PUT to `RelatedPerson/b` (HTTP 200). [Before-fix TAP](repair-before-fix.tap) preserves that write and failing assertion.

Commit `7d47ca1d6e9bd99625e9fb3beec5792550d6bcf9` removes the early shortcut. Every child now follows the existing fresh GET, active claim check, and generation check before a repair write decision. The reproduced claim stops both children, reports `superseded`, and sends no child PUT. Reintroducing the shortcut makes the new test fail.

## Correction text belongs to a Task

The editor first submitted a correction that received HTTP 409 and reloaded the same pending Task. The test then replaced the child's claim with another pending Task and clicked Reload. Previously, the new Task inherited the first Task's explanation. [Before-fix TAP](correction-draft-before-fix.tap) preserves the failing assertion.

Commit `b54710c87efbca79159887e974d3217db14a9b57` clears the correction text only when the loaded pending Task ID changes. The same-Task refusal keeps the explanation. A different Task starts with an empty explanation and disabled Correct control. Both removing the reset and making it unconditional cause the new test to fail.

## Checks

Only two tests were appended to `ui/tests/guarantorLinkOperations.test.tsx`. Its original ten tests and fixture remain byte for byte unchanged. Existing editor, propagation, and demographics-concurrency test bodies were untouched.

[Final focused TAP](focused.tap) records **46 tests, 46 passed, 0 failed**: operation/editor guards 12, existing editor 9, existing propagation 22, and existing demographics concurrency 3. This run followed the complete mutation wave.

All **eight original editor mutations** and **three new review controls** produced the intended assertion failure, then passed after restoration. [results.json](results.json) records commands, counts, implementation commits, source hashes, and mutation outcomes. The `mutations/` directory preserves all 22 TAP outputs. Absolute worktree paths are replaced with `<worktree>` and whitespace-only diagnostic lines are blanked; the original outputs remain in the ignored author logs.

No policy, backend, or live fixture changes were made for these fixes. The parent task owns the full UI suite/build after integration and the final source-bound Chromium capture.
