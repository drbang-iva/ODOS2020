import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import express from "express";
import type { Encounter, Observation, Patient, Practitioner } from "@medplum/fhirtypes";
import { createAuthenticatedFhirClient } from "../tests/integration-helpers.js";
import { handleHpiDefinitionRequest, handleHistoryItemActsRequest, handleHpiRecordRequest, handleHpiCaptureRequest, type HpiEndpointDeps } from "../src/clinical-graph/hpi-endpoint.js";
import { registerHistoryItemRoutes } from "../src/clinical-graph/history-item-routes.js";
import { handleEncounterVoidRequest } from "../src/clinical-graph/encounter-void-endpoint.js";
import { handleExamOverviewRequest } from "../src/clinical-graph/exam-overview-endpoint.js";
import { buildHpiFindingDefinition } from "../src/clinical-graph/hpi-definition.js";
import { buildEncounterComplaintResource, FhirEncounterComplaintStore } from "../src/clinical-graph/encounter-complaint-store.js";
import { buildHistoryAnswerObservation, HISTORY_ITEM_REVIEW_CODE, HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM } from "../src/clinical-graph/history-answer-observation.js";
import { searchAll } from "../src/fhir-search.js";
const uiRoot = resolve(import.meta.dirname, "../../ui");
const requireUi = createRequire(resolve(uiRoot, "package.json"));
const { createServer } = await import(requireUi.resolve("vite"));
const { default: react } = await import(requireUi.resolve("@vitejs/plugin-react"));
const { chromium } = requireUi("playwright-core");
const baseUrl = process.env.MEDPLUM_BASE_URL!;
assert.ok(["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname));
const { fhir, accessToken } = await createAuthenticatedFhirClient({ baseUrl, email: process.env.MEDPLUM_ADMIN_EMAIL!, password: process.env.MEDPLUM_ADMIN_PASSWORD! });
const patient = await fhir.create<Patient>({ resourceType: "Patient", active: true, name: [{ text: "Synthetic ROS Surface", family: "Surface", given: ["Synthetic ROS"] }] });
const patientReference = `Patient/${patient.id}`;
const actor = await fhir.create<Practitioner>({ resourceType: "Practitioner", name: [{ text: "Synthetic ROS Reviewer" }] });
const staffReference = `Practitioner/${actor.id}`;
const now = new Date().toISOString();
const encounters = await Promise.all([0, 1, 2].map(() => fhir.create<Encounter>({ resourceType: "Encounter", status: "in-progress", class: { display: "Synthetic local proof" }, subject: { reference: patientReference }, period: { start: now } })));
for (const [index, encounter] of encounters.slice(0, 2).entries()) {
  const complaintId = randomUUID();
  await fhir.create(buildEncounterComplaintResource({ id: complaintId, patientId: patient.id!, encounterId: encounter.id!, ordinal: 1, freeTextLabel: "Synthetic glaucoma visit", templateKey: "glaucoma", eyeLocation: "OU", conditions: [], qualities: [], treatmentsTried: [], resolvedDx: [], additionalHistory: "", narrative: { mode: "automated" }, status: "active", provenanceHistory: [], provenance: { source: "manual", recordedAt: now, actorReference: staffReference } }));
  await fhir.create(buildHistoryAnswerObservation({ id: randomUUID(), complaintId, templateKey: "glaucoma", sectionId: "presentation", value: { kind: "selection", code: index ? "follow-up" : "new" } }, { patientReference, encounterReference: `Encounter/${encounter.id}`, recordedAt: now }));
}
const definition = buildHpiFindingDefinition({ source: "manual", recordedAt: now, actorReference: staffReference });
const deps: HpiEndpointDeps = { authenticate: async header => header === `Bearer ${accessToken}` ? { staffReference, actorRole: "provider", fhir } : null, findingDefinitions: () => [definition] };
const app = express(); app.use(express.json());
registerHistoryItemRoutes(app, async () => deps);
const route = (method: "get" | "post", path: string, handler: Function) => app[method](path, async (req, res) => { try { const result = await handler(deps, { authHeader: req.header("authorization"), body: req.body, params: req.params }); res.status(result.status).json(result.body); } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); } });
route("get", "/clinical-graph/hpi/definition", handleHpiDefinitionRequest);
route("get", "/clinical-graph/encounters/:encounterId/hpi", handleHpiRecordRequest);
route("post", "/clinical-graph/hpi", handleHpiCaptureRequest);
route("post", "/clinical-graph/encounters/:encounterId/void", handleEncounterVoidRequest);
route("get", "/clinical-graph/encounters/:encounterId/exam-overview", handleExamOverviewRequest);
app.get("/clinical-graph/encounters/:encounterId/complaints", async (req, res) => res.json({ complaints: await new FhirEncounterComplaintStore(fhir).listByEncounter(req.params.encounterId) }));
app.get("/clinical-graph/finding-definitions", (_req, res) => res.json({ definitions: [definition], canWrite: false }));
app.get("/desk/whoami", (_req, res) => res.json({ roles: ["provider"] }));
app.get("/clinical-graph/finding-section-groups", (_req, res) => res.json({ groups: [], visitTypeCategories: [], overrideGroupKeys: [], effectiveGroupKeys: [] }));
app.get("/clinical-graph/procedure-definitions", (_req, res) => res.json({ definitions: [] }));
app.get("/clinical-graph/eye-growth/visibility", (_req, res) => res.json({ visible: false }));
app.use("/clinical-graph", (_req, res) => res.status(404).json({ error: "Outside the History proof harness" }));
const capture = resolve(process.env.HISTORY_ROS_CAPTURE_DIR ?? resolve(import.meta.dirname, "../../docs/build-log/history-1d4b")); await mkdir(capture, {recursive:true});
process.chdir(uiRoot);
const server = await createServer({ configFile: false, root: uiRoot, plugins: [react(), { name: "history-live-proof", configureServer(vite: any) { vite.middlewares.use(app); } }],
  server: { host: "127.0.0.1", port: 15134, strictPort: true, proxy: { "/fhir": { target: baseUrl, changeOrigin: true } } } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", args: process.platform === "linux" ? ["--no-sandbox"] : [] });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(({ token }: { token: string }) => { sessionStorage.setItem("odos.session.v1", JSON.stringify({ accessToken: token, expiresAt: Date.now() + 3600000 })); }, { token: accessToken });
  const page = await context.newPage();
  for (const [index, encounter] of encounters.entries()) {
    await page.goto(`http://127.0.0.1:15134/clinic?patientId=${patient.id}&encounterId=${encounter.id}`);
    await page.getByRole("button", { name: "By structure", exact: true }).click();
    await page.locator("summary").filter({ hasText: "Chart another finding History" }).click();
    await page.getByRole("button", { name: /Chief Complaint & HPI/ }).click({ timeout: 15000 });
    const ros = page.getByTestId("history-review-of-systems"); await ros.waitFor({ timeout: 15000 });
    const fold = ros.getByRole("button", { name: /Review of Systems/ });
    assert.equal(await fold.getAttribute("aria-expanded"), index === 1 ? "false" : "true");
    if (index === 1) { assert.match(await ros.innerText(), /Complaint-directed/); await ros.screenshot({ path: resolve(capture, "follow-up.png") }); console.log("APP ROUTE + MEDPLUM: persisted follow-up presentation self-folds with Complaint-directed header"); continue; }
    if (index === 2) {
      const clear = page.getByRole("button", { name: "Clear History", exact: true });
      assert.equal(await clear.count(), 0);
      const row = ros.locator('[data-ros-item="headache"]');
      await row.getByRole("checkbox").click();
      await page.waitForFunction(() => (document.querySelector('[data-ros-item="headache"] input') as HTMLInputElement)?.checked);
      assert.equal(await clear.count(), 1);
      await row.getByRole("checkbox").click();
      await row.getByRole("button", { name: /Undo/ }).waitFor();
      await clear.click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Clear History", exact: true }).click();
      await row.getByRole("button", { name: /Undo/ }).waitFor({ state: "detached" });
      assert.equal(await clear.count(), 0);
      const record = await handleHistoryItemActsRequest(deps, { authHeader: `Bearer ${accessToken}`, params: { encounterId: encounter.id } });
      assert.equal(record.status, 200); assert.deepEqual((record.body as any).reviews, []); assert.deepEqual((record.body as any).retractions, []);
      const persisted = await searchAll<Observation>(fhir, "Observation", { encounter: `Encounter/${encounter.id}` });
      assert.equal(persisted.filter(row => row.status === "entered-in-error").length, 2);
      console.log("APP ROUTE + MEDPLUM: review-only History Clear becomes available; confirmed Clear voids both review and retraction, retaining both records");
      continue;
    }
    const statuses: number[] = []; page.on("response", response => { if (response.url().endsWith("/clinical-graph/hpi")) statuses.push(response.status()); });
    await ros.getByRole("button", { name: /^No: / }).evaluateAll(buttons => buttons.slice(0, 10).forEach(button => (button as HTMLButtonElement).click()));
    const encounterReference = `Encounter/${encounter.id}`;
    const read = async () => { const result = await handleHpiRecordRequest(deps, { authHeader: `Bearer ${accessToken}`, params: { encounterId: encounter.id } }); assert.equal(result.status, 200); return result.body as any; };
    for (let count = 0; count < 60 && (await read()).answers.filter((a: any) => a.templateKey === "review-of-systems").length !== 10; count++) await new Promise(r => setTimeout(r, 500));
    assert.equal((await read()).answers.filter((a: any) => a.templateKey === "review-of-systems").length, 10);
    assert.equal(statuses.includes(413), false);
    const reviews = () => searchAll<Observation>(fhir, "Observation", { encounter: encounterReference, code: `${HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM}|${HISTORY_ITEM_REVIEW_CODE}` });
    assert.equal((await reviews()).length, 0);
    const row = ros.locator('[data-ros-item="headache"]'); await row.getByRole("checkbox").click();
    await page.waitForFunction(() => (document.querySelector('[data-ros-item="headache"] input') as HTMLInputElement)?.checked);
    const original = (await reviews())[0]; assert.ok(original); assert.equal((await reviews()).length, 1);
    await row.getByRole("checkbox").click(); await row.getByRole("button", { name: /Undo/ }).waitFor();
    assert.match(await row.innerText(), /Never asked/); assert.deepEqual(await fhir.read("Observation", original.id!), original);
    await row.getByRole("button", { name: /Undo/ }).click(); await page.waitForFunction(() => (document.querySelector('[data-ros-item="headache"] input') as HTMLInputElement)?.checked);
    assert.deepEqual(await fhir.read("Observation", original.id!), original);
    await ros.locator("header").scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(capture, "comprehensive.png") });
    const overview = await handleExamOverviewRequest(deps, { authHeader: `Bearer ${accessToken}`, params: { encounterId: encounter.id } }); assert.equal(overview.status, 200); assert.match((overview.body as any).historySummary, /Eyes reviewed/);
    console.log("APP ROUTE + MEDPLUM: comprehensive open, 14 systems, burst 10/10, zero answer-side acts; one review; immutable Unmark/Undo; overview Eyes reviewed; no 413");
  }
} catch (error) {
  const pages = browser.contexts().flatMap(c => c.pages());
  if (pages[0]) { console.log((await pages[0].locator("body").innerText()).slice(0, 9000)); await pages[0].screenshot({path: "/tmp/history4b-live-error.png"}); }
  throw error;
} finally { await browser.close(); await server.close(); }
console.log("PASS. Actual App /clinic route and real local synthetic Medplum. Harness supplies provider identity and limited ancillary catalog reads; this is not a constrained-role AccessPolicy verdict.");
