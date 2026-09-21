import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Basic, Bundle, Patient, Resource } from "@medplum/fhirtypes";
import type { MedplumClient } from "../src/fhir-client.js";
import { createEmailAddressSuppressionReader, createFhirEmailUnsubscribeStore, createInMemoryEmailUnsubscribeStore, issueUnsubscribeToken, registerEmailUnsubscribeRoutes, readEmailAddressSuppression } from "../src/comms/email-unsubscribe.js";
import { checkMessageSuppression, createSuppressedCommsProvider, effectiveCommsPreferences, readCommsPreferenceCells } from "../src/comms/suppression-gate.js";
import { dispatchEducationAs } from "../src/comms/comms-api.js";

const first = "2026-09-20T15:00:00.000Z";
const second = "2026-09-20T16:00:00.000Z";
const address = "Household@Example.invalid";

function database() {
  const rows: Resource[] = ["a", "b"].map(id => ({ resourceType: "Patient", id, meta: { versionId: "1" }, telecom: [{ system: "email", value: address }] }));
  let conflicts = 0;
  let failPatient = false;
  const fhir = {
    baseUrl: "http://127.0.0.1/fhir/R4",
    async read(type: string, id: string) {
      const row = rows.find(r => r.resourceType === type && r.id === id);
      if (!row) throw Object.assign(new Error("Missing synthetic resource"), { status: 404 });
      return structuredClone(row);
    },
    async search(type: string, params: Record<string, string>): Promise<Bundle> {
      const identifier = params.identifier?.replace(/\\([\\|,$])/g, "$1");
      return { resourceType: "Bundle", type: "searchset", entry: rows.filter(r => r.resourceType === type && (!identifier || (r as Basic).identifier?.some(i => `${i.system}|${i.value}` === identifier))).map(resource => ({ resource: structuredClone(resource) })) };
    },
    async create(resource: Resource, headers: Record<string, string> = {}) {
      const conditional = headers["If-None-Exist"];
      if (conditional && new URLSearchParams(conditional).has("identifier")) {
        const identifier = new URLSearchParams(conditional).get("identifier")!.replace(/\\([\\|,$])/g, "$1");
        const existing = rows.find(r => r.resourceType === resource.resourceType && (r as Basic).identifier?.some(i => `${i.system}|${i.value}` === identifier));
        if (existing) return structuredClone(existing);
      }
      const saved = structuredClone({ ...resource, id: `row-${rows.length}`, meta: { versionId: "1" } });
      rows.push(saved);
      return structuredClone(saved);
    },
    async update(type: string, id: string, resource: Resource, headers: Record<string, string>) {
      if (type === "Patient" && failPatient) throw Object.assign(new Error("Synthetic unavailable"), { status: 503 });
      const index = rows.findIndex(r => r.resourceType === type && r.id === id);
      if (headers["If-Match"] !== `W/"${rows[index].meta!.versionId}"`) {
        conflicts++;
        throw Object.assign(new Error("Synthetic version conflict"), { status: 412 });
      }
      rows[index] = structuredClone({ ...resource, meta: { versionId: String(Number(rows[index].meta!.versionId) + 1) } });
      return structuredClone(rows[index]);
    },
  } as unknown as MedplumClient;
  return { fhir, rows, conflicts: () => conflicts, failPatient: (value: boolean) => { failPatient = value; } };
}

async function fixture() {
  const db = database();
  const store = createFhirEmailUnsubscribeStore(db.fhir);
  let now = first;
  const app = express();
  registerEmailUnsubscribeRoutes(app, { store, fhir: db.fhir, now: () => now });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const issue = (patientReference = "Patient/a", email = address) => issueUnsubscribeToken({ store, patientReference, email, publicBaseUrl: "https://practice.invalid", now: () => first });
  const send = async (token: string, method = "POST") => {
    const response = await fetch(`${base}/comms/u/${token}`, { method, ...(method === "POST" ? { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" } : {}) });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) };
  };
  return { ...db, store, issue, send, base, now: (value: string) => { now = value; }, async close() { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); } };
}

const request = (patientReference: string, toAddress = address) => ({ patientReference, toAddress, campaignType: "clinical-education", subject: "Synthetic", body: "Synthetic", suppression: { consentClass: "marketing" as const } });
const gateDeps = (fhir: MedplumClient) => ({ fhir, isEmailAddressSuppressed: createEmailAddressSuppressionReader(fhir), practiceTimeZone: "UTC", now: () => new Date(first) });

test("A scanner GET leaves patient cells and address suppression unchanged", async () => {
  const f = await fixture();
  try {
    const { token } = await f.issue();
    const before = await f.fhir.read<Patient>("Patient", "a");
    assert.equal((await f.send(token, "GET")).status, 200);
    assert.deepEqual(await f.fhir.read("Patient", "a"), before);
    assert.equal(await readEmailAddressSuppression(f.fhir, address), undefined);
  } finally { await f.close(); }
});

test("B valid unknown and revoked tokens have identical HTTP bytes and headers", async () => {
  const f = await fixture();
  try {
    const valid = await f.issue();
    const revoked = await f.issue("Patient/b", "other@example.invalid");
    await f.send(revoked.token);
    const tokens = [valid.token, "z".repeat(24), revoked.token];
    for (const method of ["GET", "POST"]) {
      const responses = await Promise.all(tokens.map(token => f.send(token, method)));
      assert.equal(responses[0].status, 200);
      assert.deepEqual(responses[1], responses[0]);
      assert.deepEqual(responses[2], responses[0]);
      for (const token of tokens) assert.ok(!responses[0].body.toString().includes(token));
      assert.ok(!responses[0].body.toString().includes("@"));
    }
  } finally { await f.close(); }
});

test("C repeated and concurrent POSTs preserve one receipt and first revocation", async () => {
  const f = await fixture();
  try {
    const { token } = await f.issue();
    const response = await f.send(token);
    const patient = await f.fhir.read("Patient", "a");
    f.now(second);
    assert.deepEqual(await f.send(token), response);
    assert.deepEqual(await f.fhir.read("Patient", "a"), patient);
    const receipt = await readEmailAddressSuppression(f.fhir, address);
    assert.equal(receipt?.revokedAt, first);
    assert.equal(receipt?.issuedAt, first);
    const other = await f.issue("Patient/b", address.toLowerCase());
    const replies = await Promise.all(Array.from({ length: 8 }, () => f.send(other.token)));
    for (const reply of replies) assert.deepEqual(reply, response);
    assert.equal((await readEmailAddressSuppression(f.fhir, address))?.revokedAt, first);
    assert.equal(f.rows.filter(r => r.resourceType === "Basic" && r.code.coding?.some(c => c.code === "email-address-suppression")).length, 1);
    assert.equal(effectiveCommsPreferences(await f.fhir.read<Patient>("Patient", "b"), {})["marketing-promo"].email.value, false);
  } finally { await f.close(); }
});

test("D decision layer refuses both patients at the shared inbox after unsubscribe", async () => {
  const f = await fixture();
  try {
    for (const id of ["a", "b"]) assert.equal((await checkMessageSuppression(gateDeps(f.fhir), request(`Patient/${id}`), "email")).result, undefined);
    await f.send((await f.issue()).token);
    for (const id of ["a", "b"]) assert.equal((await checkMessageSuppression(gateDeps(f.fhir), request(`Patient/${id}`, address.toUpperCase()), "email")).result?.outcome, "suppressed");
    assert.equal((await checkMessageSuppression(gateDeps(f.fhir), request("Patient/b", "different@example.invalid"), "email")).result, undefined);
    const cells = readCommsPreferenceCells(await f.fhir.read<Patient>("Patient", "a"));
    assert.deepEqual(cells, [{ purpose: "marketing-promo", channel: "email", allowed: false, recordedAt: first, setBy: { reference: "Patient/a" }, surface: "email-unsubscribe" }]);
  } finally { await f.close(); }
});

test("E unsubscribe preserves treatment cells and transactional education still sends", async () => {
  const f = await fixture();
  try {
    const before = effectiveCommsPreferences(await f.fhir.read<Patient>("Patient", "a"), {});
    await f.send((await f.issue()).token);
    const after = effectiveCommsPreferences(await f.fhir.read<Patient>("Patient", "a"), {});
    for (const purpose of ["education", "appointment", "recalls", "product-pickup"] as const) assert.deepEqual(after[purpose], before[purpose]);
    const sends: unknown[] = [];
    const provider = createSuppressedCommsProvider({ name: "synthetic", sendEmail: async r => { sends.push(r); return { outcome: "sent", providerMessageId: "synthetic-education" }; } }, gateDeps(f.fhir));
    const deps = { practiceName: "Synthetic", now: () => first, educationCatalog: { get: () => ({ id: "education", version: 1, title: "Synthetic education", kind: "page", audience: "patient", dxCodes: [], channels: ["email"], laneHint: "clinical", consentClass: "transactional", urls: { email: "https://example.invalid/education" } }) }, dispatch: { providerFor: () => "synthetic", getAdapterForRole: () => provider } };
    const result = await dispatchEducationAs({ kind: "system", reference: "Device/education-sequence-worker", onBehalfOf: "Practitioner/synthetic-enroller", fhir: f.fhir }, deps as never, await f.fhir.read("Patient", "a"), { patientReference: "Patient/a", educationId: "education", version: 1, channel: "email", lane: "clinical", alsoUpdateChart: false, idempotencyKey: "e1c1-treatment" });
    assert.equal(result.outcome, "sent");
    assert.equal(sends.length, 1);
  } finally { await f.close(); }
});

test("F same patient and address receive independent random tokens", async () => {
  const store = createInMemoryEmailUnsubscribeStore();
  const input = { store, patientReference: "Patient/a", email: address, publicBaseUrl: "https://practice.invalid/", now: () => first };
  const a = await issueUnsubscribeToken(input), b = await issueUnsubscribeToken(input);
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[A-Za-z0-9_-]{24,128}$/);
  assert.equal(a.url, `https://practice.invalid/comms/u/${a.token}`);
  assert.equal((await store.find(a.token))?.email, address.toLowerCase());
});

test("F malformed route tokens reject without touching storage", async () => {
  const app = express();
  const forbidden = new Proxy({}, { get() { throw new Error("Malformed token touched storage"); } });
  registerEmailUnsubscribeRoutes(app, { store: forbidden as never, fhir: forbidden as never, authenticateService: async () => { throw new Error("Malformed token authenticated service"); } });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  try {
    for (const token of ["short", "x".repeat(129), "invalid%21token"]) for (const method of ["GET", "POST"]) {
      const res = await fetch(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/comms/u/${token}`, { method });
      assert.equal(res.status, 400); await res.text();
    }
  } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
});

test("partial Patient failure retains address suppression and retry completes patient update", async () => {
  const f = await fixture();
  try {
    const { token } = await f.issue();
    f.failPatient(true);
    assert.equal((await f.send(token)).status, 503);
    assert.equal((await readEmailAddressSuppression(f.fhir, address))?.revokedAt, first);
    f.failPatient(false); f.now(second);
    assert.equal((await f.send(token)).status, 200);
    assert.equal((await readEmailAddressSuppression(f.fhir, address))?.revokedAt, first);
    assert.equal(readCommsPreferenceCells(await f.fhir.read<Patient>("Patient", "a"))[0].allowed, false);
  } finally { await f.close(); }
});

test("service suppression decision does not use caller Basic access or replace caller Patient reads", async () => {
  const db = database();
  const caller = { ...db.fhir, search: async () => { throw new Error("Caller Basic access denied"); } };
  const decisions: unknown[] = [];
  const checked = await checkMessageSuppression({ ...gateDeps(caller), isEmailAddressSuppressed: async (email: string, scope: string) => { decisions.push([email, scope]); return true; } }, request("Patient/b"), "email");
  assert.deepEqual(checked.result, { outcome: "suppressed", reason: "patient-opt-out" });
  assert.deepEqual(decisions, [[address, "marketing-promo"]]);
  await assert.rejects(checkMessageSuppression({ ...gateDeps(caller), fhir: { ...caller, read: async () => { throw new Error("Caller Patient access denied"); } }, isEmailAddressSuppressed: async () => true }, request("Patient/b"), "email"), /Caller Patient access denied/);
});

test("marketing fails closed without a service reader and when the service read fails", async () => {
  const db = database();
  await assert.rejects(checkMessageSuppression({ ...gateDeps(db.fhir), isEmailAddressSuppressed: undefined }, request("Patient/b"), "email"), /suppression reader is required/);
  await assert.rejects(checkMessageSuppression({ ...gateDeps(db.fhir), isEmailAddressSuppressed: async () => { throw new Error("Service unavailable"); } }, request("Patient/b"), "email"), /Service unavailable/);
});

test("service reader exposes only a boolean for the requested address and scope", async () => {
  const db = database(), store = createFhirEmailUnsubscribeStore(db.fhir);
  const read = createEmailAddressSuppressionReader(db.fhir);
  assert.equal(await read(address, "marketing-promo"), false);
  await store.suppressAddress({ email: address, patientReference: "Patient/a", scope: "marketing-promo", issuedAt: first, revokedAt: first });
  assert.equal(await read(address.toUpperCase(), "marketing-promo"), true);
  assert.equal(await read("different@example.invalid", "marketing-promo"), false);
  assert.equal(await read(address, "education" as never), false);
});

test("concurrent first clicks recover Patient version conflicts without duplicate receipts", async () => {
  const f = await fixture();
  try {
    const originalRead = f.fhir.read.bind(f.fhir);
    let arrive = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.fhir.read = async <T extends Resource>(type: T["resourceType"], id: string): Promise<T> => {
      const resource = await originalRead<T>(type, id);
      if (type === "Patient" && ++arrive <= 2) { if (arrive === 2) release(); await barrier; }
      return resource;
    };
    const { token } = await f.issue();
    const replies = await Promise.all([f.send(token), f.send(token)]);
    assert.equal(replies[0].status, 200); assert.deepEqual(replies[0], replies[1]);
    assert.equal(f.conflicts(), 1);
    assert.equal((await f.fhir.read<Patient>("Patient", "a")).meta?.versionId, "2");
    assert.equal((await readEmailAddressSuppression(f.fhir, address))?.revokedAt, first);
  } finally { await f.close(); }
});
