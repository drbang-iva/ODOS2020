> Historical bot guidance below is superseded by AGENTS.md: poll CodeRabbit and PR-Agent at the final head; do not trigger or wait for the former bot. Adjudicate all existing findings.

# Claims Touch Ledger Fix-back 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR #461 runner-green, capability-enforced, and unable to serve a failed or stale claims projection as healthy.

**Architecture:** Keep the PostgreSQL implementation under test by pointing CI at the PostgreSQL instance its Medplum contract stack already provisions. Enforce `claims.manage` at the shared authenticated-action boundary. Replace capped projection searches with validated FHIR pagination and share a process-local projection-health tracker across the worker and every read-model API so failure or age produces an explicit 503 instead of stale 200 data.

**Tech Stack:** TypeScript, Node test runner, Express, FHIR R4 REST pagination, PostgreSQL 16, GitHub Actions.

**Spec:** PR #461 independent-evaluation feedback and Greptile review threads `PRRT_kwDORzuiA86dhwT3` and `PRRT_kwDORzuiA86dhwT5`.

## Global Constraints

- Continue branch `drbang-iva/claims-touch-ledger-1a`; do not merge.
- Preserve the accepted durable FHIR idempotency behavior.
- Keep FHIR authoritative and PostgreSQL reconstructible.
- Return stale/failing projection state explicitly; never label stale data healthy.
- Record actual RED and restored GREEN output for authorization and projection-ceiling mutations.
- Run MCP build, full MCP tests, preflight, and final-head GitHub checks.

---

### Task 1: PostgreSQL runner parity

**Files:**
- Modify: `.github/workflows/ci.yml`
- Test: `mcp/tests/claimReadModelStore.test.ts`

**Interfaces:**
- Consumes: PostgreSQL exposed by `docker-compose.dr-drill.yml` on `127.0.0.1:15432`.
- Produces: `ODOS_POSTGRES_URL` for the full MCP test step.

- [x] Confirm the runner failure is `ECONNREFUSED 127.0.0.1:5433` while the workflow exposes PostgreSQL on port `15432`.
- [x] Add `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15432/medplum` to the full MCP test environment.
- [x] Run the four real PostgreSQL read-model tests against the same URL and require `4/4` passing.

### Task 2: Capability enforcement

**Files:**
- Modify: `mcp/src/claims/claim-follow-up-routes.ts`
- Modify: `mcp/tests/claimFollowUpRoutes.test.ts`

**Interfaces:**
- Consumes: the authenticated principal's resolved `actorRole` and the canonical `claims.manage` business-action matrix.
- Produces: `403` before any claims route action for a principal without `claims.manage`.

- [x] Add route tests proving a denied principal cannot reach worklist, rebuild, or reason administration.
- [x] Run those tests against the current helper and capture the unauthorized success RED.
- [x] Enforce `claims.manage` at the shared wrapper used by every route in the file.
- [x] Run the authorization tests and capture restored GREEN.
- [x] Temporarily break the capability check, capture the mandated RED, restore it, and rerun GREEN.

### Task 3: Uncapped projection and fail-loud freshness

**Files:**
- Modify: `mcp/src/claims/claim-read-model-projector.ts`
- Modify: `mcp/src/claims/claim-read-model-worker.ts`
- Modify: `mcp/src/claims/claim-follow-up-routes.ts`
- Modify: `mcp/src/claims/claimmd-handlers.ts`
- Modify: `mcp/src/claims/claim-read-model-store.ts`
- Modify: `mcp/src/index.ts`
- Test: `mcp/tests/claimReadModelProjector.test.ts`
- Test: `mcp/tests/claimReadModelWorker.test.ts`
- Test: `mcp/tests/claimFollowUpRoutes.test.ts`
- Test: `mcp/tests/claimSearchHandler.test.ts`
- Test: `mcp/tests/claimReadModelStore.test.ts`

**Interfaces:**
- Consumes: validated same-origin FHIR continuation links and an injected clock.
- Produces: `ClaimReadModelProjectionHealth`, explicit healthy/stale/failed status, and 503 responses for unhealthy search/worklist/metrics.

- [x] Add a 1,001-Claim paginated projector test and capture the current `FhirSearchLimitError` RED.
- [x] Add stale/failure route tests showing current APIs incorrectly return 200.
- [x] Page Claim, ClaimResponse, Task, and batched related-resource searches without an aggregate row ceiling.
- [x] Track attempt, success, failure, and staleness in a shared health object; worker failure marks it failed and successful rebuild marks it healthy.
- [x] Include projection status on healthy read responses and return 503 with the status on failed, uninitialized, or stale state.
- [x] Prevent older per-claim upserts from overwriting newer projection rows using `projected_at` ordering.
- [x] Run focused tests, then temporarily restore the capped projection path and capture the mandated volume RED; restore and rerun GREEN.

### Task 4: Final verification and review hygiene

**Files:**
- Modify: `docs/superpowers/plans/2026-08-30-claims-touch-ledger-fixback-2.md`
- GitHub: PR #461 review threads and checks.

**Interfaces:**
- Consumes: exact final commit SHA.
- Produces: sealed bundle with direct net-new test count and exact runner state.

- [x] Run `npm run build` in `mcp`.
- [x] Run the full local MCP suite and record totals.
- [x] Run root `npm run preflight` and record warnings/blocks.
- [ ] Compute test delta against base `244127c7` from both source declarations and CI runtime totals.
- [ ] Commit, push normally, and wait for final-head CI, PR-Agent, and Greptile.
- [ ] Reply in and resolve both Greptile threads with the exact changes.
- [ ] Re-query `gh pr checks 461` and GraphQL `reviewThreads` at the final head.
- [ ] Return `needs-review`; do not merge.
