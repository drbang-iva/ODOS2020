import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { CodeSystem, ValueSet } from "@medplum/fhirtypes";
import {
  OSOD_EPISODE_OF_CARE_TYPE_CODE_SYSTEM,
  OSOD_EPISODE_OF_CARE_TYPE_VALUE_SET,
} from "../src/fhir/episodeOfCare.js";
import {
  createAuthenticatedFhirClient,
  loadRepoEnv,
} from "./integration-helpers.js";

const execFileAsync = promisify(execFile);

test("profile installer idempotently installs OSOD EpisodeOfCare terminology", { timeout: 120_000 }, async (t) => {
  loadRepoEnv();

  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;

  if (!email || !password) {
    t.skip("MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for Medplum integration tests.");
    return;
  }

  const repoRoot = resolve(process.cwd(), "..");
  const install = await execFileAsync("npm", ["run", "install-profiles", "--silent"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MEDPLUM_BASE_URL: baseUrl,
      MEDPLUM_ADMIN_EMAIL: email,
      MEDPLUM_ADMIN_PASSWORD: password,
    },
  });
  assert.equal(install.stderr, "");

  const { fhir } = await createAuthenticatedFhirClient({ baseUrl, email, password });

  await t.test("CodeSystem is retrievable by canonical URL", async () => {
    const bundle = await fhir.search<CodeSystem>("CodeSystem", {
      url: OSOD_EPISODE_OF_CARE_TYPE_CODE_SYSTEM,
      _count: "1",
    });
    const codeSystem = bundle.entry?.[0]?.resource;

    assert.equal(codeSystem?.url, OSOD_EPISODE_OF_CARE_TYPE_CODE_SYSTEM);
    assert.deepEqual(
      codeSystem?.concept?.map((concept) => concept.code),
      ["myopia-management", "glaucoma", "dry-eye", "diabetic-eye-care"],
    );
  });

  await t.test("ValueSet is retrievable by canonical URL", async () => {
    const bundle = await fhir.search<ValueSet>("ValueSet", {
      url: OSOD_EPISODE_OF_CARE_TYPE_VALUE_SET,
      _count: "1",
    });
    const valueSet = bundle.entry?.[0]?.resource;

    assert.equal(valueSet?.url, OSOD_EPISODE_OF_CARE_TYPE_VALUE_SET);
    assert.equal(
      valueSet?.compose?.include?.[0]?.system,
      OSOD_EPISODE_OF_CARE_TYPE_CODE_SYSTEM,
    );
  });

  await t.test("local terminology artifacts stay in sync with canonical URLs", async () => {
    const codeSystem = JSON.parse(
      await readFile(
        resolve(repoRoot, "data/terminology/episode-of-care-type-codesystem.json"),
        "utf8",
      ),
    ) as CodeSystem;
    const valueSet = JSON.parse(
      await readFile(
        resolve(repoRoot, "data/terminology/episode-of-care-type-valueset.json"),
        "utf8",
      ),
    ) as ValueSet;

    assert.equal(codeSystem.url, OSOD_EPISODE_OF_CARE_TYPE_CODE_SYSTEM);
    assert.equal(valueSet.url, OSOD_EPISODE_OF_CARE_TYPE_VALUE_SET);
  });
});
