import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Medplum host ports stay loopback-only", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");

  assert.match(compose, /\n\s+- "127\.0\.0\.1:8103:8103"/);
  assert.match(compose, /\n\s+- "127\.0\.0\.1:8100:3000"/);
  assert.doesNotMatch(compose, /\n\s+- "8103:8103"/);
  assert.doesNotMatch(compose, /\n\s+- "8100:3000"/);
  assert.doesNotMatch(compose, /\n\s+- "0\.0\.0\.0:8103:8103"/);
  assert.doesNotMatch(compose, /\n\s+- "0\.0\.0\.0:8100:3000"/);
});
