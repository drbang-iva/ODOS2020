# Propagation writer guard evidence

Run from the repository root: `python3 docs/build-log/guarantor-g2a/writer-mutations/run.py`.

The runner copies the writer and transport-backed fixture into a temporary workspace, links installed dependencies, runs each mutation independently, restores the copied source, and runs the complete focused suite. It never mutates the working source. `results.json` records 18 mutation runs, each exit 1 with one failed test. `restored-green.txt` records 15 tests passed, 0 failed. No guard in this inventory is decorative.

| Guard | Mutation | Red evidence |
|---|---|---|
| Q1 | Omit child writes | Q1-Q2.txt |
| Q2 | Omit child writes; independent fresh SMS assertion | Q2.txt |
| Q3 | Flip one child's consent sentinel | Q3.txt |
| Q4 | Submit unchanged Patient PUT | Q4.txt |
| Q5a | Disable version preflight | Q5a-Q6a.txt |
| Q5b | Remove parent If-Match | Q5b.txt |
| Q6a | Disable version preflight; independent stale-child assertion | Q6a.txt |
| Q6b | Remove child If-Match | Q6b.txt |
| Q7 | Write first linked child only | Q7.txt |
| Q8 | Label by guardian; misclassify unknown read | Q8-label.txt, Q8-unknown.txt |
| Q9a | Disable unchanged-edit short circuit | Q9a.txt |
| Q9b | Rewrite already matching child | Q9b.txt |
| Q9c | Repair against prior Person generation; omit structured superseded status | Q9c.txt, Q9c-status.txt |
| Q10 | Silently POST Person from direct save handler | Q10.txt |
| Q12 | Disable write-handler cardinality refusal | Q10-Q12.txt |
| Q13 | Omit trailing Person re-read | Q13.txt |

Q11 and rendered zero/many-match controls have separate UI evidence. The Q13 competitor runs immediately before the trailing Person GET, after the last child GET has completed. Q5b competes immediately before the separate Person PUT. Q6b and Q9b compete before the child PUT after the Person commit. These timings are part of the fixture, not relocated to preflight.

The fixture persists cloned resources independently of request inputs, honors conditional writes, captures every mutation, and reads fresh persisted resources for content assertions. Child A and B have distinct patient names, role/authority sentinels, notes, periods, and unrelated extensions; a same-name unlinked decoy remains unchanged. HTTP interaction with a real pinned Medplum server is recorded separately by the task's live-proof lane. This is author verification, not an independent evaluation.
