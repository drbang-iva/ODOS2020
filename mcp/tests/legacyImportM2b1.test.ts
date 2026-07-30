import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  Appointment,
  Bundle,
  Encounter,
  Practitioner,
  Resource,
} from "@medplum/fhirtypes";
import type { MedplumClient } from "../src/fhir-client.js";
import {
  EYEFINITY_EXAM_IDENTIFIER_SYSTEM,
  MIGRATED_IMAGING_VISIT_CODE,
  appointmentEncounterImportManifestSchema,
  importLegacyAppointmentsAndEncounters,
} from "../src/legacy-import/appointment-encounter-import.js";
import {
  APPOINTMENT_EXPORT_COLUMNS,
  analyzeAppointmentExport,
} from "../src/legacy-import/appointment-export.js";
import { ImportLedger } from "../src/legacy-import/import-ledger.js";
import { ODOS_VISIT_TYPE_SYSTEM } from "../src/fhir/schedulingVisitType.js";
import { ODOS_DISCIPLINE_SYSTEM } from "../src/scheduling/clinic-mode.js";
import { FhirClient } from "../../src/fhir-client.js";

const PROJECT_ID = "project-1";

test("AppointmentsExport analysis drops exact duplicates and applies only the approved cancel-pair rule", () => {
  const exact = appointmentRow({ PatientUID: "patient-a", PatientID: "epm-a" });
  const cancelActive = appointmentRow({
    PatientUID: "patient-b",
    PatientID: "epm-b",
    appt_date: "01/03/2020 12:00:00 AM",
    appt_cancel_ind: "False",
  });
  const cancelHistory = {
    ...cancelActive,
    appt_cancel_ind: "True",
    appt_confirmed_ind: "True",
    Notes: "changed after cancellation",
  };
  const ambiguousOne = appointmentRow({
    PatientUID: "patient-c",
    PatientID: "epm-c",
    appt_date: "01/04/2020 12:00:00 AM",
    Notes: "first booking",
  });
  const ambiguousTwo = { ...ambiguousOne, Notes: "second booking" };
  const analysis = analyzeAppointmentExport(
    appointmentCsv([
      exact,
      exact,
      cancelActive,
      cancelHistory,
      ambiguousOne,
      ambiguousTwo,
    ]),
    "00127314",
  );

  assert.deepEqual({
    sourceRows: analysis.sourceRows,
    exactDuplicates: analysis.exactDuplicates,
    rowsAfterExactDedupe: analysis.rowsAfterExactDedupe,
    collisionGroups: analysis.collisionGroups,
    collisionRows: analysis.collisionRows,
    resolvedCancelGroups: analysis.resolvedCancelGroups,
    ambiguousCollisionGroups: analysis.ambiguousCollisionGroups,
    appointments: analysis.appointments.length,
  }, {
    sourceRows: 6,
    exactDuplicates: 1,
    rowsAfterExactDedupe: 5,
    collisionGroups: 2,
    collisionRows: 4,
    resolvedCancelGroups: 1,
    ambiguousCollisionGroups: 1,
    appointments: 2,
  });
  assert.equal(
    analysis.appointments.find((entry) => entry.row.PatientUID === "patient-b")?.cancelled,
    true,
  );
  assert.equal(analysis.ambiguities[0]?.activeRows, 2);
  assert.throws(
    () => analyzeAppointmentExport(appointmentCsv([exact]), "other-office"),
    /verified only for office export 00127314/,
  );
  const malformedVendorQuote = `${appointmentCsv([exact]).replace(/Notes\\n$/, "Notes\n")}oct n"p`;
  assert.equal(
    analyzeAppointmentExport(malformedVendorQuote, "00127314").sourceRows,
    1,
  );
});

test("M2b-1 imports appointments, linked and technical Encounters, queues multi-appointment days, and converges", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const fhir = new MemoryVisitFhir();
  const appointmentsCsv = appointmentCsv([
    appointmentRow({
      appt_date: "01/02/2020 12:00:00 AM",
      appt_start_time: "09:00:00",
      appt_end_time: "09:30:00",
    }),
    appointmentRow({
      appt_date: "01/04/2020 12:00:00 AM",
      appt_start_time: "09:00:00",
      appt_end_time: "09:30:00",
    }),
    appointmentRow({
      appt_date: "01/04/2020 12:00:00 AM",
      appt_start_time: "14:00:00",
      appt_end_time: "14:30:00",
    }),
    appointmentRow({
      appt_date: "01/05/2020 12:00:00 AM",
      appt_start_time: "10:00:00",
      appt_end_time: "10:30:00",
      appt_cancel_ind: "False",
    }),
    appointmentRow({
      appt_date: "01/05/2020 12:00:00 AM",
      appt_start_time: "10:00:00",
      appt_end_time: "10:30:00",
      appt_cancel_ind: "True",
      Notes: "cancellation history",
    }),
    appointmentRow({
      PatientUID: "other-patient",
      PatientID: "other-epm",
      appt_date: "01/06/2020 12:00:00 AM",
      Notes: "first",
    }),
    appointmentRow({
      PatientUID: "other-patient",
      PatientID: "other-epm",
      appt_date: "01/06/2020 12:00:00 AM",
      Notes: "second",
    }),
    appointmentRow({
      appt_date: "01/07/2020 12:00:00 AM",
      ProviderID: "",
      ProviderFirst: "",
      ProviderLast: "",
    }),
  ]);
  const examsTsv = [
    "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye",
    "ehr-typical-1\texam-1\t2020-01-02 00:00:00.000\t1\t1",
    "ehr-typical-1\texam-2\t2020-01-02 00:00:00.000\t2\t2",
    "ehr-typical-1\texam-3\t2020-01-03 00:00:00.000\t3\t3",
    "ehr-typical-1\texam-4\t2020-01-04 00:00:00.000\t4\t1",
    "ehr-typical-1\texam-6\t2020-01-07 00:00:00.000\t4\t1",
    "another-patient\texam-5\t2020-01-02 00:00:00.000\t1\t1",
  ].join("\n");

  try {
    const firstRun = ledger.startRun("m2b-first");
    const first = await importLegacyAppointmentsAndEncounters({
      fhir,
      ledger,
      runId: firstRun,
      projectId: PROJECT_ID,
      manifest: manifest(),
      appointmentsCsv,
      examsTsv,
      now: new Date("2026-07-29T12:00:00Z"),
    });
    ledger.finishRun(firstRun, "completed");

    assert.deepEqual(first.appointments, {
      created: 5,
      updated: 0,
      skipped: 0,
      conflict: 0,
    });
    assert.deepEqual(first.encounters, {
      created: 3,
      updated: 0,
      skipped: 1,
      conflict: 0,
    });
    assert.deepEqual(first.practitioners, {
      created: 1,
      updated: 0,
      skipped: 0,
      conflict: 0,
    });
    assert.equal(first.visitDays, 4);

    const resources = fhir.resources;
    const appointments = resources.filter(
      (resource): resource is Appointment => resource.resourceType === "Appointment",
    );
    const encounters = resources.filter(
      (resource): resource is Encounter => resource.resourceType === "Encounter",
    );
    assert.equal(appointments.length, 5);
    assert.equal(encounters.length, 3);
    assert.equal(
      appointments.find((appointment) => appointment.start?.startsWith("2020-01-02"))?.status,
      "fulfilled",
    );
    assert.equal(
      appointments.find((appointment) => appointment.start?.startsWith("2020-01-05"))?.status,
      "cancelled",
    );
    assert.ok(appointments.every((appointment) => appointment.start?.endsWith("-05:00")));

    const linked = encounters.find((encounter) => encounter.appointment);
    assert.equal(linked?.class.system, "http://terminology.hl7.org/CodeSystem/v3-ActCode");
    assert.equal(linked?.class.code, "AMB");
    assert.equal(linked?.serviceType?.coding?.[0]?.system, ODOS_DISCIPLINE_SYSTEM);
    assert.equal(linked?.serviceType?.coding?.[0]?.code, "eyecare");
    assert.equal(linked?.type?.[0]?.coding?.[0]?.system, ODOS_VISIT_TYPE_SYSTEM);
    assert.equal(linked?.type?.[0]?.coding?.[0]?.code, "office-visit");
    assert.match(linked?.appointment?.[0]?.reference ?? "", /^Appointment\//);
    assert.match(linked?.participant?.[0]?.individual?.reference ?? "", /^Practitioner\//);
    assert.equal(linked?.serviceProvider?.reference, "Organization/practice-1");
    assert.equal(linked?.location?.[0]?.location.reference, "Location/facility-1");
    assert.deepEqual(
      linked?.identifier
        ?.filter((identifier) => identifier.system === EYEFINITY_EXAM_IDENTIFIER_SYSTEM)
        .map((identifier) => identifier.value)
        .sort(),
      ["exam-1", "exam-2"],
    );

    const technical = encounters.find((encounter) => !encounter.appointment);
    assert.equal(technical?.type?.[0]?.coding?.[0]?.code, MIGRATED_IMAGING_VISIT_CODE);
    assert.equal(technical?.participant, undefined);
    assert.equal(technical?.period?.start, "2020-01-03T00:00:00-05:00");
    assert.equal(technical?.period?.end, "2020-01-03T00:00:00-05:00");
    const noProvider = encounters.find((encounter) =>
      encounter.period?.start?.startsWith("2020-01-07")
    );
    assert.match(noProvider?.appointment?.[0]?.reference ?? "", /^Appointment\//);
    assert.equal(noProvider?.participant, undefined);

    const report = ledger.renderReport(firstRun);
    assert.match(report, /multi-appointment-day-queued/);
    assert.match(report, /Appointment/);
    assert.match(report, /Encounter/);

    const secondRun = ledger.startRun("m2b-second");
    const second = await importLegacyAppointmentsAndEncounters({
      fhir,
      ledger,
      runId: secondRun,
      projectId: PROJECT_ID,
      manifest: manifest(),
      appointmentsCsv,
      examsTsv,
      now: new Date("2026-07-29T12:00:00Z"),
    });
    ledger.finishRun(secondRun, "completed");
    assert.deepEqual(second.appointments, {
      created: 0,
      updated: 0,
      skipped: 5,
      conflict: 0,
    });
    assert.deepEqual(second.encounters, {
      created: 0,
      updated: 0,
      skipped: 4,
      conflict: 0,
    });
    assert.deepEqual(second.practitioners, {
      created: 0,
      updated: 0,
      skipped: 1,
      conflict: 0,
    });
    assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Appointment").length, 5);
    assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Encounter").length, 3);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("M2b-1 refuses the calibration chart and requires explicit visit-type mappings", async () => {
  assert.throws(
    () => appointmentEncounterImportManifestSchema.parse({
      ...manifest(),
      sourceOfficeNumber: "other-office",
    }),
  );

  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  try {
    const runId = ledger.startRun("m2b-unmapped");
    const result = await importLegacyAppointmentsAndEncounters({
      fhir: new MemoryVisitFhir(),
      ledger,
      runId,
      projectId: PROJECT_ID,
      manifest: { ...manifest(), visitTypeMap: {} },
      appointmentsCsv: appointmentCsv([appointmentRow()]),
      examsTsv: "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye\n",
    });
    assert.equal(result.appointments.conflict, 1);
    assert.match(ledger.renderReport(runId), /unmapped-legacy-visit-type/);

    await assert.rejects(
      importLegacyAppointmentsAndEncounters({
        fhir: new MemoryVisitFhir(),
        ledger,
        runId,
        projectId: PROJECT_ID,
        manifest: {
          ...manifest(),
          epmPatientId: "6499570",
          ehrPatientId: "969",
        },
        appointmentsCsv: appointmentCsv([appointmentRow()]),
        examsTsv: "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye\n",
      }),
      /refuses the operator test-data chart/,
    );
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("root FhirClient request seam preserves denied status and refuses cross-origin token forwarding", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      authorization: headers.get("authorization"),
    });
    return Response.json(
      { resourceType: "OperationOutcome", issue: [{ severity: "error", code: "forbidden" }] },
      { status: 403, statusText: "Forbidden" },
    );
  };
  try {
    const client = new FhirClient({
      baseUrl: "http://localhost:8103",
      accessToken: "ordinary-token",
    });
    const response = await client.request("/fhir/R4/Media/media-1");
    assert.equal(response.status, 403);
    assert.equal(requests[0]?.authorization, "Bearer ordinary-token");
    await assert.rejects(
      client.read("Media", "media-1"),
      /FHIR 403 Forbidden/,
    );
    await assert.rejects(
      client.request("https://outside.example/fhir/R4/Patient"),
      /must stay on the configured server origin/,
    );
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function manifest() {
  return {
    sourceOfficeNumber: "00127314" as const,
    patientReference: "Patient/patient-1",
    patientUid: "patient-uid-1",
    epmPatientId: "epm-typical-1",
    ehrPatientId: "ehr-typical-1",
    organizationReference: "Organization/practice-1",
    locationReference: "Location/facility-1",
    visitTypeMap: {
      "Office Visit": { code: "office-visit", display: "Office Visit (Medical)" },
    },
  };
}

function appointmentRow(
  overrides: Partial<Record<(typeof APPOINTMENT_EXPORT_COLUMNS)[number], string>> = {},
): Record<(typeof APPOINTMENT_EXPORT_COLUMNS)[number], string> {
  return {
    OfficeNum: "00127314",
    PatientID: "epm-typical-1",
    FirstName: "Synthetic",
    lastname: "Patient",
    BirthDate: "01/01/1980",
    Patient_no_old: "",
    appt_date: "01/02/2020 12:00:00 AM",
    appt_start_time: "09:00:00",
    appt_end_time: "09:30:00",
    ProviderID: "provider-1",
    ProviderFirst: "Synthetic",
    ProviderLast: "Doctor",
    resourceid: "resource-1",
    appt_cancel_ind: "False",
    appt_confirmed_ind: "False",
    PatientUID: "patient-uid-1",
    appt_type: "Office Visit",
    Notes: "",
    ...overrides,
  };
}

function appointmentCsv(
  rows: ReadonlyArray<Record<(typeof APPOINTMENT_EXPORT_COLUMNS)[number], string>>,
): string {
  return [
    APPOINTMENT_EXPORT_COLUMNS.join(","),
    ...rows.map((row) =>
      APPOINTMENT_EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(",")
    ),
  ].join("\n");
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function tempState(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "odos-m2b1-"));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

class MemoryVisitFhir {
  readonly resources: Resource[] = [];
  private nextId = 1;

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    let rows = this.resources.filter((resource) => resource.resourceType === resourceType) as T[];
    const identifier = params.identifier?.split("|", 2);
    if (identifier) {
      rows = rows.filter((resource) =>
        resource.identifier?.some(
          (entry) => entry.system === identifier[0] && entry.value === identifier[1],
        )
      );
    }
    if (resourceType === "Practitioner" && (params.family || params.given)) {
      rows = rows.filter((resource) => {
        const practitioner = resource as Practitioner;
        return practitioner.name?.some(
          (name) =>
            (!params.family || name.family === params.family)
            && (!params.given || name.given?.includes(params.given)),
        );
      });
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource })),
    };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    const created = structuredClone(resource);
    created.id = `${resource.resourceType.toLocaleLowerCase()}-${this.nextId++}`;
    created.meta = { ...created.meta, versionId: "1" };
    this.resources.push(created);
    return structuredClone(created);
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const index = this.resources.findIndex(
      (candidate) => candidate.resourceType === resourceType && candidate.id === id,
    );
    assert.notEqual(index, -1);
    const existing = this.resources[index]!;
    assert.equal(headers["If-Match"], `W/"${existing.meta?.versionId}"`);
    const updated = structuredClone(resource);
    updated.id = id;
    updated.meta = {
      ...updated.meta,
      versionId: String(Number(existing.meta?.versionId ?? "0") + 1),
    };
    this.resources[index] = updated;
    return structuredClone(updated);
  }
}

type _MemoryVisitFhirContract = MemoryVisitFhir extends Pick<
  MedplumClient,
  "search" | "create" | "update"
>
  ? true
  : never;
