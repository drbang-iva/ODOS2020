import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("G25 catalog persistence tests execute instead of silently skipping", () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--test", "--test-concurrency=1",
    "--test-name-pattern", "C0 accepted through real HTTP|snapshot persistence keeps accepted evidence",
    "tests/visionforgeEducationCatalog.test.ts", "tests/educationCatalogSnapshotStore.test.ts",
  ], { cwd: fileURLToPath(new URL("..", import.meta.url)), env, encoding: "utf8" });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  for (const name of ["C0 accepted through real HTTP", "snapshot persistence keeps accepted evidence"]) {
    assert.match(output, new RegExp(`^ok \\d+ - ${name}[^\\n]*$`, "m"));
    assert.doesNotMatch(output, new RegExp(`^ok \\d+ - ${name}[^\\n]*# SKIP`, "m"));
  }
});
