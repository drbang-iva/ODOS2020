import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const compose = [
  ["docker", "compose"],
  ["docker-compose"],
].find(([command, ...args]) => spawnSync(command!, [...args, "version"], { stdio: "ignore" }).status === 0);

function renderCompose(file: string, password?: string, redis: { password?: string } = { password: "fixture-redis" }) {
  assert.ok(compose, "Docker Compose is required to verify the database configuration contract");
  const directory = mkdtempSync(join(tmpdir(), "odos-database-config-"));
  try {
    copyFileSync(new URL(`../../${file}`, import.meta.url), join(directory, file));
    mkdirSync(join(directory, ".odos"));
    writeFileSync(join(directory, ".odos/medplum-signing.env"), "");
    writeFileSync(join(directory, ".odos/medplum-dr-drill-signing.env"), "");
    writeFileSync(join(directory, ".env"), [
      "MEDPLUM_ADMIN_EMAIL=fixture@example.test",
      "MEDPLUM_ADMIN_PASSWORD=fixture-only",
      ...(redis.password === undefined ? [] : [`ODOS_REDIS_PASSWORD='${redis.password.replaceAll("'", "\\'")}'`]),
      ...(password === undefined ? [] : [`MEDPLUM_DATABASE_PASSWORD='${password.replaceAll("'", "\\'")}'`]),
      "",
    ].join("\n"), { mode: 0o600 });
    const [command, ...args] = compose;
    return spawnSync(command!, [...args, "--profile", "agentops", "-p", "odos-database-config-test", "-f", file, "config", "--format", "json"], {
      cwd: directory,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 20_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [label, password] of [["missing", undefined], ["empty", ""]] as const) {
  test(`main stack refuses ${label} runtime database passwords`, () => {
    const result = renderCompose("docker-compose.yml", password);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MEDPLUM_DATABASE_PASSWORD/);
  });
}

test("main stack gives Medplum and PostgreSQL the same literal runtime password", () => {
  const password = "fixture-$unexpanded:${literal}@/?#%'quote";
  const result = renderCompose("docker-compose.yml", password);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  // Compose escapes dollars when serializing a reusable configuration.
  const renderedPassword = "fixture-$$unexpanded:$${literal}@/?#%'quote";
  assert.equal(config.services.postgres.environment.POSTGRES_PASSWORD, renderedPassword);
  assert.equal(config.services["medplum-server"].environment.MEDPLUM_DATABASE_PASSWORD, renderedPassword);
  assert.equal(config.services["odos-core"].environment.PGPASSWORD, renderedPassword);
  assert.equal(config.services["odos-core"].environment.ODOS_POSTGRES_URL, "postgresql://medplum@postgres:5432/medplum");
  const client = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { Client } from 'pg';
    const client = new Client({ connectionString: process.env.ODOS_POSTGRES_URL });
    assert.equal(client.password, process.env.PGPASSWORD);
    assert.equal(client.host, 'postgres');
    assert.equal(client.port, 5432);
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { PATH: process.env.PATH, PGPASSWORD: password, ODOS_POSTGRES_URL: config.services["odos-core"].environment.ODOS_POSTGRES_URL },
    encoding: "utf8",
  });
  assert.equal(client.status, 0, client.stderr);
  assert.deepEqual(config.services["medplum-server"].command, ["file:/config/medplum.config.json,env"]);
});

test("isolated drill does not consume the persistent stack's database password", () => {
  for (const password of [undefined, "fixture-persistent-only"]) {
    const result = renderCompose("docker-compose.dr-drill.yml", password);
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.services.postgres.environment.POSTGRES_PASSWORD, "medplum");
    assert.equal(config.services["medplum-server"].environment?.MEDPLUM_DATABASE_PASSWORD, undefined);
  }
});

for (const [label, password] of [["missing", undefined], ["empty", ""]] as const) {
  test(`main stack refuses ${label} runtime Redis passwords`, () => {
    const result = renderCompose("docker-compose.yml", "fixture-postgres", { password });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ODOS_REDIS_PASSWORD/);
  });
}

test("Redis command, healthcheck, and Medplum share the literal runtime password", () => {
  const password = "fixture-$unexpanded:${literal}@/?#%'quote";
  const result = renderCompose("docker-compose.yml", "fixture-postgres", { password });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  const rendered = "fixture-$$unexpanded:$${literal}@/?#%'quote";
  assert.deepEqual(config.services.redis.command, ["redis-server", "--requirepass", rendered]);
  assert.deepEqual(config.services.redis.healthcheck.test, ["CMD", "redis-cli", "-e", "--pass", rendered, "ping"]);
  assert.equal(config.services["medplum-server"].environment.MEDPLUM_REDIS_PASSWORD, rendered);
  const tracked = JSON.parse(readFileSync(new URL("../../medplum.config.json", import.meta.url), "utf8"));
  assert.equal(tracked.redis.password, "INERT_ENV_OVERLAY_REQUIRED");
});

test("drill Redis keeps its own credential regardless of the persistent password", () => {
  for (const password of [undefined, "", "fixture-persistent-only"]) {
    const result = renderCompose("docker-compose.dr-drill.yml", undefined, { password });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.deepEqual(config.services.redis.command, ["redis-server", "--requirepass", "medplum"]);
    assert.deepEqual(config.services.redis.healthcheck.test, ["CMD", "redis-cli", "--pass", "medplum", "ping"]);
    assert.equal(config.services["medplum-server"].environment?.MEDPLUM_REDIS_PASSWORD, undefined);
  }
});
