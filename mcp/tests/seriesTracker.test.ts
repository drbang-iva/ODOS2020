import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, CarePlan, Encounter, PlanDefinition, Procedure, Resource } from "@medplum/fhirtypes";
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
      actorRole: "practice-admin",
      roles: ["practice-admin", "clinician"],
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
