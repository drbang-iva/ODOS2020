# Mutation evidence index

All listed red commands exited 1 and their restored commands exited 0. W40 contains three separate mutations in gate evidence.

| Red evidence | Counts | Restored evidence | Counts |
|---|---|---|---|
| findings/W26-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W26-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W27-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W27-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W28a-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W28a-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W28b-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W28b-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W31-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W31-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W32-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W32-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W33-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W33-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W34-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W34-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W39-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W39-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W4-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W4-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W41-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W41-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W42-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W42-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W43-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W43-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W44-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W44-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W45-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W45-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W7-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W7-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| findings/W8-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | findings/W8-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| gate/W40-delete-test-and-manifest-red.txt | see raw command output | gate/W40-delete-test-and-manifest-green.txt | see raw command output |
| gate/W40-delete-test-red.txt | see raw command output | gate/W40-delete-test-green.txt | see raw command output |
| gate/W40-skip-red.txt | see raw command output | gate/W40-skip-green.txt | see raw command output |
| live/W7-red.tap | tests=4; pass=2; fail=2; skipped=0; todo=0 | live/W7-green.tap | tests=4; pass=4; fail=0; skipped=0; todo=0 |
| pick/W10-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | pick/W10-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| pick/W29-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | pick/W29-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| pick/W30-red.tap | tests=1; pass=0; fail=1; skipped=0; todo=0 | pick/W30-green.tap | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| pick/W35-red.tap | tests=4; pass=1; fail=3; skipped=0; todo=0 | pick/W35-green.tap | tests=4; pass=4; fail=0; skipped=0; todo=0 |
| writer/W38-red.txt | tests=1; pass=0; fail=1; skipped=0; todo=0 | writer/W38-green.txt | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| writer/W44-red.txt | tests=1; pass=0; fail=1; skipped=0; todo=0 | writer/W44-green.txt | tests=1; pass=1; fail=0; skipped=0; todo=0 |
| writer/W45-red.txt | tests=1; pass=0; fail=1; skipped=0; todo=0 | writer/W45-green.txt | tests=1; pass=1; fail=0; skipped=0; todo=0 |

Additional fixback guards: W7 composite selection is1 failed→1 passed (ci-fixback/composite-policy-{red,green}.tap); W40 traversal is1 failed→restored checker/findings60 passed (bot-fixback/traversal-red.tap and checker-findings-green.tap). Capture-hook mutation is1 failed→170 passed (rev33/).
