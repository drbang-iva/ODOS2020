import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Patient } from "@medplum/fhirtypes";
import { createAuthenticatedFhirClient } from "../../../mcp/tests/integration-helpers.js";
import { TEST_FHIR_AUDIT_RECORDER } from "../../../mcp/tests/fhirAuditTestStub.js";
import { createCommsDispatch } from "../../../mcp/src/comms/comms-config.js";
import { registerCommsApiRoutes } from "../../../mcp/src/comms/comms-api.js";
import { effectiveCommsPreferences, ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, ODOS_TEXTABLE_NUMBER_EXTENSION_URL, resolveSmsHistoryNumber, resolveSmsNumber, resolveVoiceNumber } from "../../../mcp/src/comms/suppression-gate.js";
import { NUMBERS, TELECOM_NOW, telecomFixture } from "../../../ui/tests/fixtures/patient-telecom.js";

const root = process.cwd();
const uiRoot = resolve(root, "ui");
const baseRoot = realpathSync(resolve(process.env.PHONE_BASE_ROOT ?? "/tmp/odos-phone-textable-base"));
const output = resolve(process.env.PHONE_CAPTURE_DIR ?? "docs/build-log/item1bii-phone-form/browser");
mkdirSync(output, { recursive: true });
const privateFile = resolve(process.env.PHONE_STACK_DIR ?? ".odos/phone-proof", "credentials.json");
const credentials = JSON.parse(readFileSync(privateFile, "utf8"));
assert.equal(new URL(credentials.baseUrl).hostname, "127.0.0.1");
const { fhir, accessToken } = await createAuthenticatedFhirClient(credentials);
const actor = await fhir.create({ resourceType: "Practitioner", name: [{ text: "Synthetic Phone Reviewer" }] });
const requireUi = createRequire(resolve(uiRoot, "package.json"));
const requireMcp = createRequire(resolve(root, "mcp/package.json"));
const express = requireMcp("express");
const { chromium } = requireUi("playwright-core");
const { createServer } = await import(requireUi.resolve("vite"));
const { default: react } = await import(requireUi.resolve("@vitejs/plugin-react"));
const queries: string[] = [];
const dispatch = createCommsDispatch([{ provider: "ghl", config: { locationId: "synthetic", accessToken: "synthetic-token" } }], {
  now: () => new Date(TELECOM_NOW),
  fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/contacts/search") {
      const query = JSON.parse(String(init?.body)).query;
      queries.push(query);
      return Response.json(query === NUMBERS.H ? { contacts: [{ id: "H-contact", phone: NUMBERS.H }], total: 1 } : { contacts: [], total: 0 });
    }
    assert.equal(url.pathname, "/conversations/search");
    assert.equal(url.searchParams.get("contactId"), "H-contact");
    return Response.json({ conversations: [{ id: "H-thread", contactId: "H-contact", phone: NUMBERS.H, unreadCount: 1 }] });
  },
});

async function serve(directory: string, port: number) {
  const app = express();
  app.use(express.json());
  app.get("/desk/whoami", (_req: any, res: any) => res.json({ roles: ["provider"] }));
  registerCommsApiRoutes(app, {
    authenticateService: async () => {},
    authenticate: async header => header === `Bearer ${accessToken}` ? { staffReference: `Practitioner/${actor.id}`, actorRole: "provider", roles: ["provider"], fhir } : null,
    fhir, dispatch, educationCatalog: {} as never, trackedLinkStore: {} as never,
    publicBaseUrl: `http://127.0.0.1:${port}`, practiceName: "Synthetic Phone Proof", audit: TEST_FHIR_AUDIT_RECORDER,
    now: () => TELECOM_NOW,
  });
  app.use("/clinical-graph", (_req: any, res: any) => res.status(404).json({ error: "Ancillary clinical routes are outside this phone proof." }));
  const { default: tailwindConfig } = await import(resolve(directory, "tailwind.config.js"));
  const server = await createServer({ configFile: false, root: directory,
    css: { postcss: { plugins: [requireUi("tailwindcss")({ ...tailwindConfig, content: [resolve(directory, "index.html"), resolve(directory, "src/**/*.{ts,tsx}")] }), requireUi("autoprefixer")()] } },
    plugins: [react(), { name: "phone-proof", configureServer(vite: any) { vite.middlewares.use(app); } }],
    server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [root, baseRoot] }, proxy: { "/fhir": { target: credentials.baseUrl, changeOrigin: true } } } });
  await server.listen();
  return server;
}

const patientInput = telecomFixture("IMPORTED3");
delete patientInput.id; delete patientInput.meta;
let patient = await fhir.create<Patient>(patientInput);
const beforeServer = await serve(resolve(baseRoot, "ui"), 15140);
const afterServer = await serve(uiRoot, 15139);
const browser = await chromium.launch({ channel: "chrome" });
const results: any[] = [];
const pageErrors: string[] = [];
const writes: Array<{ path: string; ifMatch: string | undefined; body: Patient }> = [];
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ token }: { token: string }) => sessionStorage.setItem("odos.session.v1", JSON.stringify({ accessToken: token, expiresAt: Date.now() + 3600000 })), { token: accessToken });
  const page = await context.newPage();
  page.on("pageerror", (error: Error) => pageErrors.push(error.message));
  page.on("request", (request: any) => {
    if (request.method() === "PUT" && new URL(request.url()).pathname.startsWith("/fhir/R4/Patient/")) {
      writes.push({ path: new URL(request.url()).pathname, ifMatch: request.headers()["if-match"], body: JSON.parse(request.postData()) });
    }
  });
  const dialog = page.getByRole("dialog", { name: "Edit demographics", exact: true });
  const contact = dialog.getByRole("group", { name: "Contact information", exact: true });
  const open = async (port = 15139) => {
    await page.goto(`http://127.0.0.1:${port}/clinic?patientId=${patient.id}`);
    await page.getByRole("button", { name: "Edit demographics", exact: true }).click();
    await contact.waitFor();
    await dialog.getByRole("table", { name: "Communication preferences grid", exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  const capture = async (name: string) => {
    await dialog.evaluate((element: HTMLElement) => { element.scrollTop = 0; });
    await page.screenshot({ path: resolve(output, `${name}.png`), animations: "disabled" });
  };
  const save = async (name: string) => {
    const before = patient;
    const count = writes.length;
    const response = page.waitForResponse((res: any) => res.request().method() === "PUT" && res.url().includes(`/fhir/R4/Patient/${patient.id}`));
    await dialog.getByRole("button", { name: "Save demographics", exact: true }).click();
    assert.equal((await response).status(), 200);
    await dialog.waitFor({ state: "hidden" });
    assert.equal(writes.length, count + 1);
    assert.equal(writes.at(-1)!.ifMatch, `W/"${before.meta!.versionId}"`);
    patient = await fhir.read<Patient>("Patient", patient.id!);
    assert.deepEqual(patient.telecom ?? [], writes.at(-1)!.body.telecom ?? []);
    assert.deepEqual(patient.extension, writes.at(-1)!.body.extension);
    const unrelated = (p: Patient) => p.extension?.filter(e => e.url !== ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL);
    assert.deepEqual(unrelated(patient), unrelated(before));
    assert.deepEqual(effectiveCommsPreferences(patient, {}).appointment.sms, effectiveCommsPreferences(before, {}).appointment.sms);
    results.push({ state: name, responseStatus: 200, serializedPut: writes.at(-1), persisted: patient });
    await open();
  };
  const history = async (expected: string[]) => {
    const response = await page.evaluate(async ({ token, reference }: { token: string; reference: string }) => {
      const res = await fetch(`/communications/conversations?provider=ghl&patientReference=${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${token}` } });
      return { status: res.status, body: await res.json() };
    }, { token: accessToken, reference: `Patient/${patient.id}` });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.conversations.map((thread: any) => thread.id), expected);
    assert.deepEqual(response.body.providerErrors, []);
    Object.assign(results.at(-1), { conversationResponse: response, lastProviderQuery: queries.at(-1), sms: resolveSmsNumber(patient, new Date(TELECOM_NOW)) ?? null, voice: resolveVoiceNumber(patient, new Date(TELECOM_NOW)), history: resolveSmsHistoryNumber(patient, new Date(TELECOM_NOW)) });
  };

  await open(15140);
  assert.equal(await contact.getByLabel("Phone", { exact: true }).inputValue(), NUMBERS.H);
  await capture("before");
  await open();
  assert.equal(await contact.getByLabel("Phone 1", { exact: true }).inputValue(), NUMBERS.M);
  assert.equal(await contact.getByLabel("Phone 2", { exact: true }).inputValue(), NUMBERS.H);
  await capture("after");
  await save("imported-no-edit");
  assert.deepEqual(patient.telecom, patientInput.telecom);
  assert.deepEqual(patient.telecom![2], patientInput.telecom![2]);
  await contact.locator('input[type="radio"][value="phone2"]').check();
  await save("chosen-H");
  assert.equal(resolveSmsNumber(patient, new Date(TELECOM_NOW)), NUMBERS.H);
  assert.equal(resolveVoiceNumber(patient, new Date(TELECOM_NOW)), NUMBERS.M);
  await history(["H-thread"]);
  await capture("chosen-H");
  await contact.locator('input[type="radio"][value="neither"]').check();
  await save("neither");
  assert.equal(resolveSmsNumber(patient, new Date(TELECOM_NOW)), undefined);
  assert.equal(patient.telecom!.filter(point => point.extension?.some(e => e.url === ODOS_TEXTABLE_NUMBER_EXTENSION_URL)).length, 1);
  await history(["H-thread"]);
  await capture("neither");
  await contact.locator('input[type="radio"][value="phone2"]').check();
  await save("chosen-M");
  assert.equal(resolveSmsNumber(patient, new Date(TELECOM_NOW)), NUMBERS.M);
  assert.equal(patient.extension?.some(e => e.url === ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL), false);
  await history([]);
  await capture("chosen-M");
  assert.deepEqual(queries, [NUMBERS.H, NUMBERS.H, NUMBERS.M]);

  const blankInput = { ...patientInput, telecom: [patientInput.telecom![3]] };
  patient = await fhir.create<Patient>(blankInput);
  await open();
  await contact.getByLabel("Phone 1", { exact: true }).fill("");
  await save("blank-phone");
  assert.equal(patient.telecom?.length ?? 0, 0);
  assert.doesNotMatch(JSON.stringify(writes.at(-1)!.body), /"value"\s*:\s*""/);
  await capture("blank-phone");
  const count = writes.length;
  await contact.locator('input[type="radio"][value="phone1"]').check();
  await dialog.getByRole("button", { name: "Save demographics", exact: true }).click();
  await contact.getByText("Phone 1 was chosen as the texting number — enter it, choose another, or Neither.", { exact: true }).waitFor();
  assert.equal(writes.length, count);
  await capture("R2-block");
  assert.deepEqual(pageErrors, []);
  writeFileSync(resolve(output, "results.json"), JSON.stringify({ sourceHead, base: "300462446fa2f908d4f614b2be7d0f371ef2794b", medplumVersion: "5.1.30", route: "/clinic", viewport: { width: 1440, height: 1100 }, pageErrors, putCount: writes.length, R2WriteCount: writes.length - count, results,
    limits: ["Local synthetic Medplum only; no external messages sent.", "Real conversation API and configured GHL adapter; provider responses are synthetic H-only fixtures.", "This head has no conversation panel; Neither screenshot and recorded API response are separate evidence.", "Ancillary clinical endpoints are stubbed; application staff and audit dependencies are injected. This is not constrained-role AccessPolicy proof."] }, null, 2) + "\n");
  console.log(`APP /clinic + Medplum: ${writes.length} PUTs returned 200; H / Neither / M history verified; R2 made zero writes; seven captures; zero page errors.`);
} finally {
  await browser.close();
  await beforeServer.close();
  await afterServer.close();
}
