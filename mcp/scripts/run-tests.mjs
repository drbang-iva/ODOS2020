import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mcpRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultFiles = [
  "src/__tests__/**/*.test.ts",
  "tests/**/*.test.ts",
  "../tests/boundaries/**/*.test.ts",
  "../tests/observation-status-machine/**/*.test.ts",
  "../tests/setup-wizard/**/*.test.ts",
  "../tests/preflight/**/*.test.ts",
  "../tests/smart/**/*.test.ts",
  "../tests/cds/**/*.test.ts",
  "../tests/agentops/**/*.test.ts",
  "../tests/bulk-data/**/*.test.ts",
  "../tests/mandate-8/**/*.test.ts",
];

const { files, uiRoot } = parseArguments(process.argv.slice(2));
if (!uiDependenciesInstalled(uiRoot)) {
  process.stderr.write("MCP TEST HARNESS ERROR — ui deps not installed; run npm install in ui/\n");
  process.exit(1);
}

const recordDirectory = mkdtempSync(join(tmpdir(), "odos-mcp-live-skips-"));
const recordPath = join(recordDirectory, "skips.jsonl");

try {
  const childExitCode = await runTests(files.length > 0 ? files : defaultFiles, recordPath);
  const skips = readSkipRecords(recordPath);
  if (skips.length > 0) {
    const surfaces = [...new Set(skips.map((skip) => skip.surface))];
    const optedOut = process.env.ODOS_ALLOW_UNGATED_MCP === "1";
    const optOutText = optedOut
      ? " ODOS_ALLOW_UNGATED_MCP=1 acknowledged; exit code reflects executed tests only."
      : "";
    process.stdout.write(
      `⚠️  LIVE STACK NOT CONFIGURED — ${skips.length} tests skipped, including live authorization enforcement (${surfaces.join(", ")}). This run does NOT gate authz. Set MEDPLUM_ADMIN_EMAIL/PASSWORD to run them.${optOutText}\n`,
    );
    process.exitCode = optedOut ? childExitCode : 1;
  } else {
    process.exitCode = childExitCode;
  }
} finally {
  rmSync(recordDirectory, { recursive: true, force: true });
}

function parseArguments(args) {
  const files = [];
  let uiRoot = resolve(mcpRoot, "../ui");
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--ui-root") {
      uiRoot = resolve(args[index + 1]);
      index += 1;
    } else {
      files.push(args[index]);
    }
  }
  return { files, uiRoot };
}

function uiDependenciesInstalled(uiRoot) {
  const result = spawnSync("npm", ["ls", "--prefix", uiRoot, "--depth=0", "--json"], {
    cwd: mcpRoot,
    encoding: "utf8",
  });
  return result.status === 0;
}

function runTests(files, recordPath) {
  return new Promise((resolveExitCode, reject) => {
    const childEnv = { ...process.env, ODOS_MCP_LIVE_SKIP_RECORD: recordPath };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=1",
      ...files,
    ], {
      cwd: mcpRoot,
      env: childEnv,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveExitCode(code ?? 1));
  });
}

function readSkipRecords(recordPath) {
  try {
    return readFileSync(recordPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
