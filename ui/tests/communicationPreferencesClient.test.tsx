import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMS_PURPOSES, COMMS_PREFERENCE_CHANNELS, readCommunicationPreferences, saveCommunicationPreferences, readCommunicationPreferenceDefaults, listEvidenceGaps, downloadEvidenceGapsCsv, recordSmsOptOut, clearSmsOptOut, dispatchEducation, CommunicationsResponseError } from "../src/lib/communications-client";
function preferences(): any {
  return { patientReference: "Patient/synthetic", matrix: Object.fromEntries(COMMS_PURPOSES.map(p => [p, Object.fromEntries(COMMS_PREFERENCE_CHANNELS.map(c => [c, { value: true, source: "default" }]))])), rows: COMMS_PURPOSES.flatMap(purpose => COMMS_PREFERENCE_CHANNELS.map(channel => ({ purpose, channel, value: true, source: "default", evidenceSummary: [], lastSet: null, evidenceStatus: "gap" }))) };
}
const version = { writtenAgainst: "099840be-dc5d-45b4-95cd-ac7308f9ad08", current: "06e6f695-58e2-4e8c-9c37-1c00d279da36" };
function respond(body: unknown): typeof fetch { return async () => new Response(JSON.stringify(body)); }
const optOut = { patientReference: "Patient/synthetic", smsOptedOut: false, remainingOptOuts: { global: false, numbers: [] }, smsLanes: [] };
const recordInput = { patientReference: "Patient/synthetic", reason: "Patient asked", identityVerification: "in-person" as const, scope: "global" as const };
test("preferences client reads twenty cells and saves the exact payload with opaque versions", async () => {
  const body = { ...preferences(), patientVersion: version };
  assert.deepEqual(await readCommunicationPreferences("Patient/synthetic", async url => {
    assert.equal(new URL(String(url), "http://localhost").searchParams.get("patient"), "Patient/synthetic");
    return new Response(JSON.stringify(body));
  }), body);
  const input = { patientReference: "Patient/synthetic", cells: [{ purpose: "education" as const, channel: "email" as const, allowed: true }], confirmedVia: "paper-form" as const, formDate: "2026-09-10" };
  assert.deepEqual(await saveCommunicationPreferences(input, async (_url, init) => {
    assert.equal(init?.method, "PUT"); assert.deepEqual(JSON.parse(String(init?.body)), input); return new Response(JSON.stringify(body));
  }), body);
});
for (const malformed of ["source", "evidenceStatus", "patientVersion", "matrix", "rows", "metadata", "evidence"]) test(`M11 preferences client rejects malformed ${malformed}`, async () => {
  const body = preferences();
  if (malformed === "source") body.rows[0].source = "future-source";
  if (malformed === "evidenceStatus") body.rows[0].evidenceStatus = "assumed";
  if (malformed === "patientVersion") body.patientVersion = { writtenAgainst: version.writtenAgainst, current: 2 };
  if (malformed === "matrix") delete body.matrix.education.email;
  if (malformed === "rows") body.rows[0] = body.rows[1];
  if (malformed === "metadata") body.rows[0].lastSet = { recordedAt: "now", setBy: {}, surface: "staff-demographics" };
  if (malformed === "evidence") body.rows[0].evidenceSummary = [{ capture: { url: "capture", extension: [{ url: "method", valueCode: 5 }] } }];
  await assert.rejects(readCommunicationPreferences("Patient/synthetic", respond(body)), CommunicationsResponseError);
});
test("defaults parser requires every server boolean and version", async () => {
  const defaults = Object.fromEntries(COMMS_PURPOSES.map(p => [p, Object.fromEntries(COMMS_PREFERENCE_CHANNELS.map(c => [c, false]))]));
  const body = { version: "opaque-default-version", defaults };
  assert.deepEqual(await readCommunicationPreferenceDefaults(respond(body)), body);
  await assert.rejects(readCommunicationPreferenceDefaults(respond({ ...body, defaults: {} })), CommunicationsResponseError);
  await assert.rejects(readCommunicationPreferenceDefaults(respond({ ...body, version: 1 })), CommunicationsResponseError);
});
test("opt-out parsers retain optional opaque versions and reject malformed present shapes", async () => {
  for (const patientVersion of [undefined, version]) {
    const addition = patientVersion ? { patientVersion } : {};
    assert.deepEqual((await recordSmsOptOut(recordInput, respond({ ...optOut, ...addition }))).patientVersion, patientVersion);
    assert.deepEqual((await clearSmsOptOut(recordInput, respond({ ...optOut, cleared: true, ...addition }))).patientVersion, patientVersion);
  }
  for (const patientVersion of [null, {}, [], "unknown", { writtenAgainst: 1, current: "next" }, { writtenAgainst: "old", current: "" }]) {
    await assert.rejects(recordSmsOptOut(recordInput, respond({ ...optOut, patientVersion })), CommunicationsResponseError);
    await assert.rejects(clearSmsOptOut(recordInput, respond({ ...optOut, cleared: true, patientVersion })), CommunicationsResponseError);
  }
});
test("evidence client preserves filters, cursor, suppressed rows and CSV metadata", async () => {
  const row = { patientReference: "Patient/synthetic", purpose: "education", channel: "email", tier: 3, source: "explicit" };
  const body = { rows: [row], suppressed: [{ ...row, source: "suppression" }], counts: { "1": 0, "2": 0, "3": 1 }, truncated: true, cursor: "next_page" };
  const filters = { tier: "3" as const, purpose: "education" as const, channel: "email" as const, cursor: "previous_page" };
  assert.deepEqual(await listEvidenceGaps(filters, async url => {
    assert.deepEqual(Object.fromEntries(new URL(String(url), "http://localhost").searchParams), { ...filters, format: "json" }); return new Response(JSON.stringify(body));
  }), body);
  assert.deepEqual(await downloadEvidenceGapsCsv(filters, async url => {
    assert.equal(new URL(String(url), "http://localhost").searchParams.get("format"), "csv");
    return new Response("patientReference,purpose\r\n", { headers: { "X-ODOS-Truncated": "true", "X-ODOS-Cursor": "next_page" } });
  }), { text: "patientReference,purpose\r\n", truncated: "true", cursor: "next_page" });
  for (const invalid of [{ ...body, counts: { "1": 0, "2": -1, "3": 1 } }, { ...body, cursor: undefined }, { ...body, rows: [{ ...row, source: "unverified" }] }, { ...body, rows: [{ ...row, tier: 4 }] }])
    await assert.rejects(listEvidenceGaps({}, respond(invalid)), CommunicationsResponseError);
});
test("education sent parser surfaces only the supported preference failure flag", async () => {
  const input = { patientReference: "Patient/synthetic", educationId: "education", version: 1, channel: "email" as const, lane: "clinical" as const, alsoUpdateChart: false, idempotencyKey: "synthetic-send" };
  const body = { outcome: "sent", providerMessageId: "message", preferenceUpdate: "failed" };
  assert.deepEqual(await dispatchEducation(input, respond(body)), body);
  await assert.rejects(dispatchEducation(input, respond({ ...body, preferenceUpdate: "succeeded" })), CommunicationsResponseError);
});
test("preference and CSV failures preserve HTTP status for recovery", async () => {
  for (const status of [403, 409, 500]) {
    const fail: typeof fetch = async () => new Response(JSON.stringify({ error: "synthetic refusal" }), { status });
    for (const run of [() => readCommunicationPreferences("Patient/synthetic", fail), () => downloadEvidenceGapsCsv({}, fail)])
      await assert.rejects(run(), (error: unknown) => error instanceof CommunicationsResponseError && error.status === status && error.message === "synthetic refusal");
  }
});
