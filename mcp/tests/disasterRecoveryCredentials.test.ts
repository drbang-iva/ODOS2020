import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);

for (const script of ["backup.sh", "restore.sh"]) {
  for (const variable of ["ODOS_POSTGRES_URL", "ODOS_REDIS_PASSWORD"]) {
    for (const missing of [true, false]) {
      test(`${script} refuses ${missing ? "missing" : "empty"} ${variable} before any operation`, () => {
        withScriptProbe(script, { [variable]: missing ? undefined : "" }, (result, marker) => {
          assert.equal(result.status, 1);
          assert.match(result.stderr, new RegExp(variable));
          assert.equal(existsSync(marker), false);
        });
      });
    }
  }
  test(`${script} accepts supplied credentials and reaches its first operation`, () => {
    withScriptProbe(script, {}, (result, marker) => {
      assert.equal(result.status, 73);
      assert.equal(readFileSync(marker, "utf8"), "operation intercepted\n");
      assert.doesNotMatch(result.stderr, /Set ODOS_(POSTGRES_URL|REDIS_PASSWORD)/);
    });
  });
}

function withScriptProbe(
  script: string,
  overrides: Record<string, string | undefined>,
  check: (result: ReturnType<typeof spawnSync<string>>, marker: string) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "odos-dr-credentials-"));
  try {
    const bin = join(directory, "bin");
    const marker = join(directory, "operation");
    mkdirSync(bin);
    for (const command of ["mkdir", "node"]) {
      writeFileSync(join(bin, command), '#!/bin/sh\nprintf "operation intercepted\\n" > "$PROBE_MARKER"\nexit 73\n', { mode: 0o700 });
    }
    const result = spawnSync("/bin/bash", [fileURLToPath(new URL(`scripts/${script}`, root)), "fixture-manifest.json"], {
      cwd: directory,
      env: {
        PATH: bin,
        PROBE_MARKER: marker,
        ODOS_BACKUP_TIMESTAMP: "fixture",
        ODOS_POSTGRES_URL: "postgresql://fixture:synthetic@invalid.test/fixture",
        ODOS_REDIS_PASSWORD: "fixture-$unexpanded:${literal}@/?#%'quote",
        ...overrides,
      },
      encoding: "utf8",
      timeout: 5_000,
    });
    check(result, marker);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("drill child commands never inherit the persistent Redis password", () => {
  const directory = mkdtempSync(join(tmpdir(), "odos-dr-isolation-"));
  try {
    const hook = join(directory, "intercept.cjs");
    writeFileSync(hook, `
      const assert = require('node:assert/strict');
      let calls = 0;
      require('node:child_process').execFileSync = (command, args, options) => {
        if (command === 'which') return Buffer.from('/synthetic/docker-compose');
        assert.equal(options.env.ODOS_REDIS_PASSWORD, 'medplum');
        calls++;
        return Buffer.from('1');
      };
      require('node:module').syncBuiltinESMExports();
      process.on('exit', () => assert.ok(calls >= 10, 'must exercise the drill child-command boundary'));
    `);
    const result = spawnSync(process.execPath, [
      "--require", hook,
      "--import", fileURLToPath(new URL("node_modules/tsx/dist/loader.mjs", root)),
      fileURLToPath(new URL("scripts/dr-drill.ts", root)),
    ], {
      cwd: directory,
      env: { PATH: process.env.PATH, ODOS_REDIS_PASSWORD: "fixture-persistent-only" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DR drill complete/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
