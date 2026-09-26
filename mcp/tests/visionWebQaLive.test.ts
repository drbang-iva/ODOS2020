import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync, readFileSync, statSync, rmSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Task } from "@medplum/fhirtypes";
import { visionWebConfigFromEnv, assertVisionWebTransmission } from "../src/integrations/visionweb/config.js";
import { createVisionWebClient, sanitizeVendorText, visionWebSecrets } from "../src/integrations/visionweb/visionWebClient.js";
import { parseVisionWebUploadResponse } from "../src/integrations/visionweb/uploadResponse.js";
import { escapeVisionWebXml } from "../src/integrations/visionweb/vwOrderSerializer.js";
import { createVisionWebLabOrderAdapter } from "../src/lab-orders/adapters/visionweb-lab-order-adapter.js";
import { order } from "./fixtures/visionweb/support.js";

interface QaCaptureRecord {
  bodyPath: string;
  metadataPath: string;
  httpStatus: number;
  contentType: string;
}

function observingQaFetch(
  fetchImpl: typeof fetch,
  directory: string,
  operationFor: (url: string) => string,
  records: QaCaptureRecord[],
): typeof fetch {
  return async (url, init) => {
    const operation = operationFor(String(url));
    if (!/^[a-z-]+$/.test(operation)) throw new Error("Invalid QA capture operation.");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const response = await fetchImpl(url, init);
    const timestamp = new Date().toISOString().replace(/:/g, "-");
    const stem = join(directory, `${timestamp}-${operation}`);
    const bodyPath = `${stem}.txt`;
    const metadataPath = `${stem}.metadata.json`;
    const metadata = { httpStatus: response.status, contentType: response.headers.get("content-type") ?? "" };
    const bytes = Buffer.from(await response.clone().arrayBuffer());
    writeFileSync(bodyPath, bytes, { flag: "wx", mode: 0o600 });
    writeFileSync(metadataPath, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
    records.push({ bodyPath, metadataPath, ...metadata });
    return response;
  };
}

function assertCaptureSafe(value: string, secrets: string[]): void {
  for (const secret of secrets.flatMap(s => [s, escapeVisionWebXml(s)])) {
    if (secret && value.includes(secret)) throw new Error("QA capture contains credentials; disclosure refused.");
  }
  if (/(?<!\d)\d{10}(?!\d)/.test(value)) throw new Error("QA capture contains a ten-digit value; ruling required.");
}

function structure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structure);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, /status/i.test(key) && (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") ? entry : structure(entry)]));
  return typeof value;
}

interface QaCredential { name: string; value: string; ignoreCase: boolean }
function credentialPattern(secret: string, whole: boolean, ignoreCase: boolean): RegExp {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(whole ? `(?<!\\w)${escaped}(?!\\w)` : escaped, ignoreCase ? "gi" : "g");
}
function checkWholeCredentials(value: string, credentials: QaCredential[]): void {
  for (const credential of credentials) if (credential.value && credentialPattern(credential.value, true, credential.ignoreCase).test(value)) throw new Error("QA capture contains a whole-token credential; disclosure refused.");
  if (/(?<!\d)\d{10}(?!\d)/.test(value)) throw new Error("QA capture contains a ten-digit value; ruling required.");
}

test("R10 classify private captures without network access", { skip: process.env.VISIONWEB_QA_CLASSIFY !== "1" }, () => {
  const config = visionWebConfigFromEnv(); assertVisionWebTransmission(config);
  const directory = join(homedir(), ".config/odos/visionweb-qa-captures");
  const credentials: QaCredential[] = [
    { name: "VISIONWEB_USERNAME", value: config.username, ignoreCase: true },
    { name: "VISIONWEB_PASSWORD", value: config.password, ignoreCase: false },
    { name: "VISIONWEB_CLIENT_ID", value: config.clientId, ignoreCase: true },
    { name: "VISIONWEB_CLIENT_SECRET", value: config.clientSecret, ignoreCase: false },
  ];
  const files = readdirSync(directory);
  for (const file of files.filter(name => name.endsWith("-token.txt"))) {
    const token = JSON.parse(readFileSync(join(directory, file), "utf8")).access_token;
    if (typeof token === "string") credentials.push({ name: "issued bearer token", value: token, ignoreCase: false });
  }
  const uploads = files.filter(name => name.endsWith("-upload.txt"));
  if (uploads.length !== 1) throw new Error("Expected one upload capture.");
  const raw = readFileSync(join(directory, uploads[0]), "utf8");
  if (XMLValidator.validate(raw) !== true || /<!DOCTYPE/i.test(raw)) throw new Error("Ambiguous non-XML capture; stopped.");
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
  const matches: Array<{ variable: string; path: string; wholeToken: boolean; exactCase: boolean; count: number }> = [];
  const elements: Array<{ path: string; text?: string }> = [];
  function walk(value: unknown, path: string): void {
    if (Array.isArray(value)) { value.forEach(entry => walk(entry, path)); return; }
    if (value && typeof value === "object") { for (const [key, entry] of Object.entries(value)) walk(entry, `${path}/${key}`); return; }
    if (typeof value !== "string") return;
    if (value.trim().startsWith("<") && XMLValidator.validate(value) === true) { elements.push({ path }); walk(parser.parse(value), `${path}/(decoded)`); return; }
    let withheld = false;
    for (const credential of credentials) {
      if (!credential.value) continue;
      for (const match of value.matchAll(credentialPattern(credential.value, false, true))) {
        const index = match.index!;
        const wholeToken = !/\w/.test(value[index - 1] ?? "") && !/\w/.test(value[index + match[0].length] ?? "");
        const exactCase = match[0] === credential.value;
        const prior = matches.find(row => row.variable === credential.name && row.path === path && row.wholeToken === wholeToken && row.exactCase === exactCase);
        if (prior) prior.count++; else matches.push({ variable: credential.name, path, wholeToken, exactCase, count: 1 });
        withheld ||= wholeToken;
      }
    }
    elements.push({ path, ...(withheld ? { text: "<withheld>" } : /(?:^|:)Status$/.test(path.split("/").at(-1)!) ? { text: value } : {}) });
  }
  walk(parser.parse(raw), "");
  console.log(JSON.stringify({ matches, elements }));
  let fixture = raw;
  for (const credential of credentials) {
    if (!credential.value) continue;
    for (const form of new Set([credential.value, escapeVisionWebXml(credential.value)])) {
      fixture = fixture.replace(credentialPattern(form, true, credential.ignoreCase), `REDACTED-${credential.name.replace(/ /g, "-")}`);
    }
  }
  for (const file of files.filter(name => /-(token|history|upload)\.txt$/.test(name))) {
    const body = readFileSync(join(directory, file), "utf8"); let passed = true;
    try { checkWholeCredentials(body, credentials); } catch { passed = false; }
    console.log(JSON.stringify({ operation: file.endsWith("-token.txt") ? "token" : file.endsWith("-history.txt") ? "history" : "upload", wholeTokenCheck: passed ? "passed" : "blocked", protectedTokenResponse: file.endsWith("-token.txt") }));
  }
  checkWholeCredentials(fixture, credentials);
  const safeDoc = parser.parse(fixture);
  const inner = safeDoc["soap:Envelope"]?.["soap:Body"]?.UploadFileResponse?.UploadFileResult?.["#text"] ?? safeDoc["soap:Envelope"]?.["soap:Body"]?.UploadFileResponse?.UploadFileResult;
  if (typeof inner !== "string") throw new Error("Ambiguous SOAP result.");
  const result = parser.parse(inner);
  const error = result.ERROR_MESSAGE?.ERROR;
  if (typeof error === "string") {
    const sanitizedError = sanitizeVendorText(error, credentials.map(credential => credential.value));
    checkWholeCredentials(sanitizedError, credentials);
    console.log(JSON.stringify({ vendorError: sanitizedError, hasStatusElement: false }));
  }
  if (process.env.VISIONWEB_QA_SAVE_FIXTURE === "1") writeFileSync(new URL("./fixtures/visionweb/qa-upload-response.xml", import.meta.url), fixture, { flag: "wx", mode: 0o600 });
});

test("L1 R7-R9 bounded synthetic VisionWeb QA proof", { skip: process.env.VISIONWEB_QA_LIVE !== "1" }, async () => {
  const config = visionWebConfigFromEnv(); assertVisionWebTransmission(config);
  if (new URL(config.soapUrl).hostname !== "services.visionwebqa.com") throw new Error("QA host required.");
  const directory = join(homedir(), ".config/odos/visionweb-qa-captures");
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const phase = process.env.VISIONWEB_QA_PHASE;
  if (phase !== "history" && phase !== "upload" && phase !== "inspect") throw new Error("Explicit history, upload or inspect phase required.");
  const secrets = visionWebSecrets(config);
  const records: QaCaptureRecord[] = [];
  const observed = observingQaFetch(async (url, init) => {
    const operation = String(url) === config.tokenUrl ? "token" : String(url) === config.soapUrl ? "upload" : "history";
    writeFileSync(join(directory, `r9-${operation}-attempted.json`), JSON.stringify({ at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30000) });
  }, directory, url => url === config.tokenUrl ? "token" : url === config.soapUrl ? "upload" : "history", records);
  const client = createVisionWebClient({ fetchImpl: observed });
  if (phase === "history") {
    let token: string;
    try { token = await client.getAccessToken(config, "VW.OP.Order.WebApi"); }
    catch { const record = records.at(-1); console.log(JSON.stringify({ operation: "token", httpStatus: record?.httpStatus, contentType: record?.contentType, body: "protected credential response" })); throw new Error("QA token request failed; stopped."); }
    secrets.push(token);
    const tokenRecord = records.at(-1)!;
    // Token bodies remain private even when all other capture checks would pass.
    console.log(JSON.stringify({ operation: "token", httpStatus: tokenRecord.httpStatus, contentType: tokenRecord.contentType, body: "protected credential response" }));
    const today = new Date().toISOString().slice(0, 10);
    const response = await observed(`${config.apiBaseUrl.replace(/\/$/, "")}/order/OrderHistory`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ Username: config.username, Password: config.password, FromDate: `${today}T00:00:00Z`, ToDate: `${today}T23:59:59Z`, PageNumber: 1, PageSize: 50, OrderType: "", OrderStatus: 0, PatientFirstName: "", PatientLastName: "TEST LAST", SupplierId: "", ExternalOrderNumber: "" }),
    });
    const raw = await response.text();
    assertCaptureSafe(raw, secrets);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { console.log(JSON.stringify({ operation: "history", httpStatus: response.status, contentType: response.headers.get("content-type"), structure: "non-JSON response" })); throw new Error("QA history response unreadable; stopped."); }
    console.log(JSON.stringify({ operation: "history", httpStatus: response.status, contentType: response.headers.get("content-type"), structure: structure(value) }));
    if (!response.ok) throw new Error("QA history HTTP failure; stopped.");
    writeFileSync(join(directory, "r9-history-success.json"), JSON.stringify({ bodyPath: records.at(-1)!.bodyPath, today }), { flag: "wx", mode: 0o600 });
    return;
  }
  const historyRecord = JSON.parse(readFileSync(join(directory, "r9-history-success.json"), "utf8"));
  if (historyRecord.today !== new Date().toISOString().slice(0, 10)) throw new Error("History is from another UTC day; stopped.");
  for (const file of readdirSync(directory).filter(name => name.endsWith("-token.txt"))) {
    const token = JSON.parse(readFileSync(join(directory, file), "utf8")).access_token;
    if (typeof token === "string") secrets.push(token);
  }
  if (phase === "inspect") {
    const files = readdirSync(directory).filter(name => name.endsWith("-upload.metadata.json")).sort();
    if (files.length !== 1) throw new Error("Expected exactly one R9 upload capture.");
    const metadata = readFileSync(join(directory, files[0]), "utf8");
    assertCaptureSafe(metadata, secrets);
    console.log(JSON.stringify({ operation: "upload", ...JSON.parse(metadata), bodyDisclosure: "withheld: credential check failed" }));
    return;
  }
  const historyRaw = readFileSync(historyRecord.bodyPath, "utf8"); assertCaptureSafe(historyRaw, secrets);
  const history = JSON.parse(historyRaw);
  if (history.TotalRecords !== 0 || !Array.isArray(history.Results) || history.Results.length !== 0) throw new Error("Nonempty history requires matching-order inspection; stopped.");
  console.log("R7: attempt 1 left no trace in today's UTC history for TEST LAST.");
  const synthetic = order();
  synthetic.header.orderId = `ODOS-QA-${crypto.randomUUID().replace(/\d/g, "x").slice(0, 8)}`;
  synthetic.header.patientName = "TEST LAST"; synthetic.header.lab = "VisionWeb QA Demo";
  synthetic.lensSpec = { jobType: "Uncut", lensDesign: "SV", lensMaterial: "PH-67-NONE-NONE-00", treatments: [] };
  synthetic.rx = { od: { sphere: 5, distPd: 30 }, os: { sphere: 2, distPd: 30 } };
  const tasks = new Map<string, Task>();
  const fhir: any = {
    read: async () => ({ resourceType: "Task", id: "synthetic-order", status: "requested", intent: "order" }),
    search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [...tasks.values()].map(resource => ({ resource })) }),
    create: async (t: Task) => { const saved = { ...t, id: "synthetic-transmission" }; tasks.set(saved.id, saved); return saved; },
    update: async (_rt: string, id: string, t: Task) => { tasks.set(id, t); return t; },
  };
  const recordingClient = { ...client, uploadOrder: async (cfg: typeof config, request: Parameters<typeof client.uploadOrder>[1]) => {
    const identity = JSON.stringify({ OrderId: request.subordid, msgguid: request.msgguid });
    assertCaptureSafe(identity, secrets);
    writeFileSync(join(directory, `${new Date().toISOString().replace(/:/g, "-")}-submission-identity.json`), identity, { flag: "wx", mode: 0o600 });
    return client.uploadOrder(cfg, request);
  } };
  let adapterFailed = false;
  try {
    await createVisionWebLabOrderAdapter(fhir, config, recordingClient, { recordAudit: async () => {} }).submit({ order: synthetic, orderTaskReference: "Task/synthetic-order", staffReference: "Practitioner/synthetic", lab: "VisionWeb QA Demo" });
  } catch { adapterFailed = true; }
  const record = records.at(-1);
  if (!record) throw new Error("QA submission produced no captured response; stopped.");
  const raw = readFileSync(record.bodyPath, "utf8"); assertCaptureSafe(raw, secrets);
  const xml = XMLValidator.validate(raw) === true ? new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(raw) : undefined;
  const report = { operation: "upload", httpStatus: record.httpStatus, contentType: record.contentType, structure: xml ? structure(xml) : "non-XML response", adapterFailed, orderId: synthetic.header.orderId };
  assertCaptureSafe(JSON.stringify(report), secrets); console.log(JSON.stringify(report));
  if (record.httpStatus < 200 || record.httpStatus >= 300) throw new Error("QA upload HTTP failure; stopped.");
  writeFileSync(join(directory, "r9-upload-observed.json"), JSON.stringify({ bodyPath: record.bodyPath, orderId: synthetic.header.orderId, adapterFailed }), { flag: "wx", mode: 0o600 });
  if (adapterFailed) throw new Error("QA adapter did not accept the captured response; offline inspection required. No retry.");
});


test("R6 observing fetch persists raw bytes and HTTP metadata before the caller can parse", async () => {
  const parent = mkdtempSync(join(tmpdir(), "odos-vwa-capture-test-"));
  const directory = join(parent, "captures");
  const records: QaCaptureRecord[] = [];
  const body = "<unparseable synthetic response";
  try {
    const observed = observingQaFetch(async () => new Response(body, {
      status: 502, headers: { "Content-Type": "text/xml; charset=utf-8" },
    }), directory, () => "upload", records);
    const response = await observed("https://synthetic.example/upload");
    assert.equal(records.length, 1);
    assert.equal(readFileSync(records[0].bodyPath, "utf8"), body);
    assert.equal(records[0].httpStatus, 502);
    assert.equal(records[0].contentType, "text/xml; charset=utf-8");
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(records[0].bodyPath).mode & 0o777, 0o600);
    assert.equal(statSync(records[0].metadataPath).mode & 0o777, 0o600);
    const metadata = JSON.parse(readFileSync(records[0].metadataPath, "utf8"));
    assert.deepEqual(metadata, { httpStatus: 502, contentType: "text/xml; charset=utf-8" });
    await assert.rejects(response.json());
    assert.equal(readFileSync(records[0].bodyPath, "utf8"), body);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});


test("R10 fixture credential boundaries honor per-variable case and regex characters", () => {
  const credentials = [
    { name: "VISIONWEB_USERNAME", value: "demo", ignoreCase: true },
    { name: "VISIONWEB_PASSWORD", value: "p+a.ss", ignoreCase: false },
  ];
  checkWholeCredentials("demonstration prefixp+a.sssuffix", credentials);
  assert.throws(() => checkWholeCredentials("user=DEMO", credentials), /whole-token/);
  assert.throws(() => checkWholeCredentials('password="p+a.ss"', credentials), /whole-token/);
  checkWholeCredentials('password="P+A.SS"', credentials);
  assert.throws(() => checkWholeCredentials("0123456789", credentials), /ten-digit/);
});
