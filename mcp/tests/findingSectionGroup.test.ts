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
  handleFindingSectionGroupCreationRequest,
  handleFindingSectionGroupMutationRequest,
  type FindingSectionGroupEndpointDeps,
} from "../src/clinical-graph/finding-section-group-endpoint.js";
import {
  FhirEncounterSectionOverrideStore,
  FhirFindingSectionGroupStore,
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
    const persisted = { ...resource, id: resource.id ?? `row-${this.resources.length + 1}` };
    this.resources.push(persisted);
    this.writes.push("create");
    return persisted;
  }

  async update<T extends Resource>(
    _resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    const index = this.resources.findIndex(
      (candidate) => candidate.resourceType === resource.resourceType && candidate.id === id,
    );
    if (index < 0) throw new Error(`Missing ${resource.resourceType}/${id}`);
    const persisted = { ...resource, id };
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
  await assert.rejects(() => store.create({ ...original, id: "duplicate" }), /already exists/);
  const edited = await store.save({ ...original, label: "Dry eye battery" });
  const deactivated = await store.save({ ...edited, active: false });

  assert.equal(fhir.resources.filter((row) => row.resourceType === "Basic").length, 1);
  assert.deepEqual(fhir.writes, ["create", "update", "update"]);
  assert.equal(deactivated.label, "Dry eye battery");
  assert.equal(deactivated.active, false);
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
