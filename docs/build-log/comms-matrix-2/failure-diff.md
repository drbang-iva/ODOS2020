# Full MCP failure comparison

Same command and environment on the clean base and task branch. All eight failure names occur on both; zero branch-only and zero base-only. These are baseline/environment failures, left unchanged.

| Failure | Base | Branch |
|---|---|---|
| SMART registration checks auth/me before creating a client in the configured project | failed | failed |
| SMART registration refuses a session project mismatch before POSTing a client | failed | failed |
| a clear persists the encounter undo ledger under the synced Provider and Staff policies on running Medplum | failed | failed |
| audit-only boundary AccessPolicy POST round-trip is accepted by Medplum when integration env is available | failed | failed |
| local Medplum seeds 5001 patient answers, paginates reviews, and excludes ROS in the index | failed | failed |
| synced practice policies enforce all repaired clinical writes on running Medplum | failed | failed |
| update_patient MCP write tool integrates with Medplum | failed | failed |
| v0.5a audit-only boundary AccessPolicy enforces compartment isolation when bound via ProjectMembership (closes Mandate 8 fixture caveat) | failed | failed |

Two SMART registration cases encounter the configured project mismatch. Three live-policy cases require an operator project identifier unavailable in this run. The remaining live cases encounter the synthetic-server request limit or unavailable fixture setup. The complete failure details below preserve the actual comparison.
