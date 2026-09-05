import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../../../..");
const endpoint = "mcp/src/clinical-graph/hpi-endpoint.ts";
const hook = "ui/src/components/charting/useHistoryItemReview.tsx";
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Mutation anchor must occur once: ${before}`);
  return source.replace(before, after);
}
const cases = [
  { id: 1, name: "oversize-answer-unit", file: endpoint, cwd: "mcp", test: "tests/historyRosHttp.test.ts", pattern: "bulk units derive seven",
    mutate: source => replaceOnce(source, "const answersPerUnit = HISTORY_CONDITIONAL_BUNDLE_ENTRY_LIMIT - 1;", "const answersPerUnit = HISTORY_CONDITIONAL_BUNDLE_ENTRY_LIMIT;") },
  { id: 3, name: "intended-act-targets", file: endpoint, cwd: "mcp", test: "tests/historyRosHttp.test.ts", pattern: "conditional create preserves",
    mutate: source => replaceOnce(source, "recordHistoryItemReview(staff.fhir, reviewInput(liveNegativeTargets))", "recordHistoryItemReview(staff.fhir, reviewInput(request.targets))") },
  { id: 4, name: "remove-answer-conditional-create", file: endpoint, cwd: "mcp", test: "tests/historyRosHttp.test.ts", pattern: "conditional create preserves",
    mutate: source => replaceOnce(source, "ifNoneExist: `identifier=${HISTORY_ANSWER_IDENTIFIER_SYSTEM}|${answer.id}&status:not=entered-in-error&status:not=cancelled`,", "ifNoneExist: undefined,") },
  { id: 5, name: "remove-completed-act-short-circuit", file: endpoint, cwd: "mcp", test: "tests/historyRosHttp.test.ts", pattern: "completed gesture replay",
    mutate: source => replaceOnce(source, "if (await findHistoryItemAct(staff.fhir, actIdentifier)) {", "if (false && await findHistoryItemAct(staff.fhir, actIdentifier)) {") },
  { id: 6, name: "restore-retired-summary-token", file: "mcp/src/clinical-graph/history-template-engine.ts", cwd: "mcp", test: "tests/historyRos.test.ts", pattern: "prior encounter acts",
    mutate: source => replaceOnce(source, 'summary: "{reviewed_systems}. {positives}",', 'summary: "{reviewed_systems}. {positives}. {method}",') },
  { id: 11, name: "remove-legacy-bulk-refusal", file: endpoint, cwd: "mcp", test: "tests/historyRosHttp.test.ts", pattern: "I2 every",
    mutate: source => replaceOnce(source, "return handleHistoryItemReviewRequest(deps, input);", "return historySearchResult(() => handleHistoryReview(deps, input));") },
  { id: 14, name: "remove-row-freeze", file: "ui/src/components/charting/HistoryRosSection.tsx", cwd: "ui", test: "tests/historyRosBrowser.test.tsx", pattern: "comprehensive burst",
    mutate: source => replaceOnce(source, "<fieldset disabled={sectionBusy}", "<fieldset disabled={false}") },
  { id: 15, name: "divergent-http-door", file: endpoint, cwd: "mcp", test: "tests/historyRosHttp.test.ts", pattern: "I2 every",
    mutate: source => replaceOnce(source, "return handleHistoryItemReviewRequest(deps, input);", "return historySearchResult(() => handleHistoryReview(deps, input));") },
  { id: 18, name: "restore-stale-target-fallback", file: hook, cwd: "ui", test: "tests/historyRosBrowser.test.tsx", pattern: "comprehensive burst",
    mutate: source => {
      source = replaceOnce(source, "  const owner = useRef<object>();", "  const owner = useRef<object>();\n  const bulkProgress = useRef<Target[]>();");
      return replaceOnce(source, "    if (!targets.length) return undefined;", "    targets = bulkProgress.current ?? targets;\n    bulkProgress.current = targets;\n    if (!targets.length) return undefined;");
    } },
  { id: 19, name: "unconditional-lease-release", file: hook, cwd: "ui", test: "tests/historyRosBrowser.test.tsx", pattern: "comprehensive burst",
    mutate: source => replaceOnce(source, "if (ownsRequest()) { release(); pending.current = false; setBusy(false); }", "release();\n      if (ownsRequest()) { pending.current = false; setBusy(false); }") },
  { id: 20, name: "client-derived-act-targets", file: endpoint, cwd: "mcp", test: "tests/historyRosHttp.test.ts", pattern: "conditional create preserves",
    mutate: source => replaceOnce(source, "recordHistoryItemReview(staff.fhir, reviewInput(liveNegativeTargets))", "recordHistoryItemReview(staff.fhir, reviewInput(request.targets))") },
];

function run(probe, phase) {
  const args = ["--import", "tsx", "--test", `--test-name-pattern=${probe.pattern}`, probe.test];
  const result = spawnSync(process.execPath, args, { cwd: resolve(root, probe.cwd), encoding: "utf8", timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  const output = result.stdout + result.stderr;
  writeFileSync(resolve(import.meta.dirname, `${probe.id}-${phase}.log`), output);
  const count = name => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1] ?? NaN);
  return { exit: result.status, signal: result.signal, passed: count("pass"), failed: count("fail"), skipped: count("skipped") };
}

const results = [];
for (const probe of cases) {
  const path = resolve(root, probe.file);
  const original = readFileSync(path, "utf8");
  let red;
  try {
    writeFileSync(path, probe.mutate(original));
    red = run(probe, "red");
  } finally {
    writeFileSync(path, original);
  }
  const restored = run(probe, "restored");
  results.push({ id: probe.id, name: probe.name, file: probe.file,
    command: `cd ${probe.cwd} && node --import tsx --test --test-name-pattern='${probe.pattern}' ${probe.test}`, red, restored });
  writeFileSync(resolve(import.meta.dirname, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results.at(-1)));
  assert.equal(red.exit, 1); assert.equal(red.failed, 1); assert.equal(red.passed, 0);
  assert.equal(restored.exit, 0); assert.equal(restored.failed, 0); assert.equal(restored.passed, 1);
}
