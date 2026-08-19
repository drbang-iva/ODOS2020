import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, CarePlan, Encounter, EpisodeOfCare, PlanDefinition, Procedure, Resource } from "@medplum/fhirtypes";
import express from "express";
import {
  FhirSeriesProtocolDefinitionStore,
  buildSeriesActivityDefinition,
  buildSeriesPlanDefinition,
  parseSeriesProtocolPlanDefinition,
  type SeriesProtocolDefinitionDraft,
} from "../src/series-tracker/protocol-definition-store.js";
import {
  buildSeriesCarePlan,
  buildSeriesTrackerView,
  completeNextSeriesSession,
} from "../src/series-tracker/series-care-plan.js";
import { registerSeriesTrackerRoutes } from "../src/series-tracker/series-tracker-endpoint.js";
import {
  buildProcedureDefinitionSeeds,
  DRY_EYE_PROCEDURE_STABLE_KEYS,
} from "../src/clinical-graph/procedure-definition-store.js";
import { SERIES_PROCEDURE_TYPE_SYSTEM } from "../src/series-tracker/protocol-definition-store.js";

const draft: SeriesProtocolDefinitionDraft = {
  name: "Dry-Eye IPL",
  eligibleProcedureTypeCodes: ["IPL"],
  sessionCount: 4,
  intervalMinDays: 21,
  intervalMaxDays: 28,
  maintenanceAfter: true,
};

test("protocol definition uses standard PlanDefinition and ActivityDefinition fields", () => {
  const recordedAt = "2026-07-01T15:00:00.000Z";
  const activity = buildSeriesActivityDefinition("ipl-4", draft, recordedAt);
  const plan = buildSeriesPlanDefinition("ipl-4", draft, activity.url!, recordedAt);
  const parsed = parseSeriesProtocolPlanDefinition(plan);

  assert.equal(activity.kind, "ServiceRequest");
  assert.deepEqual(activity.code?.coding?.map((coding) => coding.code), ["IPL"]);
  assert.equal(activity.extension, undefined);
  assert.equal(plan.action?.length, 4);
  assert.equal(plan.action?.[1]?.relatedAction?.[0]?.offsetRange?.low?.value, 21);
  assert.equal(plan.action?.[1]?.relatedAction?.[0]?.offsetRange?.high?.value, 28);
  assert.equal(plan.extension, undefined);
  assert.equal(parsed.maintenanceAfter, true);
  assert.equal(parsed.activityDefinitionCanonical, activity.url);
});

test("FHIR protocol store writes the template pair atomically without a SQL definition table", async () => {
  const plans: PlanDefinition[] = [];
  const transactions: Bundle[] = [];
  const store = new FhirSeriesProtocolDefinitionStore({
    async search<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: plans.map((resource) => ({ resource: resource as T })) };
    },
    async executeTransaction(bundle: Bundle): Promise<Bundle> {
      transactions.push(bundle);
      const plan = bundle.entry?.find((entry) => entry.resource?.resourceType === "PlanDefinition")?.resource as PlanDefinition;
      plans.splice(0, plans.length, { ...plan, id: "plan-1" });
      return { resourceType: "Bundle", type: "transaction-response" };
    },
  }, () => "2026-07-01T15:00:00.000Z");

  const saved = await store.save(draft);
  assert.equal(saved.name, "Dry-Eye IPL");
  assert.equal(transactions.length, 1);
  assert.deepEqual(transactions[0]?.entry?.map((entry) => entry.resource?.resourceType), [
    "ActivityDefinition",
    "PlanDefinition",
  ]);
  assert.ok(transactions[0]?.entry?.every((entry) => entry.request?.method === "PUT"));

  const archived = await store.archive(saved.id);
  assert.equal(archived?.active, false);
  assert.equal(transactions.length, 2);
  assert.ok(transactions[1]?.entry?.every((entry) => entry.request?.method === "PUT"));
  assert.equal(
    transactions[1]?.entry?.find((entry) => entry.resource?.resourceType === "PlanDefinition")?.resource?.status,
    "retired",
  );
  await assert.rejects(
    store.save({ ...draft, id: saved.id }),
    /Archived protocol definitions cannot be edited/,
  );
});

test("CarePlan prescription has undated planned sessions and sign-off computes a due range from the actual Procedure date", () => {
  const activity = buildSeriesActivityDefinition("ipl-4", draft, "2026-07-01T15:00:00.000Z");
  const protocol = parseSeriesProtocolPlanDefinition(
    buildSeriesPlanDefinition("ipl-4", draft, activity.url!, "2026-07-01T15:00:00.000Z"),
  );
  const prescribed = buildSeriesCarePlan({
    protocol,
    patientReference: "Patient/test-patient",
    authorReference: "Practitioner/test-provider",
    created: "2026-07-01T15:00:00.000Z",
  });
  assert.equal(prescribed.period, undefined);
  assert.equal(prescribed.activity?.[0]?.detail?.scheduledTiming, undefined);
  assert.deepEqual(prescribed.activity?.[1]?.detail?.scheduledTiming?.repeat, {
    frequency: 1,
    period: 21,
    periodMax: 28,
    periodUnit: "d",
  });

  const completed = completeNextSeriesSession({
    carePlan: { ...prescribed, id: "care-plan-1" },
    procedure: {
      resourceType: "Procedure",
      id: "procedure-1",
      status: "in-progress",
      code: { coding: [{ code: "IPL" }] },
      subject: { reference: "Patient/test-patient" },
      performedDateTime: "2026-07-07T16:00:00.000Z",
    },
    patientReference: "Patient/test-patient",
    completedAt: "2026-07-07T16:05:00.000Z",
  });
  assert.equal(completed.procedure.status, "completed");
  assert.deepEqual(completed.procedure.basedOn, [{ reference: "CarePlan/care-plan-1" }]);
  assert.equal(completed.carePlan.activity?.[0]?.detail?.status, "completed");
  assert.deepEqual(completed.carePlan.activity?.[0]?.outcomeReference, [{ reference: "Procedure/procedure-1" }]);
  assert.deepEqual(completed.prompt?.dueWindow, {
    start: "2026-07-28",
    end: "2026-08-04",
    minWeeks: 3,
    maxWeeks: 4,
  });

  const view = buildSeriesTrackerView(completed.carePlan, [completed.procedure]);
  assert.equal(view.sessions[0]?.actualDate, "2026-07-07T16:00:00.000Z");
  assert.equal(view.sessions[1]?.status, "next");
  assert.deepEqual(view.sessions[1]?.dueWindow, completed.prompt?.dueWindow);
  assert.equal(view.sessions[2]?.status, "future");
});

test("HTTP flow defines a protocol, prescribes it to a test patient, and signs its first Procedure", async () => {
  const plans: PlanDefinition[] = [];
  let prescribed: CarePlan | undefined;
  let signedTransaction: Bundle | undefined;
  const procedure: Procedure = {
    resourceType: "Procedure",
    id: "procedure-1",
    status: "in-progress",
    code: { coding: [{ code: "IPL" }] },
    subject: { reference: "Patient/test-patient" },
    encounter: { reference: "Encounter/encounter-1" },
    performedDateTime: "2026-07-07T16:00:00.000Z",
  };
  const serviceFhir = {
    async search<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: plans.map((resource) => ({ resource: resource as T })) };
    },
    async executeTransaction(bundle: Bundle): Promise<Bundle> {
      const plan = bundle.entry?.find((entry) => entry.resource?.resourceType === "PlanDefinition")?.resource as PlanDefinition;
      plans.splice(0, plans.length, { ...plan, id: "plan-1" });
      return { resourceType: "Bundle", type: "transaction-response" };
    },
  };
  const staffFhir = {
    async read<T extends Resource>(): Promise<T> {
      return {
        resourceType: "Encounter",
        id: "encounter-1",
        status: "finished",
        class: { code: "AMB" },
        subject: { reference: "Patient/test-patient" },
      } as Encounter as T;
    },
    async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
      const resources = resourceType === "CarePlan" && prescribed
        ? [prescribed]
        : resourceType === "Procedure" ? [procedure] : [];
      return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource: resource as T })) };
    },
    async create<T extends Resource>(resource: T): Promise<T> {
      prescribed = { ...resource as CarePlan, id: "care-plan-1" };
      return prescribed as T;
    },
    async executeTransaction(bundle: Bundle): Promise<Bundle> {
      signedTransaction = bundle;
      return { resourceType: "Bundle", type: "transaction-response" };
    },
  };
  const app = express();
  app.use(express.json());
  registerSeriesTrackerRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({
      staffReference: "Practitioner/provider-1",
      actorRole: "admin",
      roles: ["admin", "provider"],
      fhir: staffFhir as never,
    }),
    serviceFhir: serviceFhir as never,
    now: () => "2026-07-07T16:05:00.000Z",
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
  try {
    const defined = await fetch(`http://127.0.0.1:${port}/series-tracker/protocols`, {
      method: "POST",
      headers,
      body: JSON.stringify(draft),
    });
    assert.equal(defined.status, 200);
    const protocolId = (await defined.json() as { protocol: { id: string } }).protocol.id;

    const prescribedResponse = await fetch(`http://127.0.0.1:${port}/series-tracker/patients/test-patient/care-plans`, {
      method: "POST",
      headers,
      body: JSON.stringify({ protocolId }),
    });
    assert.equal(prescribedResponse.status, 201);
    assert.equal(prescribed?.subject?.reference, "Patient/test-patient");
    assert.equal(prescribed?.activity?.length, 4);

    const signed = await fetch(`http://127.0.0.1:${port}/series-tracker/encounters/encounter-1/sign-off`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(signed.status, 200);
    const signedBody = await signed.json() as { updatedProcedureCount: number; prompt: { dueWindow: { start: string; end: string } } };
    assert.equal(signedBody.updatedProcedureCount, 1);
    assert.deepEqual(signedBody.prompt.dueWindow, { start: "2026-07-28", end: "2026-08-04", minWeeks: 3, maxWeeks: 4 });
    assert.deepEqual(signedTransaction?.entry?.map((entry) => entry.resource?.resourceType), ["Procedure", "CarePlan"]);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("Dry Eye sheet round-trip conditionally creates one canonical CarePlan and one bound session", async () => {
  const dryEyeDraft: SeriesProtocolDefinitionDraft = {
    id: "dry-eye-ipl",
    name: "IPL",
    eligibleProcedureTypeCodes: [DRY_EYE_PROCEDURE_STABLE_KEYS.ipl],
    sessionCount: 4,
    intervalMinDays: 21,
    intervalMaxDays: 28,
    maintenanceAfter: true,
  };
  const recordedAt = "2026-08-19T15:00:00.000Z";
  const activity = buildSeriesActivityDefinition("dry-eye-ipl", dryEyeDraft, recordedAt);
  const plan = buildSeriesPlanDefinition("dry-eye-ipl", dryEyeDraft, activity.url!, recordedAt);
  const resources: Resource[] = [{
    resourceType: "EpisodeOfCare",
    id: "dry-eye-program",
    status: "active",
    patient: { reference: "Patient/test-patient" },
  } satisfies EpisodeOfCare, {
    resourceType: "Encounter",
    id: "encounter-1",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/test-patient" },
    episodeOfCare: [{ reference: "EpisodeOfCare/dry-eye-program" }],
  } satisfies Encounter, {
    resourceType: "Encounter",
    id: "encounter-2",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/test-patient" },
    episodeOfCare: [{ reference: "EpisodeOfCare/dry-eye-program" }],
  } satisfies Encounter];
  let nextId = 1;
  let procedureDefinitionsAvailable = true;
  const staffFhir = {
    async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
      const resource = resources.find((candidate) => candidate.resourceType === resourceType && candidate.id === id);
      if (!resource) throw new Error(`${resourceType}/${id} not found`);
      return structuredClone(resource) as T;
    },
    async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
      const matches = resources.filter((resource) => {
        if (resource.resourceType !== resourceType) return false;
        if (params.subject && "subject" in resource && resource.subject?.reference !== params.subject) return false;
        if (params.patient && "patient" in resource && resource.patient?.reference !== params.patient) return false;
        if (params.code && resource.resourceType === "Procedure"
          && !resource.code?.coding?.some((coding) => coding.code === params.code)) return false;
        if (params["based-on"] && resource.resourceType === "Procedure"
          && !resource.basedOn?.some((reference) => reference.reference === params["based-on"])) return false;
        return true;
      });
      return { resourceType: "Bundle", type: "searchset", entry: matches.map((resource) => ({ resource: structuredClone(resource) as T })) };
    },
    async create<T extends Resource>(resource: T, headers: Record<string, string> = {}): Promise<T> {
      const conditional = headers["If-None-Exist"]?.match(/^identifier=([^|]+)\|(.+)$/);
      const existing = conditional && resources.find((candidate) =>
        "identifier" in candidate && candidate.identifier?.some((identifier) =>
          identifier.system === conditional[1] && identifier.value === conditional[2]
        )
      );
      if (existing) return structuredClone(existing) as T;
      const saved = { ...structuredClone(resource), id: `${resource.resourceType.toLowerCase()}-${nextId++}` } as T;
      resources.push(saved);
      return structuredClone(saved);
    },
    async executeTransaction(bundle: Bundle): Promise<Bundle> {
      for (const entry of bundle.entry ?? []) {
        if (entry.request?.method !== "PUT" || !entry.resource?.id) continue;
        const index = resources.findIndex((resource) =>
          resource.resourceType === entry.resource?.resourceType && resource.id === entry.resource.id
        );
        if (index >= 0) resources[index] = structuredClone(entry.resource);
      }
      return { resourceType: "Bundle", type: "transaction-response" };
    },
  };
  const app = express();
  app.use(express.json());
  registerSeriesTrackerRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({
      staffReference: "Practitioner/provider-1",
      actorRole: "provider",
      roles: ["provider"],
      fhir: staffFhir as never,
    }),
    serviceFhir: {
      async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
        const definitions = resourceType === "PlanDefinition" ? [plan] : [];
        return { resourceType: "Bundle", type: "searchset", entry: definitions.map((resource) => ({ resource: resource as T })) };
      },
    } as never,
    procedureDefinitions: async () => procedureDefinitionsAvailable ? buildProcedureDefinitionSeeds() : [],
    now: () => recordedAt,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}/series-tracker/encounters/encounter-1/series/dry-eye-ipl`;
  const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
  try {
    procedureDefinitionsAvailable = false;
    const unavailableDefinition = await fetch(endpoint, { method: "POST", headers, body: "{}" });
    assert.equal(unavailableDefinition.status, 409);
    assert.equal(resources.some((resource) => ["CarePlan", "Procedure"].includes(resource.resourceType)), false);
    procedureDefinitionsAvailable = true;

    const first = await fetch(endpoint, { method: "POST", headers, body: "{}" });
    assert.equal(first.status, 201);
    const second = await fetch(endpoint, { method: "POST", headers, body: "{}" });
    assert.equal(second.status, 200);
    const hydrated = await fetch(endpoint, { headers });
    assert.equal(hydrated.status, 200);
    const body = await hydrated.json() as {
      series: { title: string; sessions: Array<{ number: number; status: string }> };
      currentSession: { number: number; total: number; procedureReference: string };
      remainingSessions: number;
    };
    assert.equal(body.series.title, "IPL");
    assert.deepEqual(body.currentSession, {
      number: 1,
      total: 4,
      procedureReference: "Procedure/procedure-2",
    });
    assert.equal(body.remainingSessions, 3);
    assert.equal(resources.filter((resource) => resource.resourceType === "CarePlan").length, 1);
    const procedures = resources.filter((resource): resource is Procedure => resource.resourceType === "Procedure");
    assert.equal(procedures.length, 1);
    assert.deepEqual(procedures[0]?.basedOn, [{ reference: "CarePlan/careplan-1" }]);
    assert.deepEqual(procedures[0]?.code?.coding?.[0], {
      system: SERIES_PROCEDURE_TYPE_SYSTEM,
      code: DRY_EYE_PROCEDURE_STABLE_KEYS.ipl,
      display: "IPL (OptiLight-class)",
    });

    const otherEncounter = endpoint.replace("encounter-1", "encounter-2");
    const crossEncounter = await fetch(otherEncounter, { headers });
    assert.equal(crossEncounter.status, 200);
    assert.deepEqual(await crossEncounter.json(), {
      series: body.series,
      currentSession: null,
      remainingSessions: 3,
    });

    const sameProgram = await fetch(otherEncounter, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(sameProgram.status, 409);
    assert.match((await sameProgram.json() as { error: string }).error, /active session in another encounter/);
    assert.equal(resources.filter((resource) => resource.resourceType === "CarePlan").length, 1);
    assert.equal(resources.filter((resource) => resource.resourceType === "Procedure").length, 1);

    procedures[0]!.status = "completed";
    const betweenSessionsCarePlan = resources.find((resource): resource is CarePlan =>
      resource.resourceType === "CarePlan"
    );
    assert.ok(betweenSessionsCarePlan?.activity?.[0]?.detail);
    betweenSessionsCarePlan.activity[0].detail.status = "completed";
    betweenSessionsCarePlan.activity[0].outcomeReference = [{ reference: `Procedure/${procedures[0]!.id}` }];
    const betweenSessions = await fetch(endpoint, { headers });
    assert.equal(betweenSessions.status, 200);
    const betweenSessionsBody = await betweenSessions.json() as {
      currentSession: null;
      remainingSessions: number;
    };
    assert.equal(betweenSessionsBody.currentSession, null);
    assert.equal(betweenSessionsBody.remainingSessions, 3);

    const beforeMissing = resources.length;
    const missing = await fetch(endpoint.replace("dry-eye-ipl", "missing-protocol"), {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(missing.status, 409);
    assert.equal(resources.length, beforeMissing);

    for (let index = resources.length - 1; index >= 0; index -= 1) {
      if (["CarePlan", "Procedure"].includes(resources[index]!.resourceType)) resources.splice(index, 1);
    }
    resources.push({
      resourceType: "Encounter",
      id: "encounter-other-program",
      status: "in-progress",
      class: { code: "AMB" },
      subject: { reference: "Patient/test-patient" },
      episodeOfCare: [{ reference: "EpisodeOfCare/other-program" }],
    } satisfies Encounter, {
      resourceType: "Procedure",
      id: "legacy-parent",
      status: "in-progress",
      subject: { reference: "Patient/test-patient" },
      encounter: { reference: "Encounter/encounter-1" },
      code: { coding: [{ code: "IPL" }] },
      note: [{ text: "4-session dry-eye treatment series" }],
    } satisfies Procedure, {
      resourceType: "Procedure",
      id: "legacy-session",
      status: "in-progress",
      subject: { reference: "Patient/test-patient" },
      encounter: { reference: "Encounter/encounter-1" },
      code: { coding: [{ code: "IPL" }] },
      partOf: [{ reference: "Procedure/legacy-parent" }],
      identifier: [{ system: "https://odos2020.com/fhir/Identifier/dry-eye-treatment-session", value: "1-of-4" }],
    } satisfies Procedure, {
      resourceType: "Procedure",
      id: "legacy-session-other-program",
      status: "in-progress",
      subject: { reference: "Patient/test-patient" },
      encounter: { reference: "Encounter/encounter-other-program" },
      code: { coding: [{ code: "IPL" }] },
      partOf: [{ reference: "Procedure/legacy-parent" }],
    } satisfies Procedure);

    const adoptedResponse = await fetch(endpoint, { method: "POST", headers, body: "{}" });
    assert.equal(adoptedResponse.status, 201);
    const adopted = resources.find((resource): resource is Procedure =>
      resource.resourceType === "Procedure" && resource.id === "legacy-session"
    );
    const adoptedCarePlan = resources.find((resource): resource is CarePlan => resource.resourceType === "CarePlan");
    assert.deepEqual(adopted?.basedOn, [{ reference: `CarePlan/${adoptedCarePlan?.id}` }]);
    assert.equal(adopted?.code?.coding?.[0]?.code, "IPL", "adoption preserves the historical clinical code");
    const otherProgramSession = resources.find((resource): resource is Procedure =>
      resource.resourceType === "Procedure" && resource.id === "legacy-session-other-program"
    );
    assert.equal(otherProgramSession?.basedOn, undefined);

    resources.push({
      resourceType: "Procedure",
      id: "legacy-parent-duplicate",
      status: "in-progress",
      subject: { reference: "Patient/test-patient" },
      encounter: { reference: "Encounter/encounter-1" },
      code: { coding: [{ code: "IPL" }] },
      note: [{ text: "4-session dry-eye treatment series" }],
    } satisfies Procedure);
    const conflict = await fetch(endpoint, { headers });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json() as { error: string }).error, /2 legacy IPL series conflict/);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("Dry Eye session creation fails closed when the legacy Procedure result is truncated", async () => {
  await withDryEyeEncounterRoute({
    procedureSearch: () => ({
      resourceType: "Bundle",
      type: "searchset",
      total: 2,
      entry: [{ resource: unrelatedProcedure("unrelated-1") }],
    }),
  }, async ({ endpoint, headers, created }) => {
    const response = await fetch(endpoint, { method: "POST", headers, body: "{}" });

    assert.equal(response.status, 409);
    assert.equal(created.length, 0);
  });
});

test("Dry Eye refuses creation when a second legacy parent is outside the first Procedure page", async () => {
  const legacyParent: Procedure = {
    resourceType: "Procedure",
    id: "legacy-parent-1",
    status: "in-progress",
    subject: { reference: "Patient/test-patient" },
    encounter: { reference: "Encounter/encounter-1" },
    code: { coding: [{ code: "IPL" }] },
    note: [{ text: "4-session dry-eye treatment series" }],
  };
  const legacySession: Procedure = {
    resourceType: "Procedure",
    id: "legacy-session-1",
    status: "in-progress",
    subject: { reference: "Patient/test-patient" },
    encounter: { reference: "Encounter/encounter-1" },
    code: { coding: [{ code: "IPL" }] },
    partOf: [{ reference: "Procedure/legacy-parent-1" }],
  };
  await withDryEyeEncounterRoute({
    procedureSearch: () => ({
      resourceType: "Bundle",
      type: "searchset",
      total: 3,
      entry: [{ resource: legacyParent }, { resource: legacySession }],
      link: [{ relation: "next", url: "https://example.test/fhir/R4/Procedure?page=2" }],
    }),
  }, async ({ endpoint, headers, created }) => {
    const response = await fetch(endpoint, { method: "POST", headers, body: "{}" });

    assert.equal(response.status, 409);
    assert.equal(created.length, 0);
  });
});

test("Dry Eye finds the active bound session when unrelated patient Procedures exceed one page", async () => {
  const { protocol } = dryEyeProtocolFixture();
  const carePlan = {
    ...buildSeriesCarePlan({
      protocol,
      patientReference: "Patient/test-patient",
      authorReference: "Practitioner/provider-1",
      created: "2026-08-19T15:00:00.000Z",
    }),
    id: "care-plan-1",
    encounter: { reference: "Encounter/encounter-1" },
  } satisfies CarePlan;
  for (let index = 0; index < 3; index += 1) {
    carePlan.activity![index]!.detail!.status = "completed";
    carePlan.activity![index]!.outcomeReference = [{ reference: `Procedure/completed-${index + 1}` }];
  }
  const boundProcedures: Procedure[] = [1, 2, 3].map((number) => ({
    resourceType: "Procedure",
    id: `completed-${number}`,
    status: "completed",
    subject: { reference: "Patient/test-patient" },
    encounter: { reference: "Encounter/encounter-1" },
    basedOn: [{ reference: "CarePlan/care-plan-1" }],
    performedDateTime: `2026-0${number + 4}-01T15:00:00.000Z`,
  }));
  boundProcedures.push({
    resourceType: "Procedure",
    id: "active-session-4",
    status: "in-progress",
    subject: { reference: "Patient/test-patient" },
    encounter: { reference: "Encounter/encounter-1" },
    basedOn: [{ reference: "CarePlan/care-plan-1" }],
    identifier: [{
      system: "https://odos2020.com/fhir/Identifier/dry-eye-treatment-session",
      value: "CarePlan/care-plan-1:4-of-4",
    }],
  });
  const unrelated = Array.from({ length: 500 }, (_, index) => unrelatedProcedure(`unrelated-${index + 1}`));
  await withDryEyeEncounterRoute({
    carePlans: [carePlan],
    existingProcedures: boundProcedures,
    procedureSearch: (params) => params["based-on"] === "CarePlan/care-plan-1"
      ? {
          resourceType: "Bundle",
          type: "searchset",
          total: boundProcedures.length,
          entry: boundProcedures.map((resource) => ({ resource })),
        }
      : params.code === "IPL"
        ? { resourceType: "Bundle", type: "searchset", total: 0 }
        : {
            resourceType: "Bundle",
            type: "searchset",
            total: unrelated.length + boundProcedures.length,
            entry: unrelated.map((resource) => ({ resource })),
            link: [{ relation: "next", url: "https://example.test/fhir/R4/Procedure?page=2" }],
          },
  }, async ({ endpoint, headers, created }) => {
    const response = await fetch(endpoint, { method: "POST", headers, body: "{}" });
    const body = await response.json() as {
      series: { sessions: Array<{ status: string }> };
      currentSession: { number: number; procedureReference: string };
      remainingSessions: number;
    };

    assert.equal(response.status, 200);
    assert.equal(body.series.sessions.filter((session) => session.status === "completed").length, 3);
    assert.deepEqual(body.currentSession, { number: 4, total: 4, procedureReference: "Procedure/active-session-4" });
    assert.equal(body.remainingSessions, 0);
    assert.equal(created.length, 0);
  });
});

test("Dry Eye refuses to create a session in a finished EpisodeOfCare program", async () => {
  await withDryEyeEncounterRoute({
    episodeStatus: "finished",
    procedureSearch: () => ({ resourceType: "Bundle", type: "searchset", total: 0 }),
  }, async ({ endpoint, headers, created }) => {
    const response = await fetch(endpoint, { method: "POST", headers, body: "{}" });

    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /active program/);
    assert.equal(created.length, 0);
  });
});

test("Dry Eye reuses the canonical CarePlan when a broad patient result would paginate", async () => {
  const { protocol } = dryEyeProtocolFixture();
  const existingCarePlan = {
    ...buildSeriesCarePlan({
      protocol,
      patientReference: "Patient/test-patient",
      authorReference: "Practitioner/provider-1",
      created: "2026-08-19T15:00:00.000Z",
    }),
    id: "existing-care-plan",
    encounter: { reference: "Encounter/encounter-1" },
  } satisfies CarePlan;
  await withDryEyeEncounterRoute({
    carePlanSearch: (params) => params["instantiates-canonical"]
      ? {
          resourceType: "Bundle",
          type: "searchset",
          total: 1,
          entry: [{ resource: existingCarePlan }],
        }
      : {
          resourceType: "Bundle",
          type: "searchset",
          total: 201,
          entry: [{ resource: { ...existingCarePlan, id: "unrelated", instantiatesCanonical: [] } }],
          link: [{ relation: "next", url: "https://example.test/fhir/R4/CarePlan?page=2" }],
        },
    procedureSearch: () => ({ resourceType: "Bundle", type: "searchset", total: 0 }),
  }, async ({ endpoint, headers, created }) => {
    const response = await fetch(endpoint, { method: "POST", headers, body: "{}" });

    assert.equal(response.status, 201);
    assert.equal(created.filter((resource) => resource.resourceType === "CarePlan").length, 0);
    assert.equal(created.filter((resource) => resource.resourceType === "Procedure").length, 1);
  });
});

test("Dry Eye fails closed when the narrowed canonical CarePlan result is truncated", async () => {
  await withDryEyeEncounterRoute({
    carePlanSearch: () => ({
      resourceType: "Bundle",
      type: "searchset",
      total: 2,
      entry: [{
        resource: {
          resourceType: "CarePlan",
          id: "care-plan-1",
          status: "active",
          intent: "plan",
          subject: { reference: "Patient/test-patient" },
        },
      }],
      link: [{ relation: "next", url: "https://example.test/fhir/R4/CarePlan?page=2" }],
    }),
    procedureSearch: () => ({ resourceType: "Bundle", type: "searchset", total: 0 }),
  }, async ({ endpoint, headers, created }) => {
    const response = await fetch(endpoint, { method: "POST", headers, body: "{}" });

    assert.equal(response.status, 409);
    assert.equal(created.length, 0);
  });
});

function dryEyeProtocolFixture() {
  const draft: SeriesProtocolDefinitionDraft = {
    id: "dry-eye-ipl",
    name: "IPL",
    eligibleProcedureTypeCodes: [DRY_EYE_PROCEDURE_STABLE_KEYS.ipl],
    sessionCount: 4,
    intervalMinDays: 21,
    intervalMaxDays: 28,
    maintenanceAfter: true,
  };
  const recordedAt = "2026-08-19T15:00:00.000Z";
  const plan = buildSeriesPlanDefinition(
    "dry-eye-ipl",
    draft,
    buildSeriesActivityDefinition("dry-eye-ipl", draft, recordedAt).url!,
    recordedAt,
  );
  return { plan, protocol: parseSeriesProtocolPlanDefinition(plan) };
}

function unrelatedProcedure(id: string): Procedure {
  return {
    resourceType: "Procedure",
    id,
    status: "completed",
    subject: { reference: "Patient/test-patient" },
    code: { coding: [{ code: "unrelated" }] },
  };
}

async function withDryEyeEncounterRoute(
  input: {
    carePlans?: CarePlan[];
    carePlanSearch?(params: Record<string, string>): Bundle<CarePlan>;
    episodeStatus?: EpisodeOfCare["status"];
    existingProcedures?: Procedure[];
    procedureSearch(params: Record<string, string>): Bundle<Procedure>;
  },
  run: (context: {
    endpoint: string;
    headers: Record<string, string>;
    created: Resource[];
  }) => Promise<void>,
): Promise<void> {
  const { plan } = dryEyeProtocolFixture();
  const created: Resource[] = [];
  const existingProcedures = input.existingProcedures ?? [];
  const staffFhir = {
    async read<T extends Resource>(resourceType: T["resourceType"]): Promise<T> {
      if (resourceType === "EpisodeOfCare") {
        return {
          resourceType: "EpisodeOfCare",
          id: "dry-eye-program",
          status: input.episodeStatus ?? "active",
          patient: { reference: "Patient/test-patient" },
        } as EpisodeOfCare as T;
      }
      return {
        resourceType: "Encounter",
        id: "encounter-1",
        status: "in-progress",
        class: { code: "AMB" },
        subject: { reference: "Patient/test-patient" },
        episodeOfCare: [{ reference: "EpisodeOfCare/dry-eye-program" }],
      } as Encounter as T;
    },
    async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
      if (resourceType === "CarePlan") {
        if (input.carePlanSearch) return structuredClone(input.carePlanSearch(params)) as Bundle<T>;
        return {
          resourceType: "Bundle",
          type: "searchset",
          total: input.carePlans?.length ?? 0,
          entry: input.carePlans?.map((resource) => ({ resource: structuredClone(resource) as T })),
        };
      }
      return structuredClone(input.procedureSearch(params)) as Bundle<T>;
    },
    async create<T extends Resource>(resource: T, headers: Record<string, string> = {}): Promise<T> {
      const conditional = headers["If-None-Exist"]?.match(/^identifier=([^|]+)\|(.+)$/);
      const existing = conditional && existingProcedures.find((candidate) =>
        candidate.identifier?.some((identifier) =>
          identifier.system === conditional[1] && identifier.value === conditional[2]
        )
      );
      if (existing) return structuredClone(existing) as T;
      const saved = { ...structuredClone(resource), id: `${resource.resourceType.toLowerCase()}-${created.length + 1}` } as T;
      created.push(saved);
      return saved;
    },
    async executeTransaction(): Promise<Bundle> {
      return { resourceType: "Bundle", type: "transaction-response" };
    },
  };
  const app = express();
  app.use(express.json());
  registerSeriesTrackerRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({
      staffReference: "Practitioner/provider-1",
      actorRole: "provider",
      roles: ["provider"],
      fhir: staffFhir as never,
    }),
    serviceFhir: {
      async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
        const definitions = resourceType === "PlanDefinition" ? [plan] : [];
        return {
          resourceType: "Bundle",
          type: "searchset",
          entry: definitions.map((resource) => ({ resource: resource as unknown as T })),
        };
      },
    } as never,
    procedureDefinitions: async () => buildProcedureDefinitionSeeds(),
    now: () => "2026-08-19T15:00:00.000Z",
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  try {
    await run({
      endpoint: `http://127.0.0.1:${port}/series-tracker/encounters/encounter-1/series/dry-eye-ipl`,
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      created,
    });
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
}
