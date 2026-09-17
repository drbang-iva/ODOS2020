# Guard evidence

All temporary production mutations restored. W51 follows the approved rev 3.6 request-boundary mutation; DiagnosisPicker production is unchanged.

| Guard mutation | Red counts | Evidence |
|---|---|---|
| W48-red | 0 pass / 1 fail / 1 total | `table/W48-red.txt` |
| W50-red | 0 pass / 1 fail / 1 total | `table/W50-red.txt` |
| W9-red | 0 pass / 1 fail / 1 total | `table/W9-red.txt` |
| W3-red | 10 pass / 1 fail / 11 total | `workspace/W3-red.tap` |
| W36-red | 10 pass / 1 fail / 11 total | `workspace/W36-red.tap` |
| W37-red | 9 pass / 2 fail / 11 total | `workspace/W37-red.tap` |
| W46-red | 10 pass / 1 fail / 11 total | `workspace/W46-red.tap` |
| W47-red | 10 pass / 1 fail / 11 total | `workspace/W47-red.tap` |
| W49-workspace-red | 10 pass / 1 fail / 11 total | `workspace/W49-workspace-red.tap` |
| W52-red | 10 pass / 1 fail / 11 total | `workspace/W52-red.tap` |
| W53-red | 10 pass / 1 fail / 11 total | `workspace/W53-red.tap` |
| W51 legacy requests | 0 pass / 2 fail / 2 total; restored 2/2 | `W51/red.txt`, `W51/green.txt` |
| W49-count-red | 2 pass / 1 fail / 3 total | `surfaces/W49-count-red.tap` |
| W49-overlay-red | 2 pass / 1 fail / 3 total | `surfaces/W49-overlay-red.tap` |

Restored workspace: 11/11; table:16/16; surfaces:5 pass +4 A3 TODO; W54:1/1 and tsc exit0. See W54/README.md for mutation failure and separate typecheck evidence.

Historical surfaces/W49-candidates logs are superseded by rev 3.6. W49 suggestions failure is covered by the workspace mutation above; legacy picker error handling remains unchanged.

## Evaluation fixback W55–W64

Exact evaluator mutations and executable runner: [fixback/README.md](fixback/README.md). All temporary mutations restored.

| Guard | Red | Restored green |
|---|---|---|
| W55 | 2 pass / 2 fail | 4 pass / 0 fail |
| W56 | 0 pass / 1 fail | 1 pass / 0 fail |
| W57 | 0 pass / 1 fail | 1 pass / 0 fail |
| W58 | 0 pass / 1 fail | 1 pass / 0 fail |
| W59 | 0 pass / 1 fail | 1 pass / 0 fail |
| W60 | 0 pass / 1 fail | 1 pass / 0 fail |
| W61 | 0 pass / 1 fail | 1 pass / 0 fail |
| W62 | 0 pass / 2 fail | 2 pass / 0 fail |
| W63 | 0 pass / 1 fail | 1 pass / 0 fail |
| W64 | 0 pass / 1 fail | 1 pass / 0 fail |

PR-Agent V13 / W-d / W-e support association guard: old tray selection/rendering **0 pass / 1 fail**, restored **1 pass / 0 fail**; fixback/V13-tray-red.tap and V13-tray-green.tap.

## Round 2 F11–F13

- W88: revert only the per-diagnosis merge to the b5376689 per-candidate flat-map. Real two-view OU shape fails the one-button assertion; single-eye case stays green. Red **1 pass / 1 fail** → restored **2 pass / 0 fail**. First contributing id and OD+OS support union are asserted.
- W89: remove mismatched-scope refusal and enable all eye choices. Red **0 pass / 2 fail** → restored **2 pass / 0 fail**. One case checks DOM disabled choices; the other calls the disabled handlers directly and proves the request boundary refuses them. Both assert one OU request with both supports after valid selection.
- W55–W64 re-demonstrated red/green, with identical counts to round 1; all 14 selected tests green after restoration.
- Runner: `round2/run-guards.py`; exact outputs: `round2/W88-*.tap`, `round2/W89-*.tap`, `round2/counts.json`; fresh prior guard outputs: `round2/W55-*.tap` through `round2/W64-*.tap`, `round2/prior-guard-counts.json`.
- F13 is checked against the fetched PR body after publication: exactly one standalone Coded-by line outside fenced code and HTML comments.
