import assert from "node:assert/strict";
import { test } from "node:test";
import { requireMedplumAdmin } from "../integration-helpers.js";

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
