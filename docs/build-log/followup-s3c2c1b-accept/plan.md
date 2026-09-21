# S3c-2c-1b implementation plan

Base: `80c365fe6fecbf890d860977db68277aac19e936`.

1. Extend the existing queue fixture with failing tests for charge status, fail-closed reads, and diagnosis matching. Add only the queue data and family lookup needed to pass them.
2. Add failing Accept tests for one order, one charge, shared concepts, uncoded fees, compensation, diagnosis choice, and authorization. Append the unlocked service and charge helpers, then the Accept handler and one route block.
3. Add failing UI tests for gated buttons and row-scoped charge actions. Extend the existing queue client, component, and CSS; preserve the pre-existing payload behavior.
4. Run the specified G1–G16 break/restore mutations, then the full UI and MCP suites, three typechecks, preflight, and the disposable money-seam proof. Record counts and limitations in this build log.
5. Review the exact diff against the allowlist, commit, open a PR to `main`, and leave it `NOT EVALUATED` for Claude Opus 5.
