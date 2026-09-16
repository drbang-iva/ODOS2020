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
| W55 | 1 pass / 2 fail | 3 pass / 0 fail |
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
