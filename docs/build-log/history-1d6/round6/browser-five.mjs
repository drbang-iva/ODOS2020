import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../../../..");
const results = [];
for (let run = 1; run <= 5; run += 1) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "tests/historyRosBrowser.test.tsx"], {
    cwd: resolve(root, "ui"), encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = result.stdout + result.stderr;
  writeFileSync(resolve(import.meta.dirname, `browser-final-${run}.log`), output);
  const count = name => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1] ?? Number.NaN);
  const summary = { run, exit: result.status, signal: result.signal, passed: count("pass"), failed: count("fail"), skipped: count("skipped") };
  results.push(summary);
  writeFileSync(resolve(import.meta.dirname, "browser-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(summary));
  assert.equal(summary.exit, 0); assert.equal(summary.passed, 7); assert.equal(summary.failed, 0); assert.equal(summary.skipped, 0);
}
