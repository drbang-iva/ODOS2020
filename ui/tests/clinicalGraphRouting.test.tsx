import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AutoRefractionSection,
  buildAutoRefractionRequestBody,
} from "../src/components/charting/AutoRefractionSection";
import { authHeaders } from "../src/lib/clinical-graph-client";
import { fhir, SESSION_STORAGE_KEY } from "../src/lib/fhir";

const UI_ROOT = join(process.cwd(), "src");

test("Vite proxies relative clinical-graph requests to the MCP server", () => {
  const config = readFileSync(join(process.cwd(), "vite.config.ts"), "utf8");
  assert.match(config, /const mcpTarget = env\.VITE_ODOS_MCP_BASE_URL \|\| "http:\/\/localhost:3333"/);
  assert.match(config, /"\/clinical-graph": \{ target: mcpTarget, changeOrigin: true \}/);
  assert.match(config, /"\/weno": \{ target: mcpTarget, changeOrigin: true \}/);
});

test("clinical-graph requests share the literal Vite route and Medplum authorization helpers", () => {
  const clientPath = join(UI_ROOT, "lib", "clinical-graph-client.ts");
  const client = readFileSync(clientPath, "utf8");
  assert.match(client, /import\.meta\.env\?\.VITE_ODOS_MCP_BASE_URL/);
  assert.match(client, /fhir\.authHeader\(\)/);

  const callers = sourceFiles(UI_ROOT)
    .filter((path) => path !== clientPath)
    .map((path) => ({ path, source: readFileSync(path, "utf8") }))
    .filter(({ source }) => source.includes("clinicalGraphApiBase()"));

  assert.equal(callers.length, 25);
  for (const { path, source } of callers) {
    assert.match(source, /from "(?:\.\/|\.\.\/(?:\.\.\/)?lib\/)clinical-graph-client";/, path);
    assert.doesNotMatch(source, /function (?:authHeaders|clinicalGraphApiBase)\(/, path);
  }
});

test("authHeaders returns the live Medplum client authorization", () => {
  const original = fhir.authHeader;
  fhir.authHeader = () => "Bearer scoped-clinician";
  try {
    assert.deepEqual(authHeaders(), { Authorization: "Bearer scoped-clinician" });
  } finally {
    fhir.authHeader = original;
  }
});

test("soft and specialty contact lens definition and save requests use shared authorization", () => {
  assertAuthenticatedDefinitionAndSave(
    join(UI_ROOT, "components", "charting", "SoftContactLensSection.tsx"),
    "soft",
  );
  assertAuthenticatedDefinitionAndSave(
    join(UI_ROOT, "components", "charting", "SpecialtyContactLensSection.tsx"),
    "specialty",
  );
});

test("Auto-Refraction renders directly typeable binocular PD fields and saves them at request top level", () => {
  const html = renderToStaticMarkup(
    <AutoRefractionSection
      patientReference="Patient/p1"
      encounterReference="Encounter/e1"
      onSaved={() => undefined}
    />,
  );
  assert.match(html, /Binocular PD \(OU\)/);
  assert.match(html, /type="number"[^>]*min="35"[^>]*max="90"[^>]*step="0\.01"[^>]*aria-label="Binocular PD distance"/);
  assert.match(html, /type="number"[^>]*min="35"[^>]*max="90"[^>]*step="0\.01"[^>]*aria-label="Binocular PD near"/);

  const body = buildAutoRefractionRequestBody({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    sourceType: "manual",
    remarks: "  reliable fixation  ",
    binocularPdDistance: "63.50",
    binocularPdNear: "60.25",
    eyes: {
      OD: { ...emptyAutoEye(), sphere: "-1" },
      OS: emptyAutoEye(),
    },
  });
  assert.equal(body.binocularPdDistance, 63.5);
  assert.equal(body.binocularPdNear, 60.25);
  assert.equal(body.remarks, "reliable fixation");
  assert.deepEqual(body.eyes.OD, { sphere: -1 });
  assert.equal("binocularPdDistance" in (body.eyes.OD ?? {}), false);
  assert.equal("binocularPdNear" in (body.eyes.OD ?? {}), false);

  for (const partial of ["-", "1e", "."]) {
    const partialBody = buildAutoRefractionRequestBody({
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      sourceType: "manual",
      remarks: "",
      binocularPdDistance: partial,
      binocularPdNear: partial,
      eyes: { OD: emptyAutoEye(), OS: emptyAutoEye() },
    });
    assert.equal("binocularPdDistance" in partialBody, false);
    assert.equal("binocularPdNear" in partialBody, false);
    assert.doesNotMatch(JSON.stringify(partialBody), /null/);
  }
});

test("no UI source references the obsolete odos_access_token key", () => {
  for (const path of sourceFiles(UI_ROOT)) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /odos_access_token/, path);
  }
});

test("WENO searches use the authenticated shared client boundary", async () => {
  const prescription = readFileSync(
    join(UI_ROOT, "components", "charting", "PrescriptionSection.tsx"),
    "utf8",
  );
  assert.match(prescription, /fhir\.searchWenoFormulary\(clinicalGraphApiBase\(\), query, signal\)/);
  assert.match(prescription, /fhir\.searchWenoDirectory\(clinicalGraphApiBase\(\), input, signal\)/);
  assert.doesNotMatch(prescription, /fetch\([^)]*\/weno\//);

  const storage = memoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    accessToken: "weno-test-token",
    expiresAt: Date.now() + 60_000,
  }));
  assert.equal(fhir.rehydrateSession(storage), true);
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: input.toString(),
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await fhir.searchWenoFormulary("http://localhost:3333", "lata");
    await fhir.searchWenoDirectory("http://localhost:3333", {
      state: "SC",
      place: "29646",
      searchType: "local-retail",
    });
    assert.deepEqual(calls, [
      {
        url: "http://localhost:3333/weno/drugs/search?q=lata",
        authorization: "Bearer weno-test-token",
      },
      {
        url: "http://localhost:3333/weno/pharmacies/search?state=SC&searchType=local-retail&all=true&zip=29646",
        authorization: "Bearer weno-test-token",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    fhir.logout(storage);
  }
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function assertAuthenticatedDefinitionAndSave(path: string, kind: "soft" | "specialty"): void {
  const source = readFileSync(path, "utf8");
  assert.match(source, /import \{ authHeaders, clinicalGraphApiBase \} from "\.\.\/\.\.\/lib\/clinical-graph-client";/);
  assert.match(
    source,
    new RegExp(`contact-lens/${kind}/definition[\\s\\S]{0,120}headers: authHeaders\\(\\)`),
    `${kind} definition request`,
  );
  assert.match(
    source,
    new RegExp(`contact-lens/${kind}\`[\\s\\S]{0,160}method: "POST"[\\s\\S]{0,120}headers: \\{ \\.\\.\\.authHeaders\\(\\)`),
    `${kind} save request`,
  );
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function emptyAutoEye() {
  return { sphere: "", cylinder: "", axis: "", flatK: "", flatAxis: "", steepK: "", steepAxis: "" };
}
