# A3.2 credentialed live authorization evidence

Author-side verification of the uncommitted A3.2 worktree at base HEAD `a211b36887b49139ab29cf2d811a5a30f261034d`; not an independent evaluation.

Command: `npm --prefix mcp run test:live-authz`.

Result: exit 0; 73 tests, 73 passed, 0 failed, 0 skipped, 0 cancelled; 69.47 seconds. Raw output is in `live-authz.log`; the exit code and non-secret command context are adjacent.

The command ran with a clean allowlisted environment against the local synthetic Medplum stack at port 28103 and PostgreSQL at port 25433. Admin and operator values came from the gitignored served-stack files. No inherited deployment credentials were supplied. A synthetic ContractSearch patient was seeded in the same verified project for the lane fixture. No source or policy changes were made, and the stack remains running. The raw log was checked against credential secret values; none were present.

The lane exercises stored authorization for clinical writes, Provider/Staff undo lifecycle, diagnosis door, Ocular save/carry/void/undo and closed/pre-rebuild/audit behavior, and project-scoped MCP identity and refusal behavior.

Limitation: the existing lifecycle amendment case records a known defect instead of requiring Provenance creation. Its transaction returned entry statuses 200 and 404: the Observation became amended, but the project-scoped client-chosen Provenance PUT did not create a resource. See `live-authz.log` line 374 and its existing kickoff rev 2.5 section 3.13 annotation. The 73 passing tests do not establish successful lifecycle Provenance persistence.
