import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { ChargeItem, Encounter, Patient, Practitioner } from "@medplum/fhirtypes";
import { createAuthenticatedFhirClient } from "../../../mcp/tests/integration-helpers.js";
import { registerManualProcedureChargeRoutes } from "../../../mcp/src/clinical-graph/manual-procedure-charge-endpoint.js";
import { handleProtocolSignCleanupRequest } from "../../../mcp/src/clinical-graph/protocol-endpoint.js";
import { buildProcedureFeeDefinition } from "../../../mcp/src/clinical-graph/procedure-fee-schedule.js";
import { buildEncounterStatusPatchBundle } from "../../../ui/src/lib/encounter-bundles.js";

const baseUrl = "http://localhost:18103/";
const email = `synthetic-${randomBytes(6).toString("hex")}@odos.local`;
const password = `Synthetic-${randomBytes(24).toString("hex")}!`;
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.ok, true, `${path}: ${response.status}`);
  return response.json() as Promise<{ code?: string; login?: string }>;
}
let registration = await post("auth/newuser", { projectId: "new", firstName: "Synthetic", lastName: "Charge proof", email, password, remember: false, codeChallengeMethod: "S256", codeChallenge: challenge, recaptchaToken: "" });
if (!registration.code) registration = await post("auth/newproject", { login: registration.login, projectName: "Synthetic S3c2c1a charge proof" });
assert.ok(registration.code);
const tokenResponse = await fetch(`${baseUrl}oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: registration.code, code_verifier: verifier }) });
assert.equal(tokenResponse.ok, true);
const { fhir, accessToken } = await createAuthenticatedFhirClient({ baseUrl, email, password });
const practitioner = await fhir.create<Practitioner>({ resourceType: "Practitioner", name: [{ text: "Synthetic clinician" }] });
const patient = await fhir.create<Patient>({ resourceType: "Patient", name: [{ text: "Synthetic charge proof" }] });
for (const fee of [
  { procedureConceptKey: "gonioscopy", display: "Gonioscopy", billingCode: "SYNTHA", priceCents: 4500 },
  { procedureConceptKey: "fundus-photography", display: "Fundus photography", billingCode: "SYNTHB", priceCents: 7500 },
]) await fhir.create(buildProcedureFeeDefinition({ ...fee, active: true }));
const encounter = await fhir.create<Encounter>({ resourceType: "Encounter", status: "in-progress", class: { code: "AMB" }, subject: { reference: `Patient/${patient.id}` }, period: { start: new Date().toISOString() } });
const staff = { staffReference: `Practitioner/${practitioner.id}`, actorRole: "provider" as const, fhir };
const authenticate = async (header: string | undefined) => header === `Bearer ${accessToken}` ? staff : null;
const require = createRequire(new URL("../../../mcp/package.json", import.meta.url));
const express = require("express") as typeof import("../../../mcp/node_modules/@types/express/index.js");
const app = express();
app.use(express.json());
registerManualProcedureChargeRoutes(app, { async authenticateService() {}, authenticateRead: authenticate, authenticateWrite: authenticate });
app.post("/sign-cleanup", async (_req, res) => {
  const result = await handleProtocolSignCleanupRequest({ authenticate, feeScheduleFhir: fhir }, { authHeader: `Bearer ${accessToken}`, params: { encounterId: encounter.id } });
  res.status(result.status).json(result.body);
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const collection = `/clinical-graph/protocols/encounters/${encounter.id}/procedure-charges`;
async function request(path: string, method: string, body?: unknown) {
  const response = await fetch(url + path, { method, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  console.log(JSON.stringify({ method, status: response.status, body: data }));
  return { status: response.status, body: data };
}
try {
  const first = await request(collection, "POST", { procedureConceptKey: "gonioscopy" });
  assert.equal(first.status, 201);
  if (process.env.CAPTURE_PREVIEW === "1") {
    const { createServer } = await import("../../../ui/node_modules/vite/dist/node/index.js");
    const { chromium } = await import("../../../ui/node_modules/playwright-core/index.mjs");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const vite = await createServer({
      configFile: false, root, logLevel: "error",
      resolve: { alias: { react: `${root}ui/node_modules/react`, "react-dom": `${root}ui/node_modules/react-dom` } },
      esbuild: { jsx: "automatic", jsxImportSource: "react" },
      server: { host: "127.0.0.1", port: 25441, strictPort: true, proxy: { "/clinical-graph": { target: url, headers: { Authorization: `Bearer ${accessToken}` } } } },
    });
    await vite.listen();
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
      await page.goto(`http://127.0.0.1:25441/docs/build-log/followup-s3c2c1a-no-duplicate-charges/preview.html?encounter=${encounter.id}`, { waitUntil: "networkidle" });
      await page.getByLabel("Procedure to add").selectOption("gonioscopy");
      await page.getByRole("button", { name: "Add procedure" }).click();
      const error = page.getByTestId("procedure-charge-error");
      await error.waitFor();
      assert.equal(await error.textContent(), "Gonioscopy is already charged on this visit.");
      assert.equal(await page.getByTestId("procedure-charge-row").count(), 1);
      await page.screenshot({ path: `${root}docs/build-log/followup-s3c2c1a-no-duplicate-charges/duplicate-charge.png` });
      console.log("Browser preview: exact duplicate sentence visible; one unchanged procedure row.");
    } finally {
      await browser.close();
      await vite.close();
    }
  }

  const duplicate = await request(collection, "POST", { procedureConceptKey: "gonioscopy" });
  assert.deepEqual(duplicate, { status: 409, body: { code: "duplicate-charge", error: "Gonioscopy is already charged on this visit." } });
  assert.equal((await request(`${collection}/${encodeURIComponent(first.body.proposal.id)}`, "PATCH", { state: "removed" })).status, 200);
  assert.equal((await request(collection, "POST", { procedureConceptKey: "gonioscopy" })).status, 201);
  assert.equal((await request(collection, "POST", { procedureConceptKey: "fundus-photography" })).status, 201);
  const signed = await request("/sign-cleanup", "POST");
  assert.equal(signed.status, 200);
  assert.equal(signed.body.materialized, 2);
  const now = new Date().toISOString();
  const transaction = await fhir.executeTransaction(buildEncounterStatusPatchBundle({ encounterId: encounter.id!, patientId: patient.id!, recorded: now, operatorDisplay: "Synthetic S3c2c1a proof", ops: [{ op: "replace", path: "/status", value: "finished" }, { op: "add", path: "/period/end", value: now }] }));
  assert.ok(transaction.entry?.every(entry => entry.response?.status?.startsWith("2")));
  const storedEncounter = await fhir.read<Encounter>("Encounter", encounter.id!);
  assert.equal(storedEncounter.status, "finished");
  const bundle = await fhir.search<ChargeItem>("ChargeItem", { context: `Encounter/${encounter.id}` });
  const charges = (bundle.entry ?? []).flatMap(entry => entry.resource ? [entry.resource] : []);
  assert.equal(charges.length, 2);
  const amounts = charges.map(charge => charge.priceOverride?.value).sort((a, b) => a! - b!);
  assert.deepEqual(amounts, [45, 75]);
  assert.ok(charges.every(charge => charge.quantity?.value === 1 && charge.priceOverride?.currency === "USD"));
  console.log(JSON.stringify({ encounterStatus: storedEncounter.status, chargeItemCount: charges.length, amounts, totalUSD: amounts.reduce((sum, value) => sum! + value!, 0), units: [1, 1] }));
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
