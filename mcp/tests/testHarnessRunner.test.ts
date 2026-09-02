import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";

const MCP_ROOT = process.cwd();
const RUNNER = resolve(MCP_ROOT, "scripts/run-tests.mjs");
const FIXTURE = resolve(MCP_ROOT, "tests/fixtures/live-stack-gate.fixture.ts");
const tempDirectories: string[] = [];

after(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("credential-gated skips produce a final named authz banner and non-zero exit", () => {
  const result = runFixture({
    MEDPLUM_ADMIN_EMAIL: "",
    MEDPLUM_ADMIN_PASSWORD: "",
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /# tests 2\n/);
  assert.match(result.stdout, /# fail 0\n/);
  assert.match(result.stdout, /# skipped 2\n/);
  assert.match(
    result.stdout,
    /⚠️  LIVE STACK NOT CONFIGURED — 2 tests skipped, including live authorization enforcement \(v05a-authz, clinicalWriteAuthzLive\)\. This run does NOT gate authz\. Set MEDPLUM_ADMIN_EMAIL\/PASSWORD to run them\.\n$/,
  );
});

test("deliberate ungated opt-out preserves the banner but returns the test exit code", () => {
  const result = runFixture({
    MEDPLUM_ADMIN_EMAIL: "",
    MEDPLUM_ADMIN_PASSWORD: "",
    ODOS_ALLOW_UNGATED_MCP: "1",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LIVE STACK NOT CONFIGURED — 2 tests skipped/);
  assert.match(result.stdout, /ODOS_ALLOW_UNGATED_MCP=1 acknowledged/);
});

test("configured credentials run without the live-stack banner", () => {
  const result = runFixture({
    MEDPLUM_ADMIN_EMAIL: "admin@example.test",
    MEDPLUM_ADMIN_PASSWORD: "not-a-real-password",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# tests 2\n/);
  assert.match(result.stdout, /# pass 2\n/);
  assert.match(result.stdout, /# skipped 0\n/);
  assert.doesNotMatch(result.stdout, /LIVE STACK NOT CONFIGURED/);
});

test("missing UI dependencies fail with the three-level-install instruction", () => {
  const uiRoot = makeMissingUiInstall();
  const result = runFixture({
    MEDPLUM_ADMIN_EMAIL: "admin@example.test",
    MEDPLUM_ADMIN_PASSWORD: "not-a-real-password",
  }, ["--ui-root", uiRoot]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ui deps not installed; run npm install in ui\//);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ERR_MODULE_NOT_FOUND/);
});

test("contract bootstrap project export is a no-op outside GitHub Actions", async () => {
  const helpers = await import("./integration-helpers.js");
  const exportProjectId = (helpers as unknown as Record<string, unknown>)
    .exportContractProjectIdForGitHubActions;

  assert.ok(typeof exportProjectId === "function");
  assert.doesNotThrow(() => exportProjectId("practice-project", {}));
});

test("contract bootstrap exports the observed project id for later GitHub Actions steps", async () => {
  const helpers = await import("./integration-helpers.js");
  const exportProjectId = (helpers as unknown as Record<string, unknown>)
    .exportContractProjectIdForGitHubActions;
  const directory = mkdtempSync(resolve(tmpdir(), "odos-github-env-"));
  const environmentPath = resolve(directory, "github-env");
  tempDirectories.push(directory);

  assert.ok(typeof exportProjectId === "function");
  exportProjectId("practice-project", { GITHUB_ENV: environmentPath });
  assert.equal(readFileSync(environmentPath, "utf8"), "MEDPLUM_PROJECT_ID=practice-project\n");
});

function runFixture(
  env: Record<string, string>,
  runnerArguments: string[] = [],
): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } {
  return spawnSync(process.execPath, [RUNNER, ...runnerArguments, FIXTURE], {
    cwd: MCP_ROOT,
    env: {
      ...process.env,
      MEDPLUM_ADMIN_EMAIL: "",
      MEDPLUM_ADMIN_PASSWORD: "",
      ODOS_ALLOW_UNGATED_MCP: "",
      ...env,
    },
    encoding: "utf8",
  });
}

function makeMissingUiInstall(): string {
  const root = mkdtempSync(resolve(tmpdir(), "odos-ui-missing-"));
  tempDirectories.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, "package.json"), JSON.stringify({
    name: "missing-ui-install",
    private: true,
    dependencies: { zustand: "^4.5.5" },
  }));
  return root;
}
