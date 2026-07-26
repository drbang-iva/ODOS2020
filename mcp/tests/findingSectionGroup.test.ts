import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Appointment,
  Basic,
  Bundle,
  Encounter,
  HealthcareService,
  Resource,
} from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { resolveVisitTypeCategoryForEncounter } from "../src/clinic/clinic-summary.js";
import {
  handleEncounterSectionOverrideMutationRequest,
  handleFindingSectionGroupCatalogRequest,
  handleFindingSectionGroupCreationRequest,
  handleFindingSectionGroupMutationRequest,
  type FindingSectionGroupEndpointDeps,
} from "../src/clinical-graph/finding-section-group-endpoint.js";
import {
  FhirEncounterSectionOverrideStore,
  FhirFindingSectionGroupStore,
  FindingSectionGroupAlreadyExistsError,
  FINDING_SECTION_GROUP_CODE,
  FINDING_SECTION_GROUP_CODE_SYSTEM,
  buildFindingSectionGroupResource,
  parseFindingSectionGroupResource,
  resolveDefaultSectionGroups,
  type FindingSectionGroup,
  type FindingSectionGroupFhirClient,
} from "../src/clinical-graph/finding-section-group-store.js";
import { buildSchedulingAppointment } from "../src/fhir/schedulingAppointment.js";
import { buildVisitType } from "../src/fhir/schedulingVisitType.js";

const AUTH = "Bearer good";

class MemoryFhir implements FindingSectionGroupFhirClient {
  readonly resources: Resource[] = [];
  writes: Array<"create" | "update"> = [];
  updateHeaders: Array<Record<string, string> | undefined> = [];
  concurrentVersionBumpOnNextUpdate = false;
  failNextSearch: Error | undefined;

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find(
      (candidate) => candidate.resourceType === resourceType && candidate.id === id,
    );
    if (!resource) {
      const error = new Error(`${resourceType}/${id} not found`) as Error & { status: number };
      error.status = 404;
      throw error;
    }
    return resource as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    if (this.failNextSearch) {
      const error = this.failNextSearch;
      this.failNextSearch = undefined;
      throw error;
    }
    const resources = this.resources.filter((resource) => {
      if (resource.resourceType !== resourceType) return false;
      if (resource.resourceType === "Basic" && params.code) {
        const [system, code] = params.code.split("|");
        if (!resource.code?.coding?.some((coding) => coding.system === system && coding.code === code)) {
          return false;
        }
      }
      if (resource.resourceType === "Basic" && params.subject) {
        if (resource.subject?.reference !== params.subject) return false;
      }
      if (resource.resourceType === "HealthcareService" && params["service-type"]) {
        const [system, code] = params["service-type"].split("|");
        if (!resource.type?.flatMap((concept) => concept.coding ?? [])
          .some((coding) => coding.system === system && coding.code === code)) {
          return false;
        }
      }
      return true;
    });
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resources.map((resource) => ({ resource: resource as T })),
    };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    const persisted = {
      ...resource,
      id: resource.id ?? `row-${this.resources.length + 1}`,
      meta: { ...resource.meta, versionId: "1" },
    };
    this.resources.push(persisted);
    this.writes.push("create");
    return persisted;
  }

  async update<T extends Resource>(
    _resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T> {
    const index = this.resources.findIndex(
      (candidate) => candidate.resourceType === resource.resourceType && candidate.id === id,
    );
    if (index < 0) throw new Error(`Missing ${resource.resourceType}/${id}`);
    if (this.concurrentVersionBumpOnNextUpdate) {
      const current = this.resources[index]!;
      this.resources[index] = {
        ...current,
        meta: {
          ...current.meta,
          versionId: String(Number(current.meta?.versionId ?? "0") + 1),
        },
      };
      this.concurrentVersionBumpOnNextUpdate = false;
    }
    const current = this.resources[index]!;
    this.updateHeaders.push(headers);
    if (headers?.["If-Match"] !== `W/"${current.meta?.versionId}"`) {
      const error = new Error("FHIR precondition failed") as Error & { status: number };
      error.status = 412;
      throw error;
    }
    const persisted = {
      ...resource,
      id,
      meta: {
        ...resource.meta,
        versionId: String(Number(current.meta?.versionId ?? "0") + 1),
      },
    };
    this.resources[index] = persisted;
    this.writes.push("update");
    return persisted;
  }
}

test("visit-type category resolver follows Encounter appointment to the HealthcareService category", async () => {
  const fhir = new MemoryFhir();
  const service = buildVisitType({
    code: "dry-eye-workup",
    name: "Dry eye workup",
    discipline: "eyecare",
    durationMinutes: 30,
    categoryCode: "dry-eye",
    categoryLabel: "Dry Eye",
  });
  service.id = "service-dry-eye";
  const appointment = appointmentFixture("appointment-1", "dry-eye-workup");
  const encounter = encounterFixture("encounter-1", "appointment-1");
  fhir.resources.push(service, appointment, encounter);

  assert.equal(
    await resolveVisitTypeCategoryForEncounter(encounter, undefined, fhir),
    "dry-eye",
  );
});

test("visit-type category resolver returns undefined for every unresolved link without throwing", async () => {
  const fhir = new MemoryFhir();
  const uncategorized = buildVisitType({
    code: "uncategorized",
    name: "Uncategorized",
    discipline: "eyecare",
    durationMinutes: 30,
  });
  uncategorized.id = "service-uncategorized";
  const noCategoryAppointment = appointmentFixture("appointment-no-category", "uncategorized");
  const noServiceType = appointmentFixture("appointment-no-type", "uncategorized");
  noServiceType.serviceType = undefined;
  fhir.resources.push(uncategorized, noCategoryAppointment, noServiceType);

  assert.equal(
    await resolveVisitTypeCategoryForEncounter(
      encounterFixture("encounter-no-category", "appointment-no-category"),
      undefined,
      fhir,
    ),
    undefined,
  );
  assert.equal(
    await resolveVisitTypeCategoryForEncounter(
      encounterFixture("encounter-no-type", "appointment-no-type"),
      undefined,
      fhir,
    ),
    undefined,
  );
  assert.equal(
    await resolveVisitTypeCategoryForEncounter(
      { resourceType: "Encounter", status: "in-progress", class: { code: "AMB" } },
      undefined,
      fhir,
    ),
    undefined,
  );
});

test("visit-type category resolver logs a dangling Appointment reference and treats it as missing", async () => {
  const fhir = new MemoryFhir();
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => messages.push(String(message));
  try {
    assert.equal(
      await resolveVisitTypeCategoryForEncounter(
        encounterFixture("encounter-dangling", "appointment-missing"),
        undefined,
        fhir,
      ),
      undefined,
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(messages, [
    "Visit-type category resolution skipped dangling Appointment/appointment-missing reference: " +
      "Appointment/appointment-missing not found",
  ]);
});

test("visit-type category resolver logs and propagates operational FHIR failures", async () => {
  const fhir = new MemoryFhir();
  const appointment = appointmentFixture("appointment-1", "dry-eye-workup");
  fhir.resources.push(appointment);
  fhir.failNextSearch = new Error("temporary HealthcareService search failure");
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => messages.push(String(message));
  try {
    await assert.rejects(
      () => resolveVisitTypeCategoryForEncounter(
        encounterFixture("encounter-1", "appointment-1"),
        undefined,
        fhir,
      ),
      /Visit-type category resolution failed/,
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(messages, [
    "Visit-type category resolution failed: temporary HealthcareService search failure",
  ]);
});

test("default group resolution supports zero, one, and two matches and excludes inactive groups", () => {
  const dryEye = group("dry-eye-workup", ["dry-eye:"], ["dry-eye"]);
  const questionnaire = group("dry-eye-questionnaire", ["custom:deq-"], ["dry-eye"]);
  const inactive = { ...group("inactive-dry-eye", ["custom:old-"], ["dry-eye"]), active: false };
  const groups = [dryEye, questionnaire, inactive];

  assert.deepEqual(resolveDefaultSectionGroups(groups, undefined), []);
  assert.deepEqual(
    resolveDefaultSectionGroups([dryEye], "dry-eye").map((row) => row.groupKey),
    ["dry-eye-workup"],
  );
  assert.deepEqual(
    resolveDefaultSectionGroups(groups, "dry-eye").map((row) => row.groupKey),
    ["dry-eye-workup", "dry-eye-questionnaire"],
  );
  assert.deepEqual(resolveDefaultSectionGroups(groups, "comprehensive"), []);
});

test("finding section group resource and store support create, edit, deactivate, and duplicate rejection", async () => {
  const fhir = new MemoryFhir();
  const original = group("dry-eye-workup", ["dry-eye:"], ["dry-eye"]);
  const resource = buildFindingSectionGroupResource(original);
  assert.equal(resource.code?.coding?.[0]?.system, FINDING_SECTION_GROUP_CODE_SYSTEM);
  assert.equal(resource.code?.coding?.[0]?.code, FINDING_SECTION_GROUP_CODE);
  assert.deepEqual(parseFindingSectionGroupResource(resource), original);

  const store = new FhirFindingSectionGroupStore(fhir);
  await store.create(original);
  await assert.rejects(
    () => store.create({ ...original, id: "duplicate" }),
    FindingSectionGroupAlreadyExistsError,
  );
  const edited = await store.save({ ...original, label: "Dry eye battery" });
  const deactivated = await store.save({ ...edited, active: false });

  assert.equal(fhir.resources.filter((row) => row.resourceType === "Basic").length, 1);
  assert.deepEqual(fhir.writes, ["create", "update", "update"]);
  assert.equal(deactivated.label, "Dry eye battery");
  assert.equal(deactivated.active, false);
  assert.deepEqual(fhir.updateHeaders.map((headers) => headers?.["If-Match"]), [
    'W/"1"',
    'W/"2"',
  ]);
});

test("stale group and encounter-override writes fail instead of overwriting concurrent versions", async () => {
  const fhir = new MemoryFhir();
  const groupStore = new FhirFindingSectionGroupStore(fhir);
  const original = group("dry-eye-workup", ["dry-eye:"], ["dry-eye"]);
  await groupStore.create(original);
  fhir.concurrentVersionBumpOnNextUpdate = true;
  await assert.rejects(
    () => groupStore.save({ ...original, label: "Stale group label" }),
    (error: unknown) => (error as { status?: number }).status === 412,
  );
  assert.equal((await groupStore.list())[0]?.label, original.label);

  const overrideStore = new FhirEncounterSectionOverrideStore(fhir);
  await overrideStore.setGroupKeys("encounter-1", ["dry-eye-workup"]);
  fhir.concurrentVersionBumpOnNextUpdate = true;
  await assert.rejects(
    () => overrideStore.setGroupKeys("encounter-1", []),
    (error: unknown) => (error as { status?: number }).status === 412,
  );
  assert.deepEqual((await overrideStore.get("encounter-1")).groupKeys, ["dry-eye-workup"]);
  assert.deepEqual(fhir.updateHeaders.map((headers) => headers?.["If-Match"]), [
    'W/"1"',
    'W/"1"',
  ]);
});

test("stale HTTP mutations surface a reload-and-retry conflict", async () => {
  const fhir = new MemoryFhir();
  const sectionGroup = group("dry-eye-workup", ["dry-eye:"], ["dry-eye"]);
  await new FhirFindingSectionGroupStore(fhir).create(sectionGroup);
  fhir.resources.push({
    resourceType: "Encounter",
    id: "encounter-1",
    status: "in-progress",
    class: { code: "AMB" },
  });

  fhir.concurrentVersionBumpOnNextUpdate = true;
  const groupConflict = await handleFindingSectionGroupMutationRequest(
    endpointDeps("practice-admin", fhir),
    {
      authHeader: AUTH,
      params: { groupKey: sectionGroup.groupKey },
      body: { label: "Stale group label" },
    },
  );

  const overrideStore = new FhirEncounterSectionOverrideStore(fhir);
  await overrideStore.setGroupKeys("encounter-1", [sectionGroup.groupKey]);
  fhir.concurrentVersionBumpOnNextUpdate = true;
  const overrideConflict = await handleEncounterSectionOverrideMutationRequest(
    endpointDeps("clinician", fhir),
    {
      authHeader: AUTH,
      params: { encounterId: "encounter-1" },
      body: { action: "remove", groupKey: sectionGroup.groupKey },
    },
  );

  assert.equal(groupConflict.status, 409);
  assert.equal((groupConflict.body as { code: string }).code, "concurrent-edit");
  assert.equal(overrideConflict.status, 409);
  assert.equal((overrideConflict.body as { code: string }).code, "concurrent-edit");
});

test("group creation rejects non-kebab keys and duplicate keys through the HTTP boundary", async () => {
  const fhir = new MemoryFhir();
  const deps = endpointDeps("practice-admin", fhir);
  const invalid = await handleFindingSectionGroupCreationRequest(deps, {
    authHeader: AUTH,
    body: {
      groupKey: "Dry Eye",
      label: "Dry eye",
      sectionKeyPrefixes: ["dry-eye:"],
      defaultForVisitTypeCategories: ["dry-eye"],
      active: true,
    },
  });
  const valid = await handleFindingSectionGroupCreationRequest(deps, {
    authHeader: AUTH,
    body: {
      groupKey: "dry-eye-workup",
      label: "Dry eye",
      sectionKeyPrefixes: ["dry-eye:"],
      defaultForVisitTypeCategories: ["dry-eye"],
      active: true,
    },
  });
  const duplicate = await handleFindingSectionGroupCreationRequest(deps, {
    authHeader: AUTH,
    body: {
      groupKey: "dry-eye-workup",
      label: "Duplicate",
      sectionKeyPrefixes: ["custom:duplicate-"],
      defaultForVisitTypeCategories: [],
      active: true,
    },
  });
  const edited = await handleFindingSectionGroupMutationRequest(deps, {
    authHeader: AUTH,
    params: { groupKey: "dry-eye-workup" },
    body: { label: "Dry eye battery", active: false },
  });

  assert.equal(invalid.status, 400);
  assert.equal(valid.status, 201);
  assert.equal(duplicate.status, 409);
  assert.equal(edited.status, 200);
  assert.deepEqual(
    (edited.body as { group: FindingSectionGroup }).group,
    {
      ...group("dry-eye-workup", ["dry-eye:"], ["dry-eye"]),
      id: "group-1",
      label: "Dry eye battery",
      active: false,
    },
  );
});

test("pull-in persists for one encounter and does not leak to a second encounter for the same patient", async () => {
  const fhir = new MemoryFhir();
  const sectionGroup = group("dry-eye-workup", ["dry-eye:"], ["dry-eye"]);
  await new FhirFindingSectionGroupStore(fhir).create(sectionGroup);
  fhir.resources.push(
    {
      ...encounterFixture("encounter-1", "appointment-1"),
      subject: { reference: "Patient/patient-1" },
    },
    {
      ...encounterFixture("encounter-2", "appointment-2"),
      subject: { reference: "Patient/patient-1" },
    },
  );
  const result = await handleEncounterSectionOverrideMutationRequest(
    endpointDeps("clinician", fhir),
    {
      authHeader: AUTH,
      params: { encounterId: "encounter-1" },
      body: { action: "add", groupKey: "dry-eye-workup" },
    },
  );
  const store = new FhirEncounterSectionOverrideStore(fhir);

  assert.equal(result.status, 200);
  assert.deepEqual((await store.get("encounter-1")).groupKeys, ["dry-eye-workup"]);
  assert.deepEqual((await store.get("encounter-2")).groupKeys, []);
});

test("a deactivated pull-in can be removed and does not resurrect after reactivation", async () => {
  const fhir = new MemoryFhir();
  const groupStore = new FhirFindingSectionGroupStore(fhir);
  const sectionGroup = group("dry-eye-workup", ["dry-eye:"], ["dry-eye"]);
  await groupStore.create(sectionGroup);
  fhir.resources.push({
    resourceType: "Encounter",
    id: "encounter-1",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
  });
  const deps = endpointDeps("clinician", fhir);
  const add = await handleEncounterSectionOverrideMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "encounter-1" },
    body: { action: "add", groupKey: "dry-eye-workup" },
  });
  await groupStore.save({ ...sectionGroup, active: false });
  const remove = await handleEncounterSectionOverrideMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "encounter-1" },
    body: { action: "remove", groupKey: "dry-eye-workup" },
  });
  await groupStore.save({ ...sectionGroup, active: true });
  const catalog = await handleFindingSectionGroupCatalogRequest(deps, {
    authHeader: AUTH,
    query: { encounterId: "encounter-1" },
  });

  assert.equal(add.status, 200);
  assert.equal(remove.status, 200);
  assert.equal(catalog.status, 200);
  assert.deepEqual(
    (catalog.body as { overrideGroupKeys: string[]; pulledInGroupKeys: string[] })
      .overrideGroupKeys,
    [],
  );
  assert.deepEqual(
    (catalog.body as {
      overrideGroupKeys: string[];
      pulledInGroupKeys: string[];
      effectiveGroupKeys: string[];
    })
      .pulledInGroupKeys,
    [],
  );
  assert.deepEqual(
    (catalog.body as {
      overrideGroupKeys: string[];
      pulledInGroupKeys: string[];
      effectiveGroupKeys: string[];
    })
      .effectiveGroupKeys,
    [],
  );
  assert.equal((await groupStore.list())[0]?.active, true);
});

function endpointDeps(
  actorRole: PracticeRoleId,
  fhir: MemoryFhir,
): FindingSectionGroupEndpointDeps {
  let id = 0;
  return {
    authenticate: async () => ({
      staffReference: "Practitioner/staff-1",
      actorRole,
      fhir,
    }),
    newId: () => `group-${++id}`,
  };
}

function group(
  groupKey: string,
  sectionKeyPrefixes: string[],
  defaultForVisitTypeCategories: string[],
): FindingSectionGroup {
  return {
    id: `id-${groupKey}`,
    groupKey,
    label: groupKey,
    sectionKeyPrefixes,
    defaultForVisitTypeCategories,
    active: true,
  };
}

function appointmentFixture(id: string, visitTypeCode: string): Appointment {
  const appointment = buildSchedulingAppointment({
    patient: { reference: "Patient/patient-1" },
    resources: [{ reference: "Practitioner/practitioner-1" }],
    discipline: "eyecare",
    visitTypeCode,
    visitTypeDisplay: visitTypeCode,
    start: "2026-07-26T10:00:00-04:00",
    durationMinutes: 30,
  });
  appointment.id = id;
  return appointment;
}

function encounterFixture(id: string, appointmentId: string): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status: "in-progress",
    class: { code: "AMB" },
    appointment: [{ reference: `Appointment/${appointmentId}` }],
  };
}
