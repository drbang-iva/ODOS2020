import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../../../..");
const endpoint = "mcp/src/clinical-graph/hpi-endpoint.ts";
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Mutation anchor must occur once: ${before}`);
  return source.replace(before, after);
}
const cases = [
  { id: 14, name: "remove-row-freeze", file: "ui/src/components/charting/HistoryRosSection.tsx", cwd: "ui", test: "tests/historyRosBrowser.test.tsx", pattern: "bulk denial is resumable",
    mutate: source => replaceOnce(source, "<fieldset disabled={sectionBusy}", "<fieldset disabled={false}") },
  { id: 15, name: "divergent-http-door", file: endpoint, cwd: "mcp", test: "tests/historyRosHttp.test.ts", pattern: "I2 every",
    mutate: source => replaceOnce(source, "return handleHistoryItemReviewRequest(deps, input);", "return historySearchResult(() => handleHistoryReview(deps, input));") },
  { id: 16, name: "committed-act-conflict-forever", file: endpoint, cwd: "mcp", test: "tests/historyRosHttp.test.ts", pattern: "I3 committed gestures reach complete after response loss and answer clear",
    mutate: source => {
      source = replaceOnce(source, `    if (existingAct) {
      if (!ledger) return { status: 409, body: { error: "History review gesture targets and method are immutable." } };
      ledger = await updateHistoryBulkDenialLedger(staff.fhir, historyBulkTerminalState(ledger, existingAct));
      return { status: 200, body: historyBulkDenialResponse(ledger) };
    }`, `    if (existingAct && !ledger) return { status: 409, body: { error: "History review gesture targets and method are immutable." } };`);
      return replaceOnce(source, `      if (act.status !== 200) {
        const winner = await findHistoryItemAct(staff.fhir, actIdentifier);
        if (!winner) return act;
        ledger = await updateHistoryBulkDenialLedger(staff.fhir, historyBulkTerminalState(ledger, winner));
        return { status: 200, body: historyBulkDenialResponse(ledger) };
      }`, "      if (act.status !== 200) return act;");
    } },
  { id: 17, name: "initial-412-escapes-recovery", file: endpoint, cwd: "mcp", test: "tests/historyRosHttp.test.ts", pattern: "I4 initial ledger persistence converges after 412",
    mutate: source => replaceOnce(source, "    let durable: HistoryBulkDenialLedger | undefined;", "    if (!ledger && error?.status === 412) throw error;\n    let durable: HistoryBulkDenialLedger | undefined;") },
];
function run(probe, phase) {
  const args = ["--import", "tsx", "--test", `--test-name-pattern=${probe.pattern}`, probe.test];
  const result = spawnSync(process.execPath, args, { cwd: resolve(root, probe.cwd), encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const output = result.stdout + result.stderr;
  writeFileSync(resolve(import.meta.dirname, `${probe.id}-${phase}.log`), output);
  const count = name => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1] ?? NaN);
  return { exit: result.status, signal: result.signal, passed: count("pass"), failed: count("fail"), skipped: count("skipped") };
}
const results = [];
for (const probe of cases) {
  const path = resolve(root, probe.file), original = readFileSync(path, "utf8");
  let red;
  try { writeFileSync(path, probe.mutate(original)); red = run(probe, "red"); }
  finally { writeFileSync(path, original); }
  const restored = run(probe, "restored");
  results.push({ id: probe.id, name: probe.name, file: probe.file, command: `cd ${probe.cwd} && node --import tsx --test --test-name-pattern='${probe.pattern}' ${probe.test}`, red, restored });
  writeFileSync(resolve(import.meta.dirname, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results.at(-1)));
  assert.equal(red.exit, 1); assert.equal(red.failed, 1); assert.equal(red.passed, 0);
  assert.equal(restored.exit, 0); assert.equal(restored.failed, 0); assert.equal(restored.passed, 1);
}
