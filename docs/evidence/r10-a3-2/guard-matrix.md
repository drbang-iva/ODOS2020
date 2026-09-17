# Guard mutation census

Counts are pass / fail. Detailed mutations and exact test names remain in the linked raw logs and per-area ledgers. Shared restored runs can include both callers.

| Guard | Red | Restored green |
|---|---|---|
| W130 | [11/2](editor/W130-mutation-red.txt) | [13/0](editor/W130-restored-green.txt) |
| W131 | [12/1](editor/W131-mutation-red.txt) | [13/0](editor/W131-restored-green.txt) |
| W132 | [12/1](editor/W132-mutation-red.txt) | [13/0](editor/W132-restored-green.txt) |
| W133 | [12/1](editor/W133-mutation-red.txt) | [13/0](editor/W133-restored-green.txt) |
| W134 | [11/2](editor/W134-mutation-red.txt) | [13/0](editor/W134-restored-green.txt) |
| W135 | [12/1](editor/W135-mutation-red.txt) | [13/0](editor/W135-restored-green.txt) |
| W136 | [11/2](editor/W136-mutation-red.txt) | [13/0](editor/W136-restored-green.txt) |
| W137 | [12/1](editor/W137-mutation-red.txt) | [13/0](editor/W137-restored-green.txt) |
| W138 | [12/1](editor/W138-mutation-red.txt) | [13/0](editor/W138-restored-green.txt) |
| W145 | [12/1](editor/W145-mutation-red.txt) | [13/0](editor/W145-restored-green.txt) |
| W139 | [2/1](picker/W139-picker-red.txt) | [25/0](picker/W139-restored-green.txt) |
| W140 supports | [1/2](picker/W140-supports-picker-red.txt) | [25/0](picker/W140-supports-restored-green.txt) |
| W140 shared helper: picker | [1/2](picker/W140-shared-scope-picker-red.txt) | [25/0](picker/W140-shared-scope-restored-green.txt) |
| W140 shared helper: workspace | [20/2](picker/W140-shared-scope-workspace-red.txt) | [25/0](picker/W140-shared-scope-restored-green.txt) |
| W141 | [0/1](assessment-mutation-red.log) | [1/0](assessment-mutation-green.log) |
| W147 editability | [2/3](w147-editability-on-witness-red.log) | [5/0](w147-editability-on-witness-restored.log) |
| W147 freshness | [4/1](w147-skip-witness-match-red.log) | [5/0](w147-skip-witness-match-restored.log) |

W142/W143: [carry mutation counts and restoration](carry/assertion-ledger.md). W144: [three mutations and 74/74 restoration](void-undo/assertion-ledger.md). W146: [actual Caddy diff red/restored plus asynchronous readiness mutation](harness/setup-summary.md). Additional frozen-scope V21/V22: [both 0/1 red then 1/0 green](frozen-scope/README.md).
