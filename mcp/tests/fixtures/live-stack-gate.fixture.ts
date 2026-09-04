import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { test } from "node:test";
import { requireMedplumAdmin } from "../integration-helpers.js";

if (process.env.ODOS_RUNNER_BOOTSTRAP_FIXTURE === "1") {
  test("bootstrap project reaches the remaining test process", () => {
    if (!process.env.MEDPLUM_PROJECT_ID) {
      assert.ok(process.env.GITHUB_ENV);
      appendFileSync(process.env.GITHUB_ENV, "MEDPLUM_PROJECT_ID=runner-project\n");
      return;
    }
    assert.equal(process.env.MEDPLUM_PROJECT_ID, "runner-project");
  });
}

for (const surface of ["v05a-authz", "clinicalWriteAuthzLive"]) {
  test(`${surface} fixture`, (t) => {
    const credentials = requireMedplumAdmin(t, surface);
    if (!credentials) {
      return;
    }

    assert.ok(credentials.email);
    assert.ok(credentials.password);
  });
}
