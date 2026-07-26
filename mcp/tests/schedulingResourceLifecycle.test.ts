import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Appointment,
  Bundle,
  Location,
  Practitioner,
  Resource,
  Schedule,
} from "@medplum/fhirtypes";
import express from "express";
import { buildSchedulingAppointment } from "../src/fhir/schedulingAppointment.js";
import { buildSchedulingResource } from "../src/fhir/schedulingResource.js";
import { registerSchedulingResourceRoutes } from "../src/scheduling/scheduling-resource-routes.js";
import {
  SchedulingResourceInputError,
  createSchedulingResource,
  deactivateSchedulingResource,
  inspectSchedulingIntegrity,
  listRenderableSchedulingResources,
  updateSchedulingResource,
  type SchedulingResourceFhir,
} from "../src/scheduling/scheduling-resource-service.js";

class FakeSchedulingFhir implements SchedulingResourceFhir {
  readonly resources = new Map<string, Resource>();
  readonly created: Resource[] = [];
  readonly updated: Resource[] = [];
  readonly readErrors = new Map<string, Error>();

  constructor(seed: Resource[]) {
    for (const resource of seed) {
      if (resource.id) this.resources.set(`${resource.resourceType}/${resource.id}`, structuredClone(resource));
    }
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const configuredError = this.readErrors.get(`${resourceType}/${id}`);
    if (configuredError) throw configuredError;
    const resource = this.resources.get(`${resourceType}/${id}`);
    if (!resource) {
      const error = new Error(`${resourceType}/${id} not found`) as Error & { status: number };
      error.status = 404;
      throw error;
    }
    return structuredClone(resource) as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    let resources = [...this.resources.values()].filter((resource) => resource.resourceType === resourceType);
    if (params.active) {
      resources = resources.filter((resource) => (resource as Schedule).active !== false);
    }
    if (resourceType === "Appointment" && params.date?.startsWith("ge")) {
      const from = Date.parse(params.date.slice(2));
      resources = resources.filter((resource) =>
        Date.parse((resource as Appointment).start ?? "") >= from
      );
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resources.map((resource) => ({ resource: structuredClone(resource) as T })),
    };
  }

  async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
    throw new Error("No paginated result was expected.");
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    const saved = {
      ...structuredClone(resource),
      id: resource.id ?? `created-${this.created.length + 1}`,
      meta: { ...resource.meta, versionId: "1" },
    } as T;
    this.resources.set(`${saved.resourceType}/${saved.id}`, saved);
    this.created.push(saved);
    return structuredClone(saved);
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    const saved = {
      ...structuredClone(resource),
      id,
      meta: { ...resource.meta, versionId: String(Number(resource.meta?.versionId ?? "0") + 1) },
    };
    this.resources.set(`${resourceType}/${id}`, saved);
    this.updated.push(saved);
    return structuredClone(saved) as T;
  }
}

const practitioner: Practitioner = {
  resourceType: "Practitioner",
  id: "real-provider",
  active: true,
};

function schedule(
  id: string,
  actorReference: string,
  actorDisplay: string,
): Schedule {
  return {
    resourceType: "Schedule",
    id,
    meta: { versionId: "1" },
    active: true,
    actor: [{ reference: actorReference, display: actorDisplay }],
    serviceCategory: [{
      coding: [{
        system: "https://odos2020.com/fhir/CodeSystem/scheduling-discipline",
        code: "eyecare",
      }],
    }],
  };
}

function futureAppointment(id: string, actorReference: string): Appointment {
  return {
    ...buildSchedulingAppointment({
      patient: { reference: "Patient/patient-1", display: "Test Patient" },
      visitTypeCode: "routine-exam",
      discipline: "eyecare",
      resources: [{ reference: actorReference, display: "Real Provider" }],
      start: "2026-08-03T09:00:00-04:00",
      durationMinutes: 30,
    }),
    id,
    meta: { versionId: "1" },
  };
}

test("Schedule create rejects malformed and unresolved actors, while a real actor saves", async () => {
  const fhir = new FakeSchedulingFhir([practitioner]);

  await assert.rejects(
    createSchedulingResource(fhir, {
      kind: "provider",
      actorReference: "Practitioner/",
      actorDisplay: "Ghost",
      disciplines: ["eyecare"],
    }),
    /Practitioner\/<id>/,
  );
  await assert.rejects(
    createSchedulingResource(fhir, {
      kind: "provider",
      actorReference: "Practitioner/does-not-exist",
      actorDisplay: "Ghost",
      disciplines: ["eyecare"],
    }),
    (error: unknown) =>
      error instanceof SchedulingResourceInputError
      && /existing Practitioner/.test(error.message),
  );

  const saved = await createSchedulingResource(fhir, {
    kind: "provider",
    actorReference: "Practitioner/real-provider",
    actorDisplay: "Real Provider",
    disciplines: ["eyecare"],
  });
  assert.equal(saved.actor[0]?.reference, "Practitioner/real-provider");
  assert.equal(fhir.created.length, 1);
});

test("Schedule update rechecks actor existence even when the submitted resource is inactive", async () => {
  const unresolved = schedule("unresolved", "Practitioner/missing", "Missing Provider");
  unresolved.active = false;
  const fhir = new FakeSchedulingFhir([unresolved]);
  await assert.rejects(
    updateSchedulingResource(fhir, unresolved),
    /existing Practitioner/,
  );
  assert.equal(fhir.updated.length, 0);
});

test("read containment returns valid columns identically and excludes malformed or unresolved actors", async () => {
  const valid = schedule("valid", "Practitioner/real-provider", "Real Provider");
  const malformed = schedule("malformed", "Practitioner/", "Ghost Provider");
  const unresolved = schedule("unresolved", "Practitioner/missing", "Missing Provider");
  const fhir = new FakeSchedulingFhir([practitioner, valid, malformed, unresolved]);

  const result = await listRenderableSchedulingResources(fhir);
  assert.deepEqual(result.resources, [valid]);
  assert.equal(result.issues.length, 2);
  assert.deepEqual(result.issues.map((issue) => issue.actorDisplay).sort(), [
    "Ghost Provider",
    "Missing Provider",
  ]);
});

test("read containment surfaces non-404 errors containing not-found text", async () => {
  const valid = schedule("valid", "Practitioner/real-provider", "Real Provider");
  const fhir = new FakeSchedulingFhir([practitioner, valid]);
  const invalid = new Error(
    "FHIR 400 Bad Request: referenced item was not found in the submitted payload",
  ) as Error & { status: number };
  invalid.status = 400;
  fhir.readErrors.set("Practitioner/real-provider", invalid);

  await assert.rejects(
    listRenderableSchedulingResources(fhir),
    /FHIR 400 Bad Request/,
  );
});

test("deactivation requires acknowledgement for future appointments and removes a clean resource", async () => {
  const guarded = schedule("guarded", "Practitioner/real-provider", "Real Provider");
  const clean = schedule("clean", "Practitioner/real-provider", "Second Column");
  const appointment = futureAppointment("future-1", "Practitioner/real-provider");
  const fhir = new FakeSchedulingFhir([practitioner, guarded, clean, appointment]);
  const now = "2026-07-26T12:00:00-04:00";

  const blocked = await deactivateSchedulingResource(fhir, "guarded", {
    acknowledgeFutureAppointments: false,
    now,
  });
  assert.deepEqual(blocked, { deactivated: false, futureAppointmentCount: 1 });
  assert.equal((await fhir.read<Schedule>("Schedule", "guarded")).active, true);

  const acknowledged = await deactivateSchedulingResource(fhir, "guarded", {
    acknowledgeFutureAppointments: true,
    now,
  });
  assert.equal(acknowledged.deactivated, true);
  assert.equal((await fhir.read<Schedule>("Schedule", "guarded")).active, false);

  fhir.resources.delete("Appointment/future-1");
  const deactivated = await deactivateSchedulingResource(fhir, "clean", {
    acknowledgeFutureAppointments: false,
    now,
  });
  assert.equal(deactivated.deactivated, true);
  assert.equal((await fhir.read<Schedule>("Schedule", "clean")).active, false);
});

test("integrity inspection lists broken Schedule and Appointment actors without mutation", async () => {
  const malformedSchedule = schedule("malformed", "Practitioner/", "Ghost Provider");
  const malformedAppointment: Appointment = {
    ...futureAppointment("malformed-appointment", "Practitioner/real-provider"),
    participant: [
      { actor: { reference: "Patient/patient-1", display: "Test Patient" }, status: "accepted" },
      { actor: { reference: "Practitioner/", display: "Ghost Provider" }, status: "accepted" },
    ],
  };
  const patient = { resourceType: "Patient", id: "patient-1" } as const;
  const fhir = new FakeSchedulingFhir([practitioner, patient, malformedSchedule, malformedAppointment]);
  const before = JSON.stringify([...fhir.resources.entries()]);

  const issues = await inspectSchedulingIntegrity(fhir);

  assert.equal(issues.some((issue) => issue.sourceType === "Schedule"), true);
  assert.equal(issues.some((issue) => issue.sourceType === "Appointment"), true);
  assert.equal(JSON.stringify([...fhir.resources.entries()]), before);
  assert.equal(fhir.created.length, 0);
  assert.equal(fhir.updated.length, 0);
});

test("Schedule HTTP create returns a real 400 for an empty actor id and does not persist it", async () => {
  const fhir = new FakeSchedulingFhir([practitioner]);
  const app = express();
  app.use(express.json());
  registerSchedulingResourceRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({ roles: ["practice-admin"], fhir }),
    serviceFhir: fhir,
  });
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/scheduling/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        kind: "provider",
        actorReference: "Practitioner/",
        actorDisplay: "Ghost",
        disciplines: ["eyecare"],
      }),
    });
    const body = await response.json() as { error?: string };
    assert.equal(response.status, 400);
    assert.match(body.error ?? "", /Practitioner\/<id>/);
    assert.equal(fhir.created.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test("Schedule HTTP update applies create-equivalent discipline and kind validation", async () => {
  const existing = schedule("provider-column", "Practitioner/real-provider", "Real Provider");
  const location: Location = {
    resourceType: "Location",
    id: "exam-room",
    status: "active",
  };
  const fhir = new FakeSchedulingFhir([practitioner, location, existing]);
  const app = express();
  app.use(express.json());
  registerSchedulingResourceRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({ roles: ["practice-admin"], fhir }),
    serviceFhir: fhir,
  });
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const update = async (body: Schedule) => {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/scheduling/resources/provider-column`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
          body: JSON.stringify(body),
        },
      );
      return {
        status: response.status,
        body: await response.json() as { error?: string },
      };
    };

    const invalidDiscipline = structuredClone(existing);
    invalidDiscipline.serviceCategory![0]!.coding![0]!.code = "invalid";
    const disciplineResult = await update(invalidDiscipline);
    assert.equal(disciplineResult.status, 400);
    assert.match(disciplineResult.body.error ?? "", /Unknown scheduling discipline/);

    const mismatchedActor = structuredClone(existing);
    mismatchedActor.actor = [{ reference: "Location/exam-room", display: "Exam Room" }];
    const actorResult = await update(mismatchedActor);
    assert.equal(actorResult.status, 400);
    assert.match(actorResult.body.error ?? "", /provider actor.*Practitioner/i);
    assert.equal(fhir.updated.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test("Appointment builder rejects an empty-id participant actor", () => {
  assert.throws(
    () => buildSchedulingAppointment({
      patient: { reference: "Patient/patient-1" },
      visitTypeCode: "routine-exam",
      discipline: "eyecare",
      resources: [{ reference: "Practitioner/" }],
      start: "2026-08-03T09:00:00-04:00",
      durationMinutes: 30,
    }),
    /Appointment participant actor.*Type\/<id>/,
  );
});

test("existing valid Schedule builder behavior is preserved", () => {
  const built = buildSchedulingResource({
    kind: "provider",
    actorReference: "Practitioner/abc-123",
    actorDisplay: "Valid Provider",
    disciplines: ["eyecare"],
  });
  assert.equal(built.actor[0]?.reference, "Practitioner/abc-123");
  assert.equal(built.actor[0]?.display, "Valid Provider");
});
