import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
  EYEFINITY_TECHNICAL_VISIT_IDENTIFIER_SYSTEM,
  MIGRATED_IMAGING_VISIT_CODE,
  MIGRATION_TEST_TAG_CODE,
  appointmentEncounterImportManifestSchema,
  importLegacyAppointmentsAndEncounters,
  technicalVisitKey,
} from "../src/legacy-import/appointment-encounter-import.js";
import {
  applyDecisionFile,
  listPendingDecisions,
  runInteractiveAdjudication,
} from "../src/legacy-import/adjudication-loop.js";
import { runLegacyVisitBulk } from "../src/legacy-import/bulk-visit-import.js";
import {
  APPOINTMENT_EXPORT_COLUMNS,
  analyzeAppointmentExport,
  appointmentCompositeKey,
  EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM,
} from "../src/legacy-import/appointment-export.js";
import { ImportLedger } from "../src/legacy-import/import-ledger.js";
import {
  EHR_PATIENT_IDENTIFIER_SYSTEM,
  EPM_PATIENT_IDENTIFIER_SYSTEM,
  importLegacyPatient,
} from "../src/legacy-import/patient-import.js";
import { ODOS_VISIT_TYPE_SYSTEM } from "../src/fhir/schedulingVisitType.js";
import { ODOS_DISCIPLINE_SYSTEM } from "../src/scheduling/clinic-mode.js";
import { FhirClient } from "../../src/fhir-client.js";
import { runAdjudicationCli } from "../../scripts/adjudicate-legacy-import-m2b2.js";
import { runBulkImportCli } from "../../scripts/import-legacy-bulk-m2b2.js";
import { runVisitImportCli } from "../../scripts/import-legacy-visits-m2b1.js";

const PROJECT_ID = "project-1";

test("AppointmentsExport analysis drops exact duplicates and applies only the approved cancellation rules", () => {
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
  const allCancelledOne = appointmentRow({
    PatientUID: "patient-d",
    PatientID: "epm-d",
    appt_date: "01/05/2020 12:00:00 AM",
    appt_cancel_ind: "True",
    Notes: "cancelled",
  });
  const allCancelledTwo = {
    ...allCancelledOne,
    appt_confirmed_ind: "True",
  };
  const additionalResolvedRows = Array.from({ length: 111 }, (_, index) => {
    const active = appointmentRow({
      PatientUID: `resolved-patient-${index}`,
      PatientID: `resolved-epm-${index}`,
      appt_date: "01/06/2020 12:00:00 AM",
      appt_cancel_ind: "False",
    });
    return [
      active,
      { ...active, appt_cancel_ind: "True", Notes: "cancellation history" },
    ];
  }).flat();
  const additionalAmbiguousOne = appointmentRow({
    PatientUID: "ambiguous-patient-2",
    PatientID: "ambiguous-epm-2",
    appt_date: "01/07/2020 12:00:00 AM",
    Notes: "first booking",
  });
  const additionalAmbiguousRows = [
    additionalAmbiguousOne,
    { ...additionalAmbiguousOne, Notes: "second booking" },
  ];
  const additionalAllCancelledRows = Array.from({ length: 10 }, (_, index) => {
    const cancelled = appointmentRow({
      PatientUID: `all-cancelled-patient-${index}`,
      PatientID: `all-cancelled-epm-${index}`,
      appt_date: "01/08/2020 12:00:00 AM",
      appt_cancel_ind: "True",
    });
    return [
      cancelled,
      { ...cancelled, appt_confirmed_ind: "True" },
    ];
  }).flat();
  const analysis = analyzeAppointmentExport(
    appointmentCsv([
      exact,
      exact,
      cancelActive,
      cancelHistory,
      ambiguousOne,
      ambiguousTwo,
      allCancelledOne,
      allCancelledTwo,
      ...additionalResolvedRows,
      ...additionalAmbiguousRows,
      ...additionalAllCancelledRows,
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
    allCancelledSkipped: analysis.allCancelledSkipped,
    ambiguousCollisionGroups: analysis.ambiguousCollisionGroups,
    appointments: analysis.appointments.length,
  }, {
    sourceRows: 252,
    exactDuplicates: 1,
    rowsAfterExactDedupe: 251,
    collisionGroups: 125,
    collisionRows: 250,
    resolvedCancelGroups: 112,
    allCancelledSkipped: 11,
    ambiguousCollisionGroups: 2,
    appointments: 113,
  });
  assert.equal(
    analysis.appointments.find((entry) => entry.row.PatientUID === "patient-b")?.cancelled,
    false,
  );
  assert.equal(
    analysis.ambiguities.find((entry) => entry.patientUid === "patient-c")?.activeRows,
    2,
  );
  assert.equal(
    analysis.appointments.some((entry) => entry.row.PatientUID === "patient-d"),
    false,
  );
  assert.equal(
    analysis.ambiguities.some((entry) => entry.patientUid === "patient-d"),
    false,
  );
  assert.throws(
    () => analyzeAppointmentExport(appointmentCsv([exact]), "other-office"),
    /source office other-office is outside the verified office set 00127314, 0161582, 00127362/,
  );
  assert.throws(
    () =>
      analyzeAppointmentExport(
        appointmentCsv([exact, appointmentRow({ OfficeNum: "00127362" })]),
        "00127314",
      ),
    /row office 00127362 does not match declared source offices 00127314/,
  );
  const malformedVendorQuote = `${appointmentCsv([exact])}oct n"p`;
  assert.match(malformedVendorQuote, /,oct n"p$/);
  assert.equal(
    analyzeAppointmentExport(malformedVendorQuote, "00127314").sourceRows,
    1,
  );
});

test("cross-office appointments remain distinct when every other composite-key field matches", () => {
  const primaryOffice = appointmentRow();
  const secondOffice = { ...primaryOffice, OfficeNum: "0161582" };
  const analysis = analyzeAppointmentExport(
    appointmentCsv([primaryOffice, secondOffice]),
    ["00127314", "0161582"],
  );

  assert.notEqual(
    appointmentCompositeKey(primaryOffice),
    appointmentCompositeKey(secondOffice),
  );
  assert.equal(analysis.appointments.length, 2);
  assert.equal(analysis.collisionGroups, 0);
  assert.equal(analysis.ambiguousCollisionGroups, 0);
});

test("AppointmentsExport rejects a row outside the verified office set", () => {
  assert.throws(
    () => analyzeAppointmentExport(appointmentCsv([
      appointmentRow({ OfficeNum: "99999999" }),
    ])),
    /row office 99999999 is outside the verified office set 00127314, 0161582, 00127362/,
  );
});

test("multi-office analysis reports the source-row split for every verified office", () => {
  const analysis = analyzeAppointmentExport(appointmentCsv([
    appointmentRow({ PatientUID: "patient-a", PatientID: "epm-a" }),
    appointmentRow({
      OfficeNum: "0161582",
      PatientUID: "patient-b",
      PatientID: "epm-b",
    }),
    appointmentRow({
      OfficeNum: "0161582",
      PatientUID: "patient-c",
      PatientID: "epm-c",
    }),
    appointmentRow({
      OfficeNum: "00127362",
      PatientUID: "patient-d",
      PatientID: "epm-d",
    }),
  ]));

  assert.deepEqual(analysis.officeRowCounts, {
    "00127314": 1,
    "0161582": 2,
    "00127362": 1,
  });
  assert.equal(analysis.appointments.length, 4);
  assert.equal(analysis.collisionGroups, 0);
});

test("M2b-1 refuses a Patient with a mismatched EHR identifier before any write", async () => {
  const state = tempState();
  const manifestPath = join(state.path, "manifest.json");
  const appointmentsPath = join(state.path, "appointments.csv");
  const examsPath = join(state.path, "exams.tsv");
  writeFileSync(manifestPath, JSON.stringify(manifest()));
  writeFileSync(appointmentsPath, appointmentCsv([appointmentRow()]));
  writeFileSync(
    examsPath,
    "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye\n"
      + "ehr-typical-1\texam-1\t2020-01-02 00:00:00.000\t1\t1",
  );
  const emptyLedger = new ImportLedger({ stateDirectory: state.path });
  emptyLedger.close();

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (url.endsWith("/oauth2/token")) {
      return Response.json({ access_token: "synthetic-import-token" });
    }
    if (url.endsWith("/auth/me")) {
      return Response.json({ project: { id: PROJECT_ID } });
    }
    if (url.endsWith("/fhir/R4/Patient/patient-1")) {
      return Response.json({
        resourceType: "Patient",
        id: "patient-1",
        identifier: [
          { system: EPM_PATIENT_IDENTIFIER_SYSTEM, value: "epm-typical-1" },
          { system: EHR_PATIENT_IDENTIFIER_SYSTEM, value: "different-ehr-patient" },
        ],
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  try {
    await assert.rejects(
      runVisitImportCli({
        baseUrl: "http://192.168.1.25:8103",
        manifestPath,
        appointmentsPath,
        examsPath,
        stateDirectory: state.path,
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
      }),
      /restricted to a local self-hosted Medplum/,
    );
    await assert.rejects(
      runBulkImportCli({
        baseUrl: "http://192.168.1.25:8103",
        bulkManifestPath: join(state.path, "missing-bulk-manifest.json"),
        stateDirectory: state.path,
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
      }),
      /restricted to a local self-hosted Medplum/,
    );
    assert.equal(requests.length, 0);
    await assert.rejects(
      runVisitImportCli({
        baseUrl: "http://localhost:8103",
        manifestPath,
        appointmentsPath,
        examsPath,
        stateDirectory: state.path,
        runId: "m2b-wrong-ehr",
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
      }),
      /selected Patient does not carry the manifest EHR patient identifier/,
    );
    assert.equal(
      requests.filter(
        (request) =>
          request.url.includes("/fhir/R4/")
          && ["POST", "PUT", "PATCH"].includes(request.method),
      ).length,
      0,
    );
    const auditDatabase = new DatabaseSync(join(state.path, "legacy-import.sqlite"));
    try {
      const runs = auditDatabase.prepare("SELECT COUNT(*) AS count FROM runs").get() as {
        count: number;
      };
      const actions = auditDatabase.prepare(
        "SELECT COUNT(*) AS count FROM resource_actions",
      ).get() as { count: number };
      assert.equal(runs.count, 0);
      assert.equal(actions.count, 0);
    } finally {
      auditDatabase.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    state.cleanup();
  }
});

test("M2b-1 imports appointments, linked and technical Encounters, queues multi-appointment days, and converges", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const fhir = new MemoryVisitFhir();
  const allCancelledOne = appointmentRow({
    appt_date: "01/08/2020 12:00:00 AM",
    appt_cancel_ind: "True",
    Notes: "cancelled",
  });
  const allCancelledTwo = {
    ...allCancelledOne,
    appt_confirmed_ind: "True",
  };
  const allCancelledSourceKey = appointmentCompositeKey(allCancelledOne);
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
    appointmentRow({
      appt_date: "01/09/2020 12:00:00 AM",
      appt_start_time: "11:00:00",
      appt_end_time: "11:00:00",
    }),
    allCancelledOne,
    allCancelledTwo,
  ]);
  const examsTsv = [
    "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye",
    "ehr-typical-1\texam-1\t2020-01-02 00:00:00.000\t1\t1",
    "ehr-typical-1\texam-2\t2020-01-02 00:00:00.000\t2\t2",
    "ehr-typical-1\texam-3\t2020-01-03 00:00:00.000\t3\t3",
    "ehr-typical-1\texam-4\t2020-01-04 00:00:00.000\t4\t1",
    "ehr-typical-1\texam-5\t2020-01-05 00:00:00.000\t4\t1",
    "ehr-typical-1\texam-6\t2020-01-07 00:00:00.000\t4\t1",
    "another-patient\texam-7\t2020-01-02 00:00:00.000\t1\t1",
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

    assert.deepEqual(first.analysis, {
      sourceRows: 11,
      officeRowCounts: {
        "00127314": 11,
        "0161582": 0,
        "00127362": 0,
      },
      exactDuplicates: 0,
      rowsAfterExactDedupe: 11,
      collisionGroups: 3,
      collisionRows: 6,
      resolvedCancelGroups: 1,
      allCancelledSkipped: 1,
      ambiguousCollisionGroups: 1,
    });
    assert.deepEqual(first.appointments, {
      created: 5,
      updated: 0,
      skipped: 0,
      conflict: 1,
    });
    assert.deepEqual(first.encounters, {
      created: 4,
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
    assert.equal(first.visitDays, 5);

    const resources = fhir.resources;
    const appointments = resources.filter(
      (resource): resource is Appointment => resource.resourceType === "Appointment",
    );
    const encounters = resources.filter(
      (resource): resource is Encounter => resource.resourceType === "Encounter",
    );
    assert.equal(appointments.length, 5);
    assert.equal(encounters.length, 4);
    assert.equal(
      appointments.find((appointment) => appointment.start?.startsWith("2020-01-02"))?.status,
      "fulfilled",
    );
    assert.equal(
      appointments.find((appointment) => appointment.start?.startsWith("2020-01-05"))?.status,
      "fulfilled",
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
    const resolvedVisit = encounters.find((encounter) =>
      encounter.period?.start?.startsWith("2020-01-05")
    );
    assert.equal(
      resolvedVisit?.identifier?.[0]?.system,
      EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM,
    );
    assert.match(resolvedVisit?.appointment?.[0]?.reference ?? "", /^Appointment\//);
    const noProvider = encounters.find((encounter) =>
      encounter.period?.start?.startsWith("2020-01-07")
    );
    assert.match(noProvider?.appointment?.[0]?.reference ?? "", /^Appointment\//);
    assert.equal(noProvider?.participant, undefined);

    const report = ledger.renderReport(firstRun);
    assert.match(report, /multi-appointment-day-queued/);
    assert.match(report, /all-cancelled-collision-group/);
    assert.match(report, /non-positive-appointment-duration/);
    assert.doesNotMatch(report, /composite-collision-queued/);
    assert.match(report, /Status: completed/);
    assert.match(report, /Appointment/);
    assert.match(report, /Encounter/);
    const auditDatabase = new DatabaseSync(ledger.databasePath);
    try {
      const ambiguity = auditDatabase.prepare(`
        SELECT COUNT(*) AS count
        FROM ambiguity_queue
        WHERE source_kind = 'appointment' AND source_key = ?
      `).get(allCancelledSourceKey) as { count: number };
      const rejection = auditDatabase.prepare(`
        SELECT COUNT(*) AS count
        FROM junk_rejections
        WHERE run_id = ? AND source_key = ? AND reason = 'all-cancelled-collision-group'
      `).get(firstRun, allCancelledSourceKey) as { count: number };
      assert.equal(ambiguity.count, 0);
      assert.equal(rejection.count, 1);
    } finally {
      auditDatabase.close();
    }

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
      conflict: 1,
    });
    assert.deepEqual(second.encounters, {
      created: 0,
      updated: 0,
      skipped: 5,
      conflict: 0,
    });
    assert.deepEqual(second.practitioners, {
      created: 0,
      updated: 0,
      skipped: 1,
      conflict: 0,
    });
    assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Appointment").length, 5);
    assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Encounter").length, 4);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("M2b-1 keeps patient-b linked and ledgers an adopted Practitioner by legacy source key", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const fhir = new MemoryVisitFhir();
  fhir.resources.push({
    resourceType: "Practitioner",
    id: "native-practitioner",
    meta: { versionId: "1" },
    identifier: [{
      system: "https://example.test/native-provider",
      value: "native-provider-id",
    }],
    name: [{ given: ["Synthetic"], family: "Doctor" }],
  });
  const active = appointmentRow({
    PatientUID: "patient-b",
    PatientID: "epm-b",
    appt_date: "01/03/2020 12:00:00 AM",
    appt_cancel_ind: "False",
  });
  const cancellationHistory = {
    ...active,
    appt_cancel_ind: "True",
    Notes: "cancellation history",
  };

  try {
    const runId = ledger.startRun("m2b-patient-b");
    const result = await importLegacyAppointmentsAndEncounters({
      fhir,
      ledger,
      runId,
      projectId: PROJECT_ID,
      manifest: {
        ...manifest(),
        patientUid: "patient-b",
        epmPatientId: "epm-b",
        ehrPatientId: "ehr-b",
      },
      appointmentsCsv: appointmentCsv([active, cancellationHistory]),
      examsTsv: [
        "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye",
        "ehr-b\texam-b\t2020-01-03 00:00:00.000\t1\t1",
      ].join("\n"),
      now: new Date("2026-07-29T12:00:00Z"),
    });
    ledger.finishRun(runId, "completed");

    assert.deepEqual(result.analysis, {
      sourceRows: 2,
      officeRowCounts: {
        "00127314": 2,
        "0161582": 0,
        "00127362": 0,
      },
      exactDuplicates: 0,
      rowsAfterExactDedupe: 2,
      collisionGroups: 1,
      collisionRows: 2,
      resolvedCancelGroups: 1,
      allCancelledSkipped: 0,
      ambiguousCollisionGroups: 0,
    });
    const appointment = fhir.resources.find(
      (resource): resource is Appointment => resource.resourceType === "Appointment",
    );
    const encounter = fhir.resources.find(
      (resource): resource is Encounter => resource.resourceType === "Encounter",
    );
    assert.equal(appointment?.status, "fulfilled");
    assert.equal(encounter?.appointment?.[0]?.reference, `Appointment/${appointment?.id}`);

    const adopted = fhir.resources.find(
      (resource): resource is Practitioner =>
        resource.resourceType === "Practitioner" && resource.id === "native-practitioner",
    );
    assert.equal(adopted?.identifier?.[0]?.value, "native-provider-id");
    const auditDatabase = new DatabaseSync(ledger.databasePath);
    try {
      const action = auditDatabase.prepare(`
        SELECT source_key, reason
        FROM resource_actions
        WHERE run_id = ? AND resource_type = 'Practitioner'
      `).get(runId) as { source_key: string; reason: string };
      assert.equal(action.source_key, "provider-1");
      assert.equal(action.reason, "adopted-native-name-match");
    } finally {
      auditDatabase.close();
    }
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("M2b-1 refuses an ambiguous New York fall-back wall time", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  try {
    const runId = ledger.startRun("m2b-dst-fallback");
    await assert.rejects(
      importLegacyAppointmentsAndEncounters({
        fhir: new MemoryVisitFhir(),
        ledger,
        runId,
        projectId: PROJECT_ID,
        manifest: manifest(),
        appointmentsCsv: appointmentCsv([
          appointmentRow({
            appt_date: "11/01/2020 12:00:00 AM",
            appt_start_time: "01:30:00",
            appt_end_time: "02:00:00",
            ProviderID: "",
            ProviderFirst: "",
            ProviderLast: "",
          }),
        ]),
        examsTsv: "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye\n",
      }),
      /2020-11-01 01:30:00 is not an unambiguous America\/New_York wall time/,
    );
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("M2b-1 requires explicit visit-type mappings and the default M2a operator-chart refusal stays intact", async () => {
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
    assert.equal(
      listPendingDecisions(ledger, { runId }).some(
        (decision) =>
          decision.kind === "adjudication"
          && decision.sourceKind === "appointment",
      ),
      true,
    );

    const providerRows = [
      appointmentRow({
        ProviderFirst: "First",
        appt_date: "01/02/2020 12:00:00 AM",
      }),
      appointmentRow({
        ProviderFirst: "Different",
        appt_date: "01/03/2020 12:00:00 AM",
      }),
    ];
    const providerResult = await importLegacyAppointmentsAndEncounters({
      fhir: new MemoryVisitFhir(),
      ledger,
      runId,
      projectId: PROJECT_ID,
      manifest: manifest(),
      appointmentsCsv: appointmentCsv(providerRows),
      examsTsv: "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye\n",
    });
    assert.equal(providerResult.practitioners.conflict, 1);
    const providerDecision = listPendingDecisions(ledger, { runId }).find(
      (decision) =>
        decision.kind === "adjudication"
        && decision.sourceKind === "provider",
    );
    assert.deepEqual(providerDecision?.decisions, ["exclude"]);
    assert.throws(
      () => applyDecisionFile(ledger, {
        decidedBy: "test-operator",
        allocations: [],
        adjudications: [{
          sourceKind: "provider",
          sourceKey: "provider-1",
          decision: "keep",
        }],
      }),
      /decision keep is not allowed/,
    );
    assert.deepEqual(
      applyDecisionFile(ledger, {
        decidedBy: "test-operator",
        allocations: [],
        adjudications: [{
          sourceKind: "provider",
          sourceKey: "provider-1",
          decision: "exclude",
        }],
      }),
      { recorded: 1, previouslyDecided: 0 },
    );
    const providerReplay = await importLegacyAppointmentsAndEncounters({
      fhir: new MemoryVisitFhir(),
      ledger,
      runId,
      projectId: PROJECT_ID,
      manifest: manifest(),
      appointmentsCsv: appointmentCsv(providerRows),
      examsTsv: "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye\n",
    });
    assert.equal(providerReplay.appointments.conflict, 0);
    assert.equal(providerReplay.appointments.created, 2);
    assert.match(ledger.renderReport(runId), /provider-source-name-ambiguity/);

    await assert.rejects(
      importLegacyPatient({
        fhir: new MemoryVisitFhir(),
        ledger,
        runId,
        projectId: PROJECT_ID,
        manifest: {
          epm: {
            sourceKey: "6499570",
            firstName: "Synthetic",
            lastName: "Operator",
            birthDate: "1980-01-01",
          },
          ehr: {
            sourceKey: "969",
            firstName: "Synthetic",
            lastName: "Operator",
            birthDate: "1980-01-01",
          },
          junkRows: [{
            sourceSystem: "ehr",
            sourceKey: "junk-1",
            firstName: "Junk",
            lastName: "Row",
            birthDate: "9999-12-31",
          }],
        },
      }),
      /refuses the operator test-data chart/,
    );
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("M2b-2 imports only fully allocated multi-appointment days and converges on appointment identity", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const fhir = new MemoryVisitFhir();
  const morning = appointmentRow({
    appt_date: "02/03/2020 12:00:00 AM",
    appt_start_time: "09:00:00",
    appt_end_time: "09:30:00",
  });
  const afternoon = appointmentRow({
    appt_date: "02/03/2020 12:00:00 AM",
    appt_start_time: "14:00:00",
    appt_end_time: "14:30:00",
  });
  const emptySitting = appointmentRow({
    appt_date: "02/03/2020 12:00:00 AM",
    appt_start_time: "16:00:00",
    appt_end_time: "16:30:00",
  });
  const morningKey = appointmentCompositeKey(morning);
  const afternoonKey = appointmentCompositeKey(afternoon);
  const dayKey = technicalVisitKey("ehr-typical-1", "2020-02-03");
  const appointmentsCsv = appointmentCsv([morning, afternoon, emptySitting]);
  const examsTsv = [
    "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye",
    "ehr-typical-1\texam-morning\t2020-02-03 00:00:00.000\t1\t1",
    "ehr-typical-1\texam-afternoon\t2020-02-03 00:00:00.000\t4\t1",
  ].join("\n");

  try {
    const absentRun = ledger.startRun("m2b2-allocation-absent");
    const absent = await importLegacyAppointmentsAndEncounters({
      fhir,
      ledger,
      runId: absentRun,
      projectId: PROJECT_ID,
      manifest: manifest(),
      appointmentsCsv,
      examsTsv,
    });
    ledger.finishRun(absentRun, "completed");
    assert.equal(absent.encounters.skipped, 1);
    assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Encounter").length, 0);

    ledger.recordCaptureAllocation({
      visitDaySourceKey: dayKey,
      exSrNo: "exam-morning",
      appointmentSourceKey: morningKey,
      decidedBy: "operator",
    });
    const partialRun = ledger.startRun("m2b2-allocation-partial");
    const partial = await importLegacyAppointmentsAndEncounters({
      fhir,
      ledger,
      runId: partialRun,
      projectId: PROJECT_ID,
      manifest: manifest(),
      appointmentsCsv,
      examsTsv,
    });
    ledger.finishRun(partialRun, "completed");
    assert.equal(partial.encounters.skipped, 1);
    assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Encounter").length, 0);

    assert.deepEqual(
      applyDecisionFile(ledger, {
        decidedBy: "operator",
        allocations: [
          {
            visitDaySourceKey: dayKey,
            exSrNo: "exam-morning",
            appointmentSourceKey: morningKey,
          },
          {
            visitDaySourceKey: dayKey,
            exSrNo: "exam-afternoon",
            appointmentSourceKey: afternoonKey,
          },
        ],
        adjudications: [],
      }),
      { recorded: 1, previouslyDecided: 1 },
    );

    const fullRun = ledger.startRun("m2b2-allocation-full");
    const full = await importLegacyAppointmentsAndEncounters({
      fhir,
      ledger,
      runId: fullRun,
      projectId: PROJECT_ID,
      manifest: manifest(),
      appointmentsCsv,
      examsTsv,
    });
    ledger.finishRun(fullRun, "completed");
    assert.deepEqual(full.encounters, {
      created: 2,
      updated: 0,
      skipped: 0,
      conflict: 0,
    });

    const appointments = fhir.resources.filter(
      (resource): resource is Appointment => resource.resourceType === "Appointment",
    );
    const encounters = fhir.resources.filter(
      (resource): resource is Encounter => resource.resourceType === "Encounter",
    );
    assert.equal(appointments.length, 3);
    assert.equal(encounters.length, 2);
    for (const encounter of encounters) {
      const primary = encounter.identifier?.find(
        (identifier) => identifier.system === EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM,
      );
      const appointment = appointments.find((candidate) =>
        candidate.identifier?.some(
          (identifier) =>
            identifier.system === EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM
            && identifier.value === primary?.value,
        )
      );
      assert.ok(appointment?.id);
      assert.equal(encounter.appointment?.[0]?.reference, `Appointment/${appointment.id}`);
    }
    const morningEncounter = encounters.find((encounter) =>
      encounter.identifier?.some((identifier) => identifier.value === morningKey)
    );
    const afternoonEncounter = encounters.find((encounter) =>
      encounter.identifier?.some((identifier) => identifier.value === afternoonKey)
    );
    assert.deepEqual(
      morningEncounter?.identifier
        ?.filter((identifier) => identifier.system === EYEFINITY_EXAM_IDENTIFIER_SYSTEM)
        .map((identifier) => identifier.value),
      ["exam-morning"],
    );
    assert.deepEqual(
      afternoonEncounter?.identifier
        ?.filter((identifier) => identifier.system === EYEFINITY_EXAM_IDENTIFIER_SYSTEM)
        .map((identifier) => identifier.value),
      ["exam-afternoon"],
    );

    const rerunId = ledger.startRun("m2b2-allocation-rerun");
    const rerun = await importLegacyAppointmentsAndEncounters({
      fhir,
      ledger,
      runId: rerunId,
      projectId: PROJECT_ID,
      manifest: manifest(),
      appointmentsCsv,
      examsTsv,
    });
    ledger.finishRun(rerunId, "completed");
    assert.equal(rerun.encounters.skipped, 2);
    assert.equal(
      fhir.resources.filter((resource) => resource.resourceType === "Encounter").length,
      2,
    );
    let promptCalls = 0;
    assert.deepEqual(
      await runInteractiveAdjudication({
        ledger,
        decidedBy: "operator",
        runId: absentRun,
        prompt: async () => {
          promptCalls += 1;
          return "";
        },
      }),
      { asked: 0, recorded: 0 },
    );
    assert.equal(promptCalls, 0);

    const reportPath = ledger.writeReport(fullRun);
    assert.equal(statSync(reportPath).mode & 0o777, 0o600);
    const report = ledger.renderReport(fullRun);
    assert.match(report, /## Patient roll-up/);
    assert.match(report, /## Appointments and Encounters/);
    assert.match(report, /## Capture allocations/);
    assert.match(report, /exam-morning/);
    assert.match(report, /exam-afternoon/);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("M2b-2 ignores cancelled sittings when deciding whether capture allocation is required", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const fhir = new MemoryVisitFhir();
  const active = appointmentRow({
    appt_date: "02/04/2020 12:00:00 AM",
    appt_start_time: "09:00:00",
    appt_end_time: "09:30:00",
  });
  const cancelled = appointmentRow({
    appt_date: "02/04/2020 12:00:00 AM",
    appt_start_time: "14:00:00",
    appt_end_time: "14:30:00",
    appt_cancel_ind: "True",
  });
  const activeKey = appointmentCompositeKey(active);

  try {
    const runId = ledger.startRun("m2b2-active-plus-cancelled");
    const result = await importLegacyAppointmentsAndEncounters({
      fhir,
      ledger,
      runId,
      projectId: PROJECT_ID,
      manifest: manifest(),
      appointmentsCsv: appointmentCsv([active, cancelled]),
      examsTsv: [
        "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye",
        "ehr-typical-1\texam-active\t2020-02-04 00:00:00.000\t1\t1",
      ].join("\n"),
    });

    assert.deepEqual(result.encounters, {
      created: 1,
      updated: 0,
      skipped: 0,
      conflict: 0,
    });
    assert.equal(
      listPendingDecisions(ledger, { runId }).some(
        (decision) => decision.kind === "allocation",
      ),
      false,
    );
    const encounter = fhir.resources.find(
      (resource): resource is Encounter => resource.resourceType === "Encounter",
    );
    assert.equal(
      encounter?.identifier?.find(
        (identifier) => identifier.system === EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM,
      )?.value,
      activeKey,
    );
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("M2b-2 decision replay adjudicates every operator-chart Encounter without re-asking", async () => {
  const state = tempState();
  const ledger = new ImportLedger({
    stateDirectory: state.path,
    now: () => "2026-07-30T14:00:00.000Z",
  });
  const fhir = new MemoryVisitFhir();
  const row = appointmentRow({
    PatientID: "6499570",
    appt_date: "03/02/2020 12:00:00 AM",
  });
  const appointmentKey = appointmentCompositeKey(row);
  const technicalKey = technicalVisitKey("969", "2020-03-03");
  const operatorManifest = {
    ...manifest(),
    epmPatientId: "6499570",
    ehrPatientId: "969",
  };
  const examsTsv = [
    "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye",
    "969\texam-care\t2020-03-02 00:00:00.000\t1\t1",
    "969\texam-noise\t2020-03-03 00:00:00.000\t4\t1",
  ].join("\n");
  const decisionFile = {
    decidedBy: "operator",
    allocations: [],
    adjudications: [
      {
        sourceKind: "encounter",
        sourceKey: appointmentKey,
        decision: "mark-as-test",
        note: "synthetic test sitting",
      },
      {
        sourceKind: "encounter",
        sourceKey: technicalKey,
        decision: "exclude",
        note: "synthetic noise",
      },
    ],
  };

  try {
    const pendingRun = ledger.startRun("m2b2-operator-pending");
    const pending = await importLegacyAppointmentsAndEncounters({
      fhir,
      ledger,
      runId: pendingRun,
      projectId: PROJECT_ID,
      manifest: operatorManifest,
      appointmentsCsv: appointmentCsv([row]),
      examsTsv,
    });
    ledger.finishRun(pendingRun, "completed");
    assert.equal(pending.encounters.skipped, 2);
    assert.equal(listPendingDecisions(ledger, { runId: pendingRun }).length, 2);
    assert.deepEqual(
      applyDecisionFile(ledger, decisionFile),
      { recorded: 2, previouslyDecided: 0 },
    );

    const decidedRun = ledger.startRun("m2b2-operator-decided");
    const decided = await importLegacyAppointmentsAndEncounters({
      fhir,
      ledger,
      runId: decidedRun,
      projectId: PROJECT_ID,
      manifest: operatorManifest,
      appointmentsCsv: appointmentCsv([row]),
      examsTsv,
    });
    ledger.finishRun(decidedRun, "completed");
    assert.deepEqual(decided.encounters, {
      created: 1,
      updated: 0,
      skipped: 1,
      conflict: 0,
    });
    const encounter = fhir.resources.find(
      (resource): resource is Encounter => resource.resourceType === "Encounter",
    );
    assert.equal(
      encounter?.meta?.tag?.some(
        (tag) => tag.system === "https://odos2020.com/tags/migration"
          && tag.code === MIGRATION_TEST_TAG_CODE,
      ),
      true,
    );
    assert.deepEqual(
      applyDecisionFile(ledger, decisionFile),
      { recorded: 0, previouslyDecided: 2 },
    );
    let promptCalls = 0;
    assert.deepEqual(
      await runInteractiveAdjudication({
        ledger,
        decidedBy: "operator",
        runId: pendingRun,
        prompt: async () => {
          promptCalls += 1;
          return "";
        },
      }),
      { asked: 0, recorded: 0 },
    );
    assert.equal(promptCalls, 0);

    const report = ledger.renderReport(decidedRun);
    assert.match(report, /EXCLUDED/);
    assert.match(report, /MARK-AS-TEST/);
    assert.match(report, /operator/);
    assert.match(report, /2026-07-30T14:00:00.000Z/);
    const reportPath = ledger.writeReport(decidedRun);
    assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("M2b-2 encounter decisions leave unrelated identifier conflicts open and bulk-counted", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const sourceKey = "shared-encounter-source";
  try {
    const decisionRunId = ledger.startRun("m2b2-scoped-decision");
    ledger.recordResourceAction({
      runId: decisionRunId,
      sourceKey,
      resourceType: "Encounter",
      action: "conflict",
      reason: "migration-identifier-multi-match",
    });
    ledger.recordAmbiguity({
      sourceKind: "encounter",
      sourceKey,
      ambiguityType: "migration-identifier",
      details: { matchCount: 2 },
    });
    ledger.recordAmbiguity({
      sourceKind: "encounter",
      sourceKey,
      ambiguityType: "encounter-decision",
      details: { decisions: ["keep", "exclude", "mark-as-test"] },
    });

    assert.deepEqual(
      applyDecisionFile(ledger, {
        decidedBy: "operator",
        allocations: [],
        adjudications: [{
          sourceKind: "encounter",
          sourceKey,
          decision: "keep",
        }],
      }),
      { recorded: 1, previouslyDecided: 0 },
    );
    assert.deepEqual(
      ledger.listAmbiguities({
        sourceKind: "encounter",
        sourceKey,
      }).map((ambiguity) => ({
        ambiguityType: ambiguity.ambiguityType,
        state: ambiguity.state,
      })),
      [
        { ambiguityType: "migration-identifier", state: "open" },
        { ambiguityType: "encounter-decision", state: "resolved" },
      ],
    );
    assert.deepEqual(
      listPendingDecisions(ledger, { runId: decisionRunId }),
      [{
        kind: "blocked",
        sourceKind: "encounter",
        sourceKey,
        ambiguityType: "migration-identifier",
      }],
    );

    const bulk = await runLegacyVisitBulk({
      ledger,
      runId: "m2b2-scoped-decision-bulk",
      charts: [{ chartKey: "chart-with-identifier-conflict" }],
      runChart: async (_chart, runId) => {
        ledger.recordResourceAction({
          runId,
          sourceKey,
          resourceType: "Encounter",
          action: "conflict",
          reason: "migration-identifier-multi-match",
        });
        return {
          conflicts: listPendingDecisions(ledger, { runId }).length,
        };
      },
    });
    assert.equal(bulk.charts[0]?.status, "conflict");
    assert.match(
      ledger.renderReport(bulk.charts[0]!.runId),
      /Open decisions: 1/,
    );
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("M2b-2 non-interactive CLI applies a decisions file and replays it without mutation", async () => {
  const repoPackageJsonPath = fileURLToPath(
    new URL("../../package.json", import.meta.url),
  );
  const packageJson = JSON.parse(
    readFileSync(repoPackageJsonPath, "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(
    packageJson.scripts["import-legacy-visits-m2b2"] ?? "",
    /scripts\/import-legacy-visits-m2b2\.ts$/,
  );
  const state = tempState();
  const decisionsPath = join(state.path, "decisions.json");
  const ledger = new ImportLedger({
    stateDirectory: state.path,
    now: () => "2026-07-30T15:00:00.000Z",
  });
  const runId = ledger.startRun("m2b2-decision-cli");
  ledger.recordResourceAction({
    runId,
    sourceKey: "ehr-patient",
    resourceType: "Patient",
    resourceReference: "Patient/patient-1",
    action: "skipped",
    reason: "selected-patient-verified",
  });
  ledger.recordAmbiguity({
    sourceKind: "encounter",
    sourceKey: "encounter-source",
    ambiguityType: "encounter-decision",
    details: { decisions: ["keep", "exclude", "mark-as-test"] },
  });
  ledger.recordResourceAction({
    runId,
    sourceKey: "encounter-source",
    resourceType: "Encounter",
    action: "skipped",
    reason: "encounter-adjudication-required",
  });
  ledger.finishRun(runId, "completed");
  ledger.close();
  writeFileSync(decisionsPath, JSON.stringify({
    decidedBy: "operator",
    adjudications: [{
      sourceKind: "encounter",
      sourceKey: "encounter-source",
      decision: "keep",
    }],
  }));

  try {
    assert.deepEqual(
      await runAdjudicationCli({
        stateDirectory: state.path,
        runId,
        decisionsPath,
      }),
      { recorded: 1, previouslyDecided: 0, asked: 0, pending: 0 },
    );
    const firstRead = new ImportLedger({ stateDirectory: state.path });
    const firstDecision = firstRead.readAdjudication("encounter", "encounter-source");
    firstRead.close();
    assert.equal(firstDecision?.decision, "keep");
    assert.equal(firstDecision?.decidedBy, "operator");
    assert.deepEqual(
      await runAdjudicationCli({
        stateDirectory: state.path,
        runId,
        decisionsPath,
      }),
      { recorded: 0, previouslyDecided: 1, asked: 0, pending: 0 },
    );
    const reopened = new ImportLedger({ stateDirectory: state.path });
    try {
      assert.deepEqual(
        reopened.readAdjudication("encounter", "encounter-source"),
        firstDecision,
      );
    } finally {
      reopened.close();
    }
  } finally {
    state.cleanup();
  }
});

test("M2b-2 bulk runner isolates a failed chart and records the charts that follow it", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const attempted: string[] = [];
  try {
    const result = await runLegacyVisitBulk({
      ledger,
      runId: "m2b2-bulk-synthetic",
      charts: [
        { chartKey: "chart-1" },
        { chartKey: "chart-2" },
        { chartKey: "chart-3" },
      ],
      runChart: async (chart, runId) => {
        attempted.push(chart.chartKey);
        ledger.recordResourceAction({
          runId,
          sourceKey: chart.chartKey,
          resourceType: "Patient",
          action: "skipped",
          reason: "selected-patient-verified",
        });
        if (chart.chartKey === "chart-2") throw new Error("synthetic chart failure");
        ledger.recordResourceAction({
          runId,
          sourceKey: `${chart.chartKey}-encounter`,
          resourceType: "Encounter",
          resourceReference: `Encounter/${chart.chartKey}`,
          action: "created",
          reason: "synthetic-import",
        });
        return {};
      },
    });

    assert.deepEqual(attempted, ["chart-1", "chart-2", "chart-3"]);
    assert.deepEqual(
      result.charts.map((chart) => chart.status),
      ["completed", "failed", "completed"],
    );
    assert.match(result.charts[1]?.error ?? "", /synthetic chart failure/);
    assert.match(ledger.renderReport(result.runId), /bulk-chart-failed/);
    assert.match(ledger.renderReport(result.runId), /chart-3/);
    assert.equal(statSync(result.reportPath).mode & 0o777, 0o600);
    assert.equal(
      statSync(result.charts[2]!.reportPath).mode & 0o777,
      0o600,
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
