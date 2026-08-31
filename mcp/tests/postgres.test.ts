import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  createPostgresClient,
  createPostgresPool,
  type PostgresErrorLogger,
} from "../src/postgres.js";
import { withPostgresTestDatabase } from "./integration-helpers.js";

test("an idle PostgreSQL pool logs an administrative disconnect instead of crashing", { timeout: 10_000 }, async (t) => {
  const postgresUrl = requirePostgres(t);
  if (!postgresUrl) return;
  const captured = capturePostgresError();
  const admin = createPostgresClient(
    { connectionString: postgresUrl },
    "pool termination test admin",
  );
  const pool = createPostgresPool(
    { connectionString: postgresUrl, max: 1 },
    "forced pool termination test",
    captured.log,
  );
  t.after(async () => {
    await pool.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  await admin.connect();
  const result = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  await admin.query("SELECT pg_terminate_backend($1)", [result.rows[0].pid]);

  const logged = await captured.next;
  assert.match(logged.message, /PostgreSQL pool error \(forced pool termination test\)/);
  assert.match(logged.error.message, /terminating connection due to administrator command/);
});

test("a PostgreSQL client logs an administrative disconnect instead of crashing", { timeout: 10_000 }, async (t) => {
  const postgresUrl = requirePostgres(t);
  if (!postgresUrl) return;
  const captured = capturePostgresError();
  const admin = createPostgresClient(
    { connectionString: postgresUrl },
    "client termination test admin",
  );
  const client = createPostgresClient(
    { connectionString: postgresUrl },
    "forced client termination test",
    captured.log,
  );
  t.after(async () => {
    await client.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  await Promise.all([admin.connect(), client.connect()]);
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  await admin.query("SELECT pg_terminate_backend($1)", [result.rows[0].pid]);

  const logged = await captured.next;
  assert.match(logged.message, /PostgreSQL client error \(forced client termination test\)/);
  assert.match(logged.error.message, /terminating connection due to administrator command/);
});

test("the temporary database lifecycle drains pools before forced drop", { timeout: 10_000 }, async (t) => {
  const postgresUrl = requirePostgres(t);
  if (!postgresUrl) return;
  const errors: Error[] = [];

  await withPostgresTestDatabase(
    { adminUrl: postgresUrl, namePrefix: "odos_pg_lifecycle" },
    async (database) => {
      const pool = database.createPool(
        { max: 1 },
        "temporary database lifecycle test",
        (_message, error) => errors.push(error),
      );
      await pool.query("SELECT 1");
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(errors, []);
});

test("the temporary database lifecycle still force-drops after a drain timeout", { timeout: 15_000 }, async (t) => {
  const postgresUrl = requirePostgres(t);
  if (!postgresUrl) return;
  const admin = createPostgresClient(
    { connectionString: postgresUrl },
    "drain-timeout verification admin",
  );
  let databaseName: string | undefined;
  let blocker: ReturnType<typeof createPostgresClient> | undefined;
  await admin.connect();

  try {
    let lifecycleError: unknown;
    try {
      await withPostgresTestDatabase(
        { adminUrl: postgresUrl, namePrefix: "odos_pg_drain_timeout" },
        async (database) => {
          databaseName = new URL(database.connectionString).pathname.slice(1);
          blocker = createPostgresClient(
            { connectionString: database.connectionString },
            "unregistered drain-timeout blocker",
            () => undefined,
          );
          await blocker.connect();
        },
      );
    } catch (error) {
      lifecycleError = error;
    }
    assert.ok(lifecycleError instanceof AggregateError);
    assert.equal(
      lifecycleError.errors.some((error) =>
        error instanceof Error && /still has active connections after drain/.test(error.message)
      ),
      true,
    );
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    assert.equal(exists.rowCount, 0);
  } finally {
    await blocker?.end().catch(() => undefined);
    if (databaseName) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    }
    await admin.end();
  }
});

function requirePostgres(t: TestContext): string | undefined {
  const postgresUrl = process.env.ODOS_POSTGRES_URL;
  if (!postgresUrl) t.skip("ODOS_POSTGRES_URL is required for PostgreSQL error-handler tests.");
  return postgresUrl;
}

function capturePostgresError(): {
  readonly log: PostgresErrorLogger;
  readonly next: Promise<{ message: string; error: Error }>;
} {
  let resolve!: (value: { message: string; error: Error }) => void;
  const next = new Promise<{ message: string; error: Error }>((done) => {
    resolve = done;
  });
  return {
    log: (message, error) => resolve({ message, error }),
    next,
  };
}
