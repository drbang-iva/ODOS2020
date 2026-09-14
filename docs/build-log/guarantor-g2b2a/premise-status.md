# Premise gate — resolved

Prior OOM blocker resolved after the operator freed Docker VM memory. Own fixture restarted with the original 768 MiB container limit, pinned digest and loopback ports. Health: Medplum 5.1.30-9b1bd92, PostgreSQL and Redis available. E1 passed; see mandate14.md and e1-results.json.

Contract revision 2 confirmed remotely. Base 6baea1d51666461e3de94ded1287ffe8817d2f70. Required scoped diff empty in the preceding turn. P1–P4 and P8 read and confirmed at that head. npm ci in root, mcp and ui completed. Recorded baseline remains in baseline/ and was not rerun on resume.

Historical environment failures: three Medplum OOM exits (137) before operator intervention; 768 MiB on two starts and a 1536 MiB runtime override on the third. No other stack was modified. The override was removed before successful E1. The initial E1 instrument needed an empty-Bundle.entry correction, documented in mandate14.md; no application change was used to change the observed server behavior.
