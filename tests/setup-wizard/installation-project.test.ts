import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertObservedProjectMatchesTarget,
  formatInstallationProjectTarget,
  resolveConfiguredInstallationProject,
  resolveInstallationProject,
} from "../../scripts/installation-project.ts";

function fixture(): { directory: string; statePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "odos-install-project-"));
  const statePath = join(directory, ".odos-setup-state.json");
  return { directory, statePath };
}

test("installation state is canonical and reports visible provenance", () => {
  const { directory, statePath } = fixture();
  try {
    writeFileSync(statePath, JSON.stringify({ version: "v0.5d", projectId: "practice-1" }));
    const target = resolveInstallationProject({
      args: [],
      env: { MEDPLUM_PROJECT_ID: "practice-1", ODOS_SETUP_STATE_PATH: statePath },
      workingDirectory: directory,
    });
    assert.deepEqual(target, {
      projectId: "practice-1",
      source: "installation-state",
      statePath,
    });
    assert.equal(
      formatInstallationProjectTarget(target),
      "Target: Project/practice-1 (source: installation-state)",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MEDPLUM_PROJECT_ID is a fallback only when no installation manifest exists", () => {
  const { directory, statePath } = fixture();
  try {
    assert.deepEqual(resolveInstallationProject({
      args: [],
      env: { MEDPLUM_PROJECT_ID: "practice-env", ODOS_SETUP_STATE_PATH: statePath },
      workingDirectory: directory,
    }), {
      projectId: "practice-env",
      source: "MEDPLUM_PROJECT_ID",
      statePath,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configuration resolution can remain unresolved for authenticated-session fallback", () => {
  const { directory, statePath } = fixture();
  try {
    assert.equal(resolveConfiguredInstallationProject({
      args: [],
      env: { ODOS_SETUP_STATE_PATH: statePath },
      workingDirectory: directory,
    }), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("disagreeing installation and environment project IDs fail closed", () => {
  const { directory, statePath } = fixture();
  try {
    writeFileSync(statePath, JSON.stringify({ projectId: "practice-install" }));
    assert.throws(
      () => resolveInstallationProject({
        args: [],
        env: { MEDPLUM_PROJECT_ID: "practice-env", ODOS_SETUP_STATE_PATH: statePath },
        workingDirectory: directory,
      }),
      /installation-state.*practice-install.*MEDPLUM_PROJECT_ID.*practice-env/i,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicit foreign project requires the acknowledgement flag", () => {
  const { directory, statePath } = fixture();
  try {
    writeFileSync(statePath, JSON.stringify({ projectId: "practice-install" }));
    assert.throws(
      () => resolveInstallationProject({
        args: ["--project", "practice-foreign"],
        env: { ODOS_SETUP_STATE_PATH: statePath },
        workingDirectory: directory,
      }),
      /--allow-foreign-project/,
    );
    assert.equal(resolveInstallationProject({
      args: ["--project", "practice-foreign", "--allow-foreign-project"],
      env: { ODOS_SETUP_STATE_PATH: statePath },
      workingDirectory: directory,
    }).source, "--project");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("derived operator credentials and migration state must agree with installation state", () => {
  const { directory, statePath } = fixture();
  try {
    writeFileSync(statePath, JSON.stringify({ projectId: "practice-install" }));
    mkdirSync(join(directory, ".odos"));
    writeFileSync(join(directory, ".odos", "operator.env"), "ODOS_OPERATOR_PROJECT_ID=practice-old\n");
    writeFileSync(join(directory, ".odos", "migration-importer-state.json"), JSON.stringify({ practiceProjectId: "practice-old" }));
    assert.throws(
      () => resolveInstallationProject({
        args: [],
        env: { ODOS_SETUP_STATE_PATH: statePath },
        workingDirectory: directory,
      }),
      /operator credentials.*practice-old.*installation.*practice-install/i,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("authenticated project mismatch fails before a consumer can mutate", () => {
  assert.throws(
    () => assertObservedProjectMatchesTarget("practice-configured", "practice-session", "authenticated service project"),
    /authenticated service project.*practice-session.*configured.*practice-configured/i,
  );
  assert.doesNotThrow(
    () => assertObservedProjectMatchesTarget("practice-configured", "practice-configured", "authenticated service project"),
  );
});
