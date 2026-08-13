import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment, Bundle, Encounter } from "@medplum/fhirtypes";
import {
  buildStartEncounterCreateBundle,
  findOpenEncounterForAppointment,
  INTENDED_COVERAGE_EXTENSION_URL,
  startOrOpenEncounterForAppointment,
} from "../../ui/src/lib/encounter-bundles.js";
import { fhir as uiFhir } from "../../ui/src/lib/fhir.js";
import {
  ODOS_MEDICAL_COVERAGE_EXTENSION_URL,
  ODOS_VISIT_TYPE_SYSTEM,
  ODOS_VISION_COVERAGE_EXTENSION_URL,
} from "../../ui/src/lib/scheduling.js";
import { DEFAULT_VISIT_TYPE_CATEGORIES } from "../../ui/src/lib/visit-type-config.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
} from "../src/authz/roles.js";

test("appointment context adds the native link, visit type, repeated coverage extensions, and conditional create", () => {
  const bundle = buildStartEncounterCreateBundle({
    patientId: "patient-1",
    now: "2026-07-24T14:00:00.000Z",
    appointmentContext: {
      appointmentId: "appointment-1",
      visitTypeCoding: {
        system: ODOS_VISIT_TYPE_SYSTEM,
        code: "routine",
        display: "Routine exam",
      },
      intendedCoverageReferences: ["Coverage/vision-1", "Coverage/medical-1"],
    },
  });
  const encounter = bundle.entry?.[0]?.resource as Encounter;

  assert.deepEqual(encounter.appointment, [{ reference: "Appointment/appointment-1" }]);
  assert.deepEqual(encounter.type, [{
    coding: [{
      system: ODOS_VISIT_TYPE_SYSTEM,
      code: "routine",
      display: "Routine exam",
    }],
  }]);
  assert.deepEqual(encounter.extension, [
    {
      url: INTENDED_COVERAGE_EXTENSION_URL,
      valueReference: { reference: "Coverage/vision-1" },
    },
    {
      url: INTENDED_COVERAGE_EXTENSION_URL,
      valueReference: { reference: "Coverage/medical-1" },
    },
  ]);
  const criteria = new URLSearchParams(bundle.entry?.[0]?.request?.ifNoneExist);
  assert.equal(criteria.get("appointment"), "Appointment/appointment-1");
  assert.deepEqual(criteria.getAll("status:not"), ["cancelled", "entered-in-error"]);
});

test("omitting appointment context preserves the existing encounter shape and unconditional request", () => {
  const bundle = buildStartEncounterCreateBundle({
    patientId: "patient-1",
    now: "2026-07-24T14:00:00.000Z",
  });
  const encounter = bundle.entry?.[0]?.resource as Encounter;

  assert.equal(encounter.appointment, undefined);
  assert.equal(encounter.type, undefined);
  assert.equal(encounter.extension, undefined);
  assert.deepEqual(bundle.entry?.[0]?.request, { method: "POST", url: "Encounter" });
});

test("stand-alone visit type matches the complete CodeableConcept copied by the importer", () => {
  const category = DEFAULT_VISIT_TYPE_CATEGORIES.find((candidate) => candidate.id === "dry-eye");
  assert.ok(category);
  const migratedEncounterTypeFixture = {
    coding: [{
      system: ODOS_VISIT_TYPE_SYSTEM,
      code: category.id,
      display: category.label,
    }],
    text: category.label,
  };
  const bundle = buildStartEncounterCreateBundle({
    patientId: "patient-1",
    now: "2026-08-03T14:00:00.000Z",
    visitType: migratedEncounterTypeFixture,
  });
  const encounter = bundle.entry?.[0]?.resource as Encounter;

  assert.deepEqual(encounter.type, [migratedEncounterTypeFixture]);
});

test("open-encounter lookup sends the standard appointment search with both excluded statuses", async () => {
  let params: Array<[string, string]> = [];
  const existing: Encounter = {
    resourceType: "Encounter",
    id: "encounter-1",
    status: "in-progress",
    class: { code: "AMB" },
  };
  const client = {
    search: async (_resourceType: string, input: Array<[string, string]>) => {
      params = input;
      return { resourceType: "Bundle", type: "searchset", entry: [{ resource: existing }] };
    },
    executeTransaction: async () => {
      throw new Error("not reached");
    },
  } as unknown as Pick<typeof uiFhir, "search" | "executeTransaction">;

  assert.equal(await findOpenEncounterForAppointment("appointment-1", client), existing);
  assert.deepEqual(params, [
    ["appointment", "Appointment/appointment-1"],
    ["status:not", "cancelled"],
    ["status:not", "entered-in-error"],
    ["_count", "2"],
  ]);
});

test("start-or-open returns an existing living encounter without writing", async () => {
  let transactions = 0;
  const client = {
    search: async () => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: [{ resource: encounter("existing-1") }],
    }),
    executeTransaction: async () => {
      transactions += 1;
      throw new Error("not reached");
    },
  } as unknown as Pick<typeof uiFhir, "search" | "executeTransaction">;

  const result = await startOrOpenEncounterForAppointment(appointment(), { client });
  assert.deepEqual(result, { encounterId: "existing-1", created: false });
  assert.equal(transactions, 0);
});

test("start-or-open carries live appointment data and advances a newly created encounter", async () => {
  const requests: Bundle[] = [];
  const client = {
    search: async () => ({ resourceType: "Bundle", type: "searchset" }),
    executeTransaction: async (bundle: Bundle) => {
      requests.push(bundle);
      return requests.length === 1
        ? transactionResponse("201 Created", "Encounter/created-1/_history/1")
        : transactionResponse("200 OK", "Encounter/created-1/_history/2");
    },
  } as unknown as Pick<typeof uiFhir, "search" | "executeTransaction">;

  const result = await startOrOpenEncounterForAppointment(appointment(), {
    client,
    now: () => new Date("2026-07-24T14:00:00.000Z"),
  });
  assert.deepEqual(result, { encounterId: "created-1", created: true });
  assert.equal(requests.length, 2);
  const created = requests[0]?.entry?.[0]?.resource as Encounter;
  assert.deepEqual(created.appointment, [{ reference: "Appointment/appointment-1" }]);
  assert.deepEqual(created.type?.[0]?.coding?.[0], {
    system: ODOS_VISIT_TYPE_SYSTEM,
    code: "routine",
    display: "Routine exam",
  });
  assert.deepEqual(
    created.extension?.map((extension) => extension.valueReference?.reference),
    ["Coverage/vision-1", "Coverage/medical-1"],
  );
  const patch = requests[1]?.entry?.[0]?.resource;
  assert.equal(patch?.resourceType, "Binary");
  assert.deepEqual(
    JSON.parse(atob((patch as { data?: string }).data ?? "")),
    [{ op: "replace", path: "/status", value: "in-progress" }],
  );
});

test("conditional-create race returns the winner's encounter instead of a duplicate", async () => {
  let transaction = 0;
  const client = {
    search: async () => ({ resourceType: "Bundle", type: "searchset" }),
    executeTransaction: async () => {
      transaction += 1;
      return transaction === 1
        ? transactionResponse("200 OK", "Encounter/race-winner/_history/1")
        : transactionResponse("200 OK", "Encounter/race-winner/_history/2");
    },
  } as unknown as Pick<typeof uiFhir, "search" | "executeTransaction">;

  const result = await startOrOpenEncounterForAppointment(appointment(), { client });
  assert.deepEqual(result, { encounterId: "race-winner", created: false });
  assert.equal(transaction, 2);
});

test("compiled policies cover the Appointment and Encounter operations for both reachable roles", () => {
  const frontDesk = buildMedplumAccessPolicy(getRoleDeclaration("staff"));
  const appointmentRule = frontDesk.resource?.find((rule) =>
    rule.resourceType === "Appointment" && rule.interaction?.includes("update"));
  const encounterRule = frontDesk.resource?.find((rule) =>
    rule.resourceType === "Encounter" && rule.interaction?.includes("update"));
  const provenanceRule = frontDesk.resource?.find((rule) =>
    rule.resourceType === "Provenance" && rule.interaction?.includes("create"));
  assert.deepEqual(appointmentRule?.interaction, ["create", "update"]);
  assert.equal(appointmentRule?.criteria, undefined);
  assert.deepEqual(
    encounterRule?.interaction,
    ["create", "update"],
  );
  assert.equal(encounterRule?.criteria, "Encounter?_compartment=%patient_compartment");
  assert.deepEqual(
    provenanceRule?.interaction,
    ["create"],
  );
  assert.equal(
    provenanceRule?.criteria,
    "Provenance?_compartment=%patient_compartment",
  );

  for (const roleId of ["provider"] as const) {
    const clinical = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    const clinicalProvenance = clinical.resource?.find((rule) =>
      rule.resourceType === "Provenance" && rule.interaction?.includes("create"));
    assert.ok(clinicalProvenance?.interaction?.includes("create"), roleId);
    assert.equal(
      clinicalProvenance?.criteria,
      "Provenance?_compartment=%patient_compartment",
      roleId,
    );
  }

  const admin = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  const wildcard = admin.resource?.find((rule) => rule.resourceType === "*");
  assert.equal(wildcard, undefined);
});

function appointment(): Appointment {
  return {
    resourceType: "Appointment",
    id: "appointment-1",
    status: "arrived",
    serviceType: [{
      coding: [{
        system: ODOS_VISIT_TYPE_SYSTEM,
        code: "routine",
        display: "Routine exam",
      }],
    }],
    participant: [{ actor: { reference: "Patient/patient-1" } }],
    extension: [
      {
        url: ODOS_VISION_COVERAGE_EXTENSION_URL,
        valueReference: { reference: "Coverage/vision-1" },
      },
      {
        url: ODOS_MEDICAL_COVERAGE_EXTENSION_URL,
        valueReference: { reference: "Coverage/medical-1" },
      },
    ],
  };
}

function encounter(id: string): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status: "in-progress",
    class: { code: "AMB" },
  };
}

function transactionResponse(status: string, location: string): Bundle {
  return {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [
      { response: { status, location } },
      { response: { status: "201 Created", location: "Provenance/provenance-1/_history/1" } },
    ],
  };
}
