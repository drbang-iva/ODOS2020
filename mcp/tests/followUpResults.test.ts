import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLLOW_UP_PROFILE_SEEDS } from "../src/clinical-graph/follow-up-profile-store.js";
import { GLAUCOMA_PLAN_SET_SPECS } from "../src/clinical-graph/plan-sets/glaucoma.js";
import { PROCEDURE_FEE_SEEDS } from "../src/clinical-graph/procedure-fee-schedule.js";
import { FOLLOW_UP_RESULT_KINDS, resultKind } from "../src/clinical-graph/follow-up-result-kinds.js";
import type { Basic, Bundle, DiagnosticReport, Media, Resource, ServiceRequest } from "@medplum/fhirtypes";
import { FhirEncounterExamScopeStore, type ProposedExamTest } from "../src/clinical-graph/exam-scope-store.js";
import { buildProtocolBasic, PROTOCOL_BASIC_CODES } from "../src/clinical-graph/protocol-store.js";
import type { PlanActionInstance } from "../src/clinical-graph/protocol-types.js";
import { handleFollowUpQueueRequest, handleFollowUpResultRequest } from "../src/clinical-graph/follow-up-queue-endpoint.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";

test("S3c2c2a1 G1 registry covers exactly the currently proposable orderable-focus keys", () => {
  const proposed = new Set([
    ...FOLLOW_UP_PROFILE_SEEDS.flatMap(profile => profile.testsQueuedByDefault.map(row => `${row.orderable}|${row.focus ?? ""}`)),
    ...GLAUCOMA_PLAN_SET_SPECS.flatMap(set => set.tests.map(row => `${row.orderable}|${row.focus ?? ""}`)),
    ...PROCEDURE_FEE_SEEDS.filter(seed => seed.category === "procedure").map(seed => `${seed.procedureConceptKey}|`),
  ]);
  assert.equal(proposed.size, 16);
  assert.deepEqual(Object.keys(FOLLOW_UP_RESULT_KINDS).sort(), [...proposed].sort());
  for (const key of proposed) {
    const [orderable, focus] = key.split("|");
    assert.deepEqual(resultKind(orderable, focus), FOLLOW_UP_RESULT_KINDS[key]);
  }
  assert.deepEqual(resultKind("fundus-photography", "new focus"), { kind: "image", category: "fundus-photo" });
});

const source = { kind: "profile" as const, profileKey: "glaucoma", profileLabel: "Synthetic glaucoma" };
const optic: ProposedExamTest = { orderable: "fundus-photography", focus: "optic nerve", label: "Optic nerve photos", sources: [source] };
const retina: ProposedExamTest = { orderable: "fundus-photography", focus: "retina", label: "Retina photos", sources: [source] };
const field: ProposedExamTest = { orderable: "visual-field-threshold", label: "Visual field", sources: [source] };
const gonio: ProposedExamTest = { orderable: "gonioscopy", label: "Gonioscopy", sources: [source] };
const at = "2026-09-21T15:00:00.000Z";

class ResultsFhir {
  readonly baseUrl = "http://localhost:8103/";
  resources: Resource[] = [];
  writes: Array<{ resource: Resource; headers?: Record<string, string> }> = [];
  searches: Array<{ type: string; params: Record<string, string> }> = [];
  failSearchType?: string;
  failUpdateStatus?: number;
  failUpdateWithoutStatus = false;
  async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
    const found = this.resources.find(row => row.resourceType === type && row.id === id);
    if (!found) throw Object.assign(new Error("missing"), { status: 404 });
    return structuredClone(found) as T;
  }
  async search<T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    this.searches.push({ type, params: { ...params } });
    if (type === this.failSearchType) throw new Error("synthetic search failure");
    const rows = this.resources.filter(row => row.resourceType === type &&
      (!params.identifier || (row as Basic).identifier?.some(identifier => `${identifier.system}|${identifier.value}` === params.identifier)) &&
      (!params.code || (row as Basic).code?.coding?.some(code => `${code.system}|${code.code}` === params.code)) &&
      (!params.encounter || (row as Media | DiagnosticReport).encounter?.reference === params.encounter) &&
      (!params.status || (row as Media).status === params.status));
    return { resourceType: "Bundle", type: "searchset", entry: rows.map(row => ({ resource: structuredClone(row) as T })) };
  }
  async create<T extends Resource>(resource: T): Promise<T> {
    const saved = { ...structuredClone(resource), id: resource.id ?? `r${this.resources.length + 1}`, meta: { versionId: "1" } } as T;
    this.resources.push(saved);
    this.writes.push({ resource: saved });
    return structuredClone(saved);
  }
  async update<T extends Resource>(type: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
    if (this.failUpdateStatus) throw Object.assign(new Error("synthetic update failure"), { status: this.failUpdateStatus });
    if (this.failUpdateWithoutStatus) throw new Error("synthetic update failure");
    const index = this.resources.findIndex(row => row.resourceType === type && row.id === id);
    assert.notEqual(index, -1);
    assert.equal(headers?.["If-Match"], `W/"${this.resources[index]!.meta?.versionId}"`);
    const saved = { ...structuredClone(resource), id, meta: { versionId: String(Number(this.resources[index]!.meta?.versionId) + 1) } } as T;
    this.resources[index] = saved;
    this.writes.push({ resource: saved, headers });
    return structuredClone(saved);
  }
}

function planAction(test: ProposedExamTest, id: string): PlanActionInstance {
  return {
    id, encounterId: "e1", patientId: "p1", protocolApplicationId: null, actionType: "order", state: "selected",
    payload: { orderableKey: test.orderable, ...(test.focus ? { focus: test.focus } : {}) },
    linkedDx: [], linkedFindings: [], modifiedFields: [], materializedFhirRef: `ServiceRequest/${id}`,
    provenance: { source: "clinician-entered", actor: "Practitioner/synthetic", at },
  };
}
function serviceRequest(test: ProposedExamTest, id: string): ServiceRequest {
  return {
    resourceType: "ServiceRequest", id, status: "active", intent: "plan", subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" }, code: { text: test.orderable },
    ...(test.focus ? { bodySite: [{ text: test.focus }] } : {}),
  };
}
function image(id = "photo-1", category = "fundus-photo", encounterId = "e1", basedOn?: string): Media {
  return {
    resourceType: "Media", id, status: "completed", subject: { reference: "Patient/p1" },
    encounter: { reference: `Encounter/${encounterId}` },
    modality: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: category }] },
    createdDateTime: at, content: { contentType: "image/jpeg", title: `${id}.jpg`, url: `Binary/${id}` },
    meta: { versionId: "1" }, ...(basedOn ? { basedOn: [{ reference: basedOn }] } : {}),
  };
}
async function resultFixture(tests: ProposedExamTest[] = [optic, retina], ordered: ProposedExamTest[] = tests) {
  const staff = new ResultsFhir(), service = new ResultsFhir();
  staff.resources.push({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/p1" } });
  await new FhirEncounterExamScopeStore(service).pick("e1", "office-visit", { reference: "Practitioner/synthetic" }, null, [], tests);
  for (const [index, test] of ordered.entries()) {
    const id = `sr-${index + 1}`;
    staff.resources.push(buildProtocolBasic(planAction(test, id), PROTOCOL_BASIC_CODES.planActionInstance));
    staff.resources.push(serviceRequest(test, id));
  }
  const deps = { authenticate: async () => ({ staffReference: "Practitioner/synthetic", actorRole: "provider" as const, fhir: staff as any }), serviceFhir: service as any };
  const get = () => handleFollowUpQueueRequest(deps, { authHeader: "Bearer synthetic", params: { encounterId: "e1" } });
  const mutate = (orderable: string, focus: string | undefined, mediaReference: string, action: "link" | "unlink") =>
    handleFollowUpResultRequest(deps, { authHeader: "Bearer synthetic", params: { encounterId: "e1" }, body: { orderable, ...(focus ? { focus } : {}), mediaReference, action } });
  return { staff, service, deps, get, mutate };
}
function resultRows(reply: { status: number; body: unknown }) {
  assert.equal(reply.status, 200);
  return (reply.body as { rows: Array<{ state: string; result?: { status: string; items: unknown[]; candidates: unknown[] }; unreviewedResult?: boolean }> }).rows;
}

test("S3c2c2a1 G5 linking one fundus image completes only the chosen photo order", async () => {
  const h = await resultFixture();
  h.staff.resources.push(image());
  const before = resultRows(await h.get());
  assert.equal(before[0]!.result?.status, "none");
  assert.equal(before[1]!.result?.candidates.length, 1);
  const after = resultRows(await h.mutate("fundus-photography", "retina", "Media/photo-1", "link"));
  assert.equal(after[0]!.result?.status, "none");
  assert.equal(after[0]!.result?.items.length, 0);
  assert.equal(after[1]!.result?.status, "needs-interpretation");
  assert.equal(after[1]!.result?.items.length, 1);
  assert.deepEqual((h.staff.resources.find(row => row.resourceType === "Media") as Media).basedOn, [{ reference: "ServiceRequest/sr-2" }]);
});

test("S3c2c2a1 G6 unlink removes basedOn and returns the image to candidates", async () => {
  const h = await resultFixture();
  h.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-2"));
  const after = resultRows(await h.mutate("fundus-photography", "retina", "Media/photo-1", "unlink"));
  assert.equal(Object.hasOwn(h.staff.resources.find(row => row.resourceType === "Media")!, "basedOn"), false);
  assert.equal(after[1]!.result?.status, "none");
  assert.equal(after[1]!.result?.items.length, 0);
  assert.equal(after[1]!.result?.candidates.length, 1);
});

test("S3c2c2a1 G7 link refuses mismatched resources and maps store errors precisely", async () => {
  for (const media of [
    image("photo-1", "fundus-photo", "old"),
    image("photo-1", "oct"),
    image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-1"),
    { ...image(), bodySite: { text: "retina" }, note: [{ text: "Procedure definition: synthetic" }] },
  ]) {
    const h = await resultFixture();
    h.staff.resources.push(media);
    const before = h.staff.writes.length;
    const reply = await h.mutate("fundus-photography", "retina", "Media/photo-1", "link");
    assert.equal(reply.status, 409);
    assert.equal((reply.body as { code?: string }).code, "result-link-refused");
    assert.equal(h.staff.writes.length, before);
  }
  for (const media of [
    image("photo-1", "fundus-photo", "old", "ServiceRequest/sr-2"),
    image("photo-1", "oct", "e1", "ServiceRequest/sr-2"),
    { ...image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-2"), bodySite: { text: "retina" }, note: [{ text: "Procedure definition: synthetic" }] },
  ]) {
    const h = await resultFixture();
    h.staff.resources.push(media);
    const reply = await h.mutate("fundus-photography", "retina", "Media/photo-1", "unlink");
    assert.equal(reply.status, 409);
    assert.equal((reply.body as { code?: string }).code, "result-link-refused");
    assert.equal(h.staff.writes.length, 0);
  }
  for (const [tests, ordered, target] of [
    [[optic], [], optic], [[gonio], [gonio], gonio],
  ] as const) {
    const h = await resultFixture([...tests], [...ordered]);
    h.staff.resources.push(image());
    const reply = await h.mutate(target.orderable, target.focus, "Media/photo-1", "link");
    assert.equal(reply.status, 409);
    assert.equal((reply.body as { code?: string }).code, "result-link-refused");
    assert.equal(h.staff.writes.length, 0);
  }
  for (const [failure, expectedStatus, expectedCode] of [[412, 409, "concurrent-edit"], [undefined, 502, undefined]] as const) {
    const h = await resultFixture();
    h.staff.resources.push(image());
    if (failure) h.staff.failUpdateStatus = failure; else h.staff.failUpdateWithoutStatus = true;
    const reply = await h.mutate("fundus-photography", "retina", "Media/photo-1", "link");
    assert.equal(reply.status, expectedStatus);
    assert.equal((reply.body as { code?: string }).code, expectedCode);
    assert.equal(h.staff.writes.length, 0);
  }
});

test("S3c2c2a1 G8 an earlier visit image cannot complete today's order", async () => {
  const h = await resultFixture([retina], [retina]);
  h.staff.resources.push(image("old-photo", "fundus-photo", "old", "ServiceRequest/sr-1"));
  const rows = resultRows(await h.get());
  assert.equal(rows[0]!.result?.status, "none");
  assert.equal(rows[0]!.result?.items.length, 0);
  assert.equal(h.staff.searches.find(row => row.type === "Media")?.params.encounter, "Encounter/e1");
});

test("S3c2c2a1 G9 report basedOn or media link interprets, except entered-in-error", async () => {
  for (const linkKind of ["order", "media", "error"] as const) {
    const h = await resultFixture([retina], [retina]);
    h.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-1"));
    h.staff.resources.push({ resourceType: "DiagnosticReport", id: "report-1", status: linkKind === "error" ? "entered-in-error" : "final",
      code: { text: "synthetic interpretation" }, subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" }, conclusion: "Reviewed",
      ...(linkKind === "order" ? { basedOn: [{ reference: "ServiceRequest/sr-1" }] } : { media: [{ link: { reference: "Media/photo-1" } }] }),
    } as DiagnosticReport);
    const rows = resultRows(await h.get());
    assert.equal(rows[0]!.result?.status, linkKind === "error" ? "needs-interpretation" : "interpreted");
  }
});

test("S3c2c2a1 G4 signed visit refuses both link actions without writes", async () => {
  for (const action of ["link", "unlink"] as const) {
    const h = await resultFixture([retina], [retina]);
    (h.staff.resources[0] as { status: string }).status = "finished";
    h.staff.resources.push(image());
    const reply = await h.mutate("fundus-photography", "retina", "Media/photo-1", action);
    assert.equal(reply.status, 409);
    assert.deepEqual(reply.body, { error: "Signed encounter cannot be edited." });
    assert.equal(h.staff.writes.length, 0);
  }
});

test("S3c2c2a1 G10 unaccepted image row stays for-review with an additive hint", async () => {
  const h = await resultFixture([optic], []);
  h.staff.resources.push(image());
  const rows = resultRows(await h.get());
  assert.equal(rows[0]!.state, "for-review");
  assert.equal(rows[0]!.unreviewedResult, true);
});

test("S3c2c2a1 G11 recorded reads fail closed and unshaped responses stay exact", async () => {
  for (const type of ["Media", "DiagnosticReport"]) {
    const h = await resultFixture([retina], [retina]);
    h.staff.failSearchType = type;
    const reply = await h.get();
    assert.equal(reply.status, 502);
    assert.equal("rows" in (reply.body as object), false);
  }
  const h = await resultFixture([retina], [retina]);
  const rows = resultRows(await h.get());
  for (const row of rows) assert.ok(["for-review", "already-ordered", "unavailable", "not-today"].includes(row.state));
  const empty = new ResultsFhir();
  empty.resources.push({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/p1" } });
  const reply = await handleFollowUpQueueRequest({ authenticate: async () => ({ staffReference: "Practitioner/synthetic", actorRole: "provider", fhir: empty as any }), serviceFhir: new ResultsFhir() as any }, { authHeader: "Bearer synthetic", params: { encounterId: "e1" } });
  assert.deepEqual(reply.body, { recorded: false });
  assert.equal(empty.searches.filter(row => row.type === "Media" || row.type === "DiagnosticReport").length, 0);
});

test("S3c2c2a1 G15 report pagination includes page two and refuses cycles or excess pages", async () => {
  const h = await resultFixture([retina], [retina]);
  h.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-1"));
  const reports: DiagnosticReport[] = Array.from({ length: 51 }, (_, index) => ({
    resourceType: "DiagnosticReport", id: `report-${index}`, status: "final", code: { text: "Synthetic report" },
    subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" },
    ...(index === 50 ? { conclusion: "Interpreted on page two", basedOn: [{ reference: "ServiceRequest/sr-1" }] } : {}),
  }));
  const search = h.staff.search.bind(h.staff);
  h.staff.search = async <T extends Resource>(type: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>> => type === "DiagnosticReport"
    ? { resourceType: "Bundle", type: "searchset", entry: reports.slice(0, 50).map(resource => ({ resource: resource as T })), link: [{ relation: "next", url: "/fhir/R4/DiagnosticReport?_page=2" }] }
    : search<T>(type, params);
  let pages = 0;
  const client = h.staff as ResultsFhir & { searchUrl?: <T extends Resource>(url: string, type: T["resourceType"]) => Promise<Bundle<T>> };
  client.searchUrl = async <T extends Resource>(url: string, type: T["resourceType"]): Promise<Bundle<T>> => {
    pages += 1;
    assert.equal(type, "DiagnosticReport");
    assert.equal(url, "/fhir/R4/DiagnosticReport?_page=2");
    return { resourceType: "Bundle", type: "searchset", entry: [{ resource: reports[50] as T }] };
  };
  assert.equal(resultRows(await h.get())[0]!.result?.status, "interpreted");
  assert.equal(pages, 1);
  for (const mode of ["cycle", "limit", "missing"] as const) {
    pages = 0;
    client.searchUrl = mode === "missing" ? undefined : async <T extends Resource>(): Promise<Bundle<T>> => {
      pages += 1;
      if (pages > 100) throw new Error("Fixture runaway ceiling");
      return { resourceType: "Bundle", type: "searchset", link: [{ relation: "next", url: `/fhir/R4/DiagnosticReport?_page=${mode === "cycle" ? 2 : pages + 2}` }] };
    };
    const reply = await h.get();
    assert.equal(reply.status, 502);
    assert.equal("rows" in (reply.body as object), false);
    assert.equal(pages, mode === "cycle" ? 1 : mode === "limit" ? 99 : 0);
  }
});

test("S3c2c2a1 G16 committed link and unlink acknowledge failed refresh and retain truthful retry refusal", async () => {
  for (const action of ["link", "unlink"] as const) {
    for (const failure of ["queue", "results"] as const) {
      const h = await resultFixture([retina], [retina]);
      h.staff.resources.push(image("photo-1", "fundus-photo", "e1", action === "unlink" ? "ServiceRequest/sr-1" : undefined));
      const update = h.staff.update.bind(h.staff);
      h.staff.update = async <T extends Resource>(type: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> => {
        const saved = await update(type, id, resource, headers);
        if (failure === "queue") h.service.failSearchType = "Basic";
        else h.staff.failSearchType = "DiagnosticReport";
        return saved;
      };
      const reply = await h.mutate("fundus-photography", "retina", "Media/photo-1", action);
      assert.deepEqual(reply, { status: 200, body: { committed: true, reloadRequired: true } });
      const stored = await h.staff.read<Media>("Media", "photo-1");
      assert.deepEqual(stored.basedOn, action === "link" ? [{ reference: "ServiceRequest/sr-1" }] : undefined);
      assert.equal(h.staff.writes.length, 1);
      h.service.failSearchType = undefined;
      h.staff.failSearchType = undefined;
      const retry = await h.mutate("fundus-photography", "retina", "Media/photo-1", action);
      assert.equal(retry.status, 409);
      assert.equal(h.staff.writes.length, 1);
    }
  }
});


test("S3c2c2a2 G1 dead links recover as candidates, review hints and relinkable results", async () => {
  for (const state of ["removed", "cancelled", "unknown"] as const) {
    const h = await resultFixture();
    h.staff.resources.push(image("photo-1", "fundus-photo", "e1", state === "unknown" ? "ServiceRequest/other" : "ServiceRequest/sr-2"));
    const old = buildProtocolBasic(planAction(retina, "sr-2"), PROTOCOL_BASIC_CODES.planActionInstance);
    const index = h.staff.resources.findIndex(resource => resource.resourceType === "Basic" && resource.identifier?.[0]?.value === old.identifier?.[0]?.value);
    h.staff.resources[index] = buildProtocolBasic({ ...planAction(retina, "sr-2"), state: "removed" }, PROTOCOL_BASIC_CODES.planActionInstance);
    (h.staff.resources.find(resource => resource.resourceType === "ServiceRequest" && resource.id === "sr-2") as ServiceRequest).status = "revoked";
    assert.equal(resultRows(await h.get())[1]!.unreviewedResult, true);
    if (state !== "unknown") h.staff.resources[index] = buildProtocolBasic({ ...planAction(retina, "sr-2"), state }, PROTOCOL_BASIC_CODES.planActionInstance);
    h.staff.resources.push(buildProtocolBasic(planAction(retina, "sr-new"), PROTOCOL_BASIC_CODES.planActionInstance), serviceRequest(retina, "sr-new"));
    const before = resultRows(await h.get());
    assert.equal(before[1]!.result?.candidates.length, 1);
    assert.equal(before[1]!.result?.items.length, 0);
    const after = resultRows(await h.mutate(retina.orderable, retina.focus, "Media/photo-1", "link"));
    assert.equal(after[1]!.result?.status, "needs-interpretation");
    assert.deepEqual((await h.staff.read<Media>("Media", "photo-1")).basedOn, [{ reference: "ServiceRequest/sr-new" }]);
  }
});

test("S3c2c2a2 G2 results carry each row's order reference and registry category", async () => {
  const h = await resultFixture([optic, retina, field]);
  const reply = await h.get();
  assert.equal(reply.status, 200);
  const rows = (reply.body as any).rows;
  assert.deepEqual(rows.map((row: any) => [row.result.orderReference, row.result.category]), [
    ["ServiceRequest/sr-1", "fundus-photo"], ["ServiceRequest/sr-2", "fundus-photo"], ["ServiceRequest/sr-3", "visual-field"],
  ]);
});

test("S3c2c2a2 G3 empty and whitespace report conclusions do not interpret a result", async () => {
  for (const conclusion of [undefined, "", "   \n\t"]) {
    const h = await resultFixture([retina]);
    h.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-1"));
    h.staff.resources.push({ resourceType: "DiagnosticReport", id: "blank-report", status: "final", code: { text: "Synthetic report" },
      subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" }, basedOn: [{ reference: "ServiceRequest/sr-1" }], conclusion });
    assert.equal(resultRows(await h.get())[0]!.result?.status, "needs-interpretation");
  }
});

test("S3c2c2a2 G4 revoked ServiceRequest refuses linking without writes", async () => {
  const h = await resultFixture([retina]);
  (h.staff.resources.find(resource => resource.resourceType === "ServiceRequest") as ServiceRequest).status = "revoked";
  h.staff.resources.push(image());
  const before = structuredClone(h.staff.resources);
  const reply = await h.mutate(retina.orderable, retina.focus, "Media/photo-1", "link");
  assert.equal(reply.status, 409);
  assert.equal((reply.body as any).code, "result-link-refused");
  assert.equal(h.staff.writes.length, 0);
  assert.deepEqual(h.staff.resources, before);
});

test("S3c2c2a2 G5 optic nerve cannot unlink the retina row's photo", async () => {
  const h = await resultFixture();
  h.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-2"));
  const before = await h.staff.read<Media>("Media", "photo-1");
  const reply = await h.mutate(optic.orderable, optic.focus, "Media/photo-1", "unlink");
  assert.equal(reply.status, 409);
  assert.equal((reply.body as any).code, "result-link-refused");
  assert.equal(h.staff.writes.length, 0);
  assert.deepEqual(await h.staff.read<Media>("Media", "photo-1"), before);
});

async function interpretationFixture(tests: ProposedExamTest[] = [optic, retina], ordered = tests) {
  const h = await resultFixture(tests, ordered);
  const transactions: Array<{ bundle: Bundle; headers?: Record<string, string> }> = [];
  (h.staff as ResultsFhir & { executeTransaction: (bundle: Bundle, headers?: Record<string, string>) => Promise<Bundle> }).executeTransaction =
    async (bundle, headers) => {
      transactions.push({ bundle: structuredClone(bundle), headers });
      if (transactions.length === 1) {
        assert.equal(bundle.entry?.length, 1);
        assert.equal(bundle.entry[0]?.request?.method, "POST");
        const report = bundle.entry[0]?.resource as DiagnosticReport;
        h.staff.resources.push({ ...structuredClone(report), id: "new-report", meta: { versionId: "1" } });
        return { resourceType: "Bundle", type: "transaction-response", entry: [
          { response: { status: "201 Created", location: "DiagnosticReport/new-report/_history/1" } },
        ] };
      }
      assert.equal(transactions.length, 2);
      const update = bundle.entry?.[0];
      assert.equal(update?.request?.method, "PUT");
      assert.equal(update?.request?.url, "DiagnosticReport/new-report");
      const index = h.staff.resources.findIndex(row => row.resourceType === "DiagnosticReport" && row.id === "new-report");
      h.staff.resources[index] = { ...structuredClone(update!.resource as DiagnosticReport), id: "new-report", meta: { versionId: "2" } };
      const provenance = bundle.entry?.[1]?.resource;
      assert.equal(provenance?.resourceType, "Provenance");
      h.staff.resources.push({ ...structuredClone(provenance), id: "new-provenance" });
      return { resourceType: "Bundle", type: "transaction-response", entry: [
        { response: { status: "200 OK", location: "DiagnosticReport/new-report/_history/2" } },
        { response: { status: "201 Created", location: "Provenance/new-provenance/_history/1" } },
      ] };
    };
  const interpret = (orderable: string, focus: string | undefined, conclusion: unknown) =>
    handleFollowUpResultRequest(h.deps, { authHeader: "Bearer synthetic", params: { encounterId: "e1" },
      body: { action: "interpret", orderable, ...(focus ? { focus } : {}), conclusion } });
  return { ...h, transactions, interpret };
}

test("S3c2c2b1 G1 staff cannot interpret a linked photo and writes nothing", async () => {
  const h = await interpretationFixture();
  h.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-2"));
  h.deps.authenticate = async () => ({ staffReference: "Practitioner/staff1", actorRole: "staff", fhir: h.staff as any });
  const reply = await h.interpret(optic.orderable, optic.focus, "Reviewed");
  assert.equal(reply.status, 403);
  assert.deepEqual(reply.body, { code: "interpretation-requires-signer", error: "Only a doctor can save an interpretation." });
  assert.equal(h.transactions.length, 0);
  assert.equal(h.staff.writes.length, 0);
});

test("S3c2c2b1 G2 provider creates preliminary then attests final with Provenance", async () => {
  const h = await interpretationFixture();
  h.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-2"));
  const reply = await h.interpret(retina.orderable, retina.focus, "  Healthy retina  ");
  assert.equal(reply.status, 200);
  assert.equal(h.transactions.length, 2);
  const { bundle: create, headers } = h.transactions[0]!;
  assert.equal(create.type, "transaction");
  assert.equal(headers?.["X-ODOS-Source"], "mcp/follow-up-interpretation");
  assert.deepEqual(create.entry?.map(entry => entry.request), [{ method: "POST", url: "DiagnosticReport" }]);
  const preliminary = create.entry?.[0]?.resource as DiagnosticReport;
  assert.equal(preliminary.status, "preliminary");
  const { bundle: attest } = h.transactions[1]!;
  assert.deepEqual(attest.entry?.map(entry => entry.request), [
    { method: "PUT", url: "DiagnosticReport/new-report", ifMatch: 'W/"1"' }, { method: "POST", url: "Provenance" },
  ]);
  const report = attest.entry?.[0]?.resource as DiagnosticReport;
  assert.equal(report.status, "final");
  assert.equal(report.conclusion, "Healthy retina");
  assert.deepEqual(report.basedOn?.map(item => item.reference), ["ServiceRequest/sr-2"]);
  assert.deepEqual(report.media?.map(item => item.link.reference), ["Media/photo-1"]);
  assert.deepEqual(report.resultsInterpreter?.map(item => item.reference), ["Practitioner/synthetic"]);
  assert.equal(attest.entry?.[1]?.resource?.resourceType, "Provenance");
  assert.deepEqual((attest.entry?.[1]?.resource as { target: Array<{ reference?: string }> }).target.map(item => item.reference),
    ["DiagnosticReport/new-report", "Patient/p1"]);
  assert.deepEqual((attest.entry?.[1]?.resource as { agent: Array<{ who: { reference?: string } }> }).agent.map(item => item.who.reference),
    ["Practitioner/synthetic"]);
  assert.deepEqual(resultRows(reply).map(row => row.result?.status), ["interpreted", "interpreted"]);
});

test("S3c2c2b1 G3 optic-row API interpretation covers both photo rows but not visual field", async () => {
  const h = await interpretationFixture([optic, retina, field]);
  h.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-2"));
  h.staff.resources.push(image("field-1", "visual-field", "e1", "ServiceRequest/sr-3"));
  const before = resultRows(await h.get());
  assert.deepEqual(before.map(row => row.result?.status), ["none", "needs-interpretation", "needs-interpretation"]);
  const reply = await h.interpret(optic.orderable, optic.focus, "Review complete");
  assert.equal(reply.status, 200);
  assert.deepEqual(resultRows(reply).map(row => row.result?.status), ["interpreted", "interpreted", "needs-interpretation"]);
});

test("S3c2c2b1 G4 only final amended corrected reports interpret; preliminary becomes draft", async () => {
  for (const status of ["preliminary", "final", "amended", "corrected", "entered-in-error", "cancelled"] as const) {
    const h = await interpretationFixture([retina]);
    h.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-1"));
    h.staff.resources.push({ resourceType: "DiagnosticReport", id: "report-1", status, code: { text: "Synthetic" },
      subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" },
      basedOn: [{ reference: "ServiceRequest/sr-1" }], conclusion: "  Readable  ", issued: at } as DiagnosticReport);
    const row = (await h.get()).body as { rows: Array<{ result: { status: string; draftConclusion?: string } }> };
    assert.equal(row.rows[0]!.result.status, ["final", "amended", "corrected"].includes(status) ? "interpreted" : "needs-interpretation", status);
    assert.equal(row.rows[0]!.result.draftConclusion, status === "preliminary" ? "Readable" : undefined, status);
  }
});

test("S3c2c2b1 G5 invalid, finished, absent-result, non-image and repeated interpretations write nothing", async () => {
  for (const conclusion of ["", "  ", "x".repeat(5001)]) {
    const h = await interpretationFixture([retina]);
    h.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-1"));
    assert.equal((await h.interpret(retina.orderable, retina.focus, conclusion)).status, 400);
    assert.equal(h.transactions.length, 0);
  }
  const finished = await interpretationFixture([retina]);
  (finished.staff.resources[0] as { status: string }).status = "finished";
  assert.equal((await finished.interpret(retina.orderable, retina.focus, "Read")).status, 409);
  assert.equal(finished.transactions.length, 0);
  const absent = await interpretationFixture([retina]);
  const absentReply = await absent.interpret(retina.orderable, retina.focus, "Read");
  assert.equal(absentReply.status, 409);
  assert.equal((absentReply.body as { code: string }).code, "interpretation-refused");
  assert.equal(absent.transactions.length, 0);
  absent.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-1"));
  (absent.staff.resources.find(row => row.resourceType === "ServiceRequest") as ServiceRequest).status = "revoked";
  assert.equal((await absent.interpret(retina.orderable, retina.focus, "Read")).status, 409);
  assert.equal(absent.transactions.length, 0);
  const nonImage = await interpretationFixture([gonio]);
  assert.equal((await nonImage.interpret(gonio.orderable, gonio.focus, "Read")).status, 409);
  assert.equal(nonImage.transactions.length, 0);
  const repeated = await interpretationFixture([retina]);
  repeated.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-1"));
  assert.equal((await repeated.interpret(retina.orderable, retina.focus, "Read")).status, 200);
  const again = await repeated.interpret(retina.orderable, retina.focus, "Read again");
  assert.equal(again.status, 409);
  assert.equal((again.body as { code: string }).code, "already-interpreted");
  assert.equal(repeated.transactions.length, 2);
});

test("S3c2c2b1 G5 transaction conflicts map to concurrent-edit and other failures do not become success", async () => {
  for (const status of [409, 412, 500]) {
    const h = await interpretationFixture([retina]);
    h.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-1"));
    (h.staff as ResultsFhir & { executeTransaction: (bundle: Bundle) => Promise<Bundle> }).executeTransaction =
      async () => { throw Object.assign(new Error("Synthetic transaction refusal"), { status }); };
    const reply = await h.interpret(retina.orderable, retina.focus, "Read");
    assert.equal(reply.status, status === 500 ? 502 : 409);
    if (status !== 500) assert.equal((reply.body as { code?: string }).code, "concurrent-edit");
    assert.equal(h.staff.writes.length, 0);
  }
});

test("S3c2c2b1 G11 an entry-level 403 inside HTTP 200 cannot claim interpretation success", async () => {
  const h = await interpretationFixture([retina]);
  h.staff.resources.push(image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-1"));
  const fhir = h.staff as ResultsFhir & { executeTransaction: (bundle: Bundle) => Promise<Bundle> };
  const original = fhir.executeTransaction.bind(fhir);
  let calls = 0;
  fhir.executeTransaction = async bundle => {
    calls++;
    if (calls === 1) return original(bundle);
    return { resourceType: "Bundle", type: "transaction-response", entry: [
      { response: { status: "403 Forbidden", location: "DiagnosticReport/new-report/_history/2" } },
      { response: { status: "201 Created", location: "Provenance/new-provenance/_history/1" } },
    ] };
  };
  const reply = await h.interpret(retina.orderable, retina.focus, "Review complete");
  assert.equal(reply.status, 502);
  assert.equal((h.staff.resources.find(row => row.resourceType === "DiagnosticReport") as DiagnosticReport).status, "preliminary");
  assert.equal(calls, 2);
});
