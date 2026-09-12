import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const compose = [
  ["docker", "compose"],
  ["docker-compose"],
].find(([command, ...args]) => spawnSync(command!, [...args, "version"], { stdio: "ignore" }).status === 0);

function renderCompose(file: string, password?: string) {
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
      ...(password === undefined ? [] : [`MEDPLUM_DATABASE_PASSWORD='${password}'`]),
      "",
    ].join("\n"), { mode: 0o600 });
    const [command, ...args] = compose;
    return spawnSync(command!, [...args, "-p", "odos-database-config-test", "-f", file, "config", "--format", "json"], {
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
  const password = "fixture-$unexpanded:${literal}@/?#%";
  const result = renderCompose("docker-compose.yml", password);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  // Compose escapes dollars when serializing a reusable configuration.
  const renderedPassword = "fixture-$$unexpanded:$${literal}@/?#%";
  assert.equal(config.services.postgres.environment.POSTGRES_PASSWORD, renderedPassword);
  assert.equal(config.services["medplum-server"].environment.MEDPLUM_DATABASE_PASSWORD, renderedPassword);
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
