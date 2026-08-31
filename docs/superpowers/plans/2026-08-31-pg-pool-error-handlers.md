# PostgreSQL Pool Error Handlers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent PostgreSQL administrative disconnects from becoming process-level uncaught exceptions, guarantee test databases drain before forced drop, and keep preflight running when MCP CI fails.

**Architecture:** A production PostgreSQL factory will be the only repository-owned construction path for `pg` pools and clients, attaching an immediate contextual error logger to each instance. The existing integration helper will own temporary-database creation, tracked connections/drainers, ordered shutdown, and forced drop. The preflight job will be dependency-free so GitHub schedules it regardless of the MCP result.

**Tech Stack:** TypeScript, Node.js test runner, `pg` 8.20, PostgreSQL 16, GitHub Actions YAML.

**Spec:** `/Users/ericr.bang/.codex/attachments/90e1d9b2-d69f-495c-82fe-cf2437009539/pasted-text.txt`

## Global Constraints

- Base is `main` at `5a323f19`; branch is `drbang-iva/pg-pool-error-handlers`; worktree is `.worktrees/pg-pool-error-handlers`.
- Do not change existing test assertions or what they exercise.
- Keep `DROP DATABASE ... WITH (FORCE)` as a backstop after all registered resources drain.
- Every repository-owned `pg` `Pool` and `Client` must log asynchronous errors through an attached listener.
- Run PostgreSQL-backed MCP verification with `ODOS_POSTGRES_URL`; report skips and exact counts.
- Report the supplied before rate of 2 failures in 20 runs against an after loop of 40 runs.
- Open a PR to `main`; do not merge; Opus 5 evaluates the exact head.

---

### Task 1: Safe PostgreSQL construction

**Files:**
- Create: `mcp/src/postgres.ts`
- Create: `mcp/tests/postgres.test.ts`
- Modify: the 11 production files and `mcp/tests/claimReadModelStore.test.ts` that directly construct `pg` pools.

**Interfaces:**
- Consumes: `pg` `PoolConfig` and `ClientConfig`.
- Produces: `createPostgresPool(config, context, logError?)` and `createPostgresClient(config, context, logError?)`.

- [x] **Step 1: Write the failing forced-termination tests**

```ts
test("an idle PostgreSQL pool logs an administrative disconnect instead of crashing", async (t) => {
  const target = createPostgresPool({ connectionString: postgresUrl, max: 1 }, "test pool", capture);
  const [{ pid }] = (await target.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows;
  await admin.query("SELECT pg_terminate_backend($1)", [pid]);
  await logged;
  assert.match(messages[0], /terminating connection due to administrator command/);
});
```

Add the equivalent connected `Client` test so removing either listener returns a process-level test failure.

- [x] **Step 2: Run the focused test and verify RED**

Run: `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum npx tsx --test tests/postgres.test.ts`

Expected: module/export failure because the safe constructors do not exist.

- [x] **Step 3: Implement minimal constructors and migrate call sites**

```ts
export function createPostgresPool(config: PoolConfig, context: string, logError = defaultLog): Pool {
  const pool = new Pool(config);
  pool.on("error", (error) => logError(`PostgreSQL pool error (${context})`, error));
  return pool;
}
```

Implement the matching client constructor, then replace every direct repository construction outside this module.

- [x] **Step 4: Run focused tests and typecheck GREEN**

Run: `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum npx tsx --test tests/postgres.test.ts && npx tsc --noEmit`

Expected: 2 tests pass, 0 fail; typecheck exits 0.

### Task 2: Temporary PostgreSQL database lifecycle

**Files:**
- Modify: `mcp/tests/integration-helpers.ts`
- Modify: `mcp/tests/liveAuditSchema.test.ts`
- Modify: `mcp/tests/wenoDrugDatabase.test.ts`
- Modify: `mcp/tests/wenoPharmacyDirectory.test.ts`
- Modify: `mcp/tests/creditBank.test.ts`
- Modify: `mcp/tests/eyeGrowth.test.ts`
- Test: `mcp/tests/postgres.test.ts`

**Interfaces:**
- Consumes: `createPostgresPool` and `createPostgresClient` from Task 1.
- Produces: `withPostgresTestDatabase({ adminUrl, namePrefix }, callback)` and a callback fixture that registers async drainers and creates tracked connected clients.

- [x] **Step 1: Add a lifecycle-order regression test**

```ts
await withPostgresTestDatabase({ adminUrl: postgresUrl, namePrefix: "odos_pg_lifecycle" }, async (database) => {
  const pool = database.createPool({ max: 1 }, capture);
  await pool.query("SELECT 1");
});
assert.deepEqual(errors, []);
```

The mutation that drops before awaiting registered drainers must emit an administrative-disconnect error and fail this assertion.

- [x] **Step 2: Run the lifecycle test and verify RED**

Run: `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum npx tsx --test tests/postgres.test.ts`

Expected: missing helper export.

- [x] **Step 3: Implement the ordered lifecycle and migrate five teardown files**

```ts
try {
  return await callback(fixture);
} finally {
  await drainRegisteredResources();
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.end();
}
```

Preserve all existing assertions and test bodies while replacing hand-rolled create/connect/drain/drop code with the shared lifecycle.

- [x] **Step 4: Run the six PostgreSQL files GREEN**

Run: `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum ODOS_TEST_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15433/medplum npx tsx --test tests/liveAuditSchema.test.ts tests/wenoDrugDatabase.test.ts tests/wenoPharmacyDirectory.test.ts tests/creditBank.test.ts tests/eyeGrowth.test.ts tests/claimReadModelStore.test.ts tests/postgres.test.ts`

Expected: 0 failures and no destructive fixture skips.

### Task 3: Independent preflight CI

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: GitHub Actions job scheduling.
- Produces: a `preflight` job without an MCP-result dependency.

- [x] **Step 1: Record the RED workflow behavior**

Use the current exact-head or historical main workflow run where `mcp` failed and query job conclusions with `gh`; record that `preflight` concluded `skipped`.

- [x] **Step 2: Remove the dependency**

```yaml
preflight:
  name: preflight — Pass 4 custom lint rules
  runs-on: ubuntu-latest
```

- [x] **Step 3: Validate the workflow and later confirm PR job scheduling**

Run the repository's workflow checks locally, then inspect the PR run to confirm preflight is scheduled independently.

### Task 4: Mutation, statistical, and full verification

**Files:**
- Modify only files required by Tasks 1-3.

**Interfaces:**
- Consumes: completed implementation.
- Produces: sealed evidence bundle and exact-head PR.

- [x] **Step 1: Break and restore the pool/client listener**

Remove one listener, force backend termination with `tests/postgres.test.ts`, record the uncaught-exception failure, restore, and record GREEN.

- [x] **Step 2: Break and restore lifecycle order**

Move forced drop before registered drain, run the lifecycle test until RED (record run count), restore, and record GREEN.

- [x] **Step 3: Run the required 40-run loop**

Run the exact six-file command from the spec 40 times and report exact failure count, retaining per-run pass/fail summaries.

- [x] **Step 4: Run full verification**

Run branch print, PostgreSQL-backed `mcp/npm test`, MCP typecheck, UI tests, UI build, and preflight. Record full counts and any skips.

- [ ] **Step 5: Commit, push, open PR, and inspect exact-head gates**

Create focused commits, push without force, open a PR against `main`, adjudicate any existing bot findings, and report the exact head as `needs-review` for Opus 5 independent evaluation.
