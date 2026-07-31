import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classifyApprovedJunkRows,
  generatePatientImportManifests,
  generateVisitImportManifests,
  resolveSetupStatePath,
  type PatientReferenceInput,
} from "../../scripts/legacy-import-manifest-generator.js";
import {
  parsePatientManifestGeneratorArguments,
} from "../../scripts/generate-legacy-patient-manifests.js";
import {
  parseVisitManifestGeneratorArguments,
} from "../../scripts/generate-legacy-visit-manifests.js";
import {
  appointmentEncounterImportManifestSchema,
} from "../src/legacy-import/appointment-encounter-import.js";
import {
  APPOINTMENT_EXPORT_COLUMNS,
  type AppointmentExportRow,
  VERIFIED_APPOINTMENT_EXPORT_OFFICE,
} from "../src/legacy-import/appointment-export.js";
import {
  legacyVisitBulkManifestSchema,
} from "../src/legacy-import/bulk-visit-import.js";
import {
  junkRowReasons,
  patientImportManifestSchema,
  type SourcePerson,
} from "../src/legacy-import/patient-import.js";

const PATIENT_EXPORT_COLUMNS = [
  "ID",
  "FirstName",
  "LastName",
  "LastExamDate",
  "CreatedDate",
  "BirthDate",
  "Sex",
  "email",
  "SSN",
  "OldPatientNo",
  "address1",
  "address2",
  "city",
  "state",
  "zipcode",
  "country",
  "homephone",
  "homephoneext",
  "workphone",
  "workphoneext",
  "mobilephone",
  "mobilephoneext",
  "salutation",
  "companyid",
  "HomeOffice",
  "ConversionOrigin",
  "EMRPatientNum",
  "PatientUID",
  "ExamOffice",
  "Active",
] as const;

test("phase 1 emits 12 schema-valid private manifests joined by name and DOB", () => {
  const fixture = patientFixture();
  try {
    const result = generatePatientImportManifests({
      patientExportPath: fixture.patientExportPath,
      ehrPeoplePath: fixture.ehrPeoplePath,
      outputDirectory: fixture.outputDirectory,
    });
    assert.equal(result.manifests.length, 12);
    assert.equal(result.classifiedJunkRows, 4);
    const manifests = result.manifests.map((entry) =>
      patientImportManifestSchema.parse(
        JSON.parse(readFileSync(entry.path, "utf8")),
      )
    );
    assert.equal(
      manifests.find((manifest) => manifest.ehr.sourceKey === "970")?.epm.sourceKey,
      "7000970",
    );
    assert.equal(
      manifests.find((manifest) => manifest.ehr.sourceKey === "971")?.epm.sourceKey,
      "7000971",
    );
    assert.equal(
      manifests.some((manifest) => manifest.epm.sourceKey === "unrelated-normal"),
      false,
    );
    for (const entry of result.manifests) {
      assert.equal(statSync(entry.path).mode & 0o777, 0o600);
      for (const junkRow of entry.manifest.junkRows) {
        assert.ok(junkRowReasons(junkRow).length > 0);
      }
    }
  } finally {
    fixture.cleanup();
  }
});

test("phase 1 acknowledges only the exact operator chart and never tunes junk classification to it", () => {
  const fixture = patientFixture();
  try {
    const result = generatePatientImportManifests({
      patientExportPath: fixture.patientExportPath,
      ehrPeoplePath: fixture.ehrPeoplePath,
      outputDirectory: fixture.outputDirectory,
    });
    const acknowledged = result.manifests.filter((entry) =>
      entry.importArguments.includes("--allow-operator-test-data-chart")
    );
    assert.equal(acknowledged.length, 1);
    assert.equal(acknowledged[0]?.manifest.epm.sourceKey, "6499570");
    assert.equal(acknowledged[0]?.manifest.ehr.sourceKey, "969");

    const junkRows = approvedJunkPeople();
    const operatorChart: SourcePerson = {
      sourceKey: "969",
      firstName: "Operator",
      lastName: "Chart",
      birthDate: "1980-01-01",
    };
    assert.deepEqual(
      classifyApprovedJunkRows(junkRows, "ehr"),
      classifyApprovedJunkRows([...junkRows, operatorChart], "ehr"),
    );
  } finally {
    fixture.cleanup();
  }
});

test("approved junk classification covers both sentinel dates, comma-date names, and GUID names without normal-row misfire", () => {
  const rows = [
    ...approvedJunkPeople(),
    {
      sourceKey: "normal",
      firstName: "June",
      lastName: "Normal",
      birthDate: "1980-01-01",
    },
  ];
  const classified = classifyApprovedJunkRows(rows, "ehr");
  assert.deepEqual(classified.map((row) => row.sourceKey), [
    "junk-9999",
    "junk-1899",
    "junk-comma-date",
    "junk-guid",
  ]);
  assert.deepEqual(junkRowReasons(rows[4]!), []);
});

test("phase 2 emits 12 schema-valid private slices and a relative-path bulk manifest", () => {
  const fixture = visitFixture();
  try {
    const result = generateVisitImportManifests(fixture.input);
    assert.equal(result.charts.length, 12);
    assert.equal(result.sourceAppointmentRows, 12);
    assert.equal(result.targetAppointmentRows, 12);
    assert.equal(result.targetExamRows, 11);
    assert.deepEqual(result.visitTypes, ["Office Visit"]);

    const bulk = legacyVisitBulkManifestSchema.parse(
      JSON.parse(readFileSync(result.bulkManifestPath, "utf8")),
    );
    assert.equal(bulk.charts.length, 12);
    assert.ok(bulk.charts.every((chart) =>
      !chart.manifestPath.startsWith("/")
      && !chart.appointmentsPath.startsWith("/")
      && !chart.examsPath.startsWith("/")
    ));
    assert.equal(statSync(result.bulkManifestPath).mode & 0o777, 0o600);

    for (const chart of result.charts) {
      const manifest = appointmentEncounterImportManifestSchema.parse(
        JSON.parse(readFileSync(chart.manifestPath, "utf8")),
      );
      assert.equal(manifest.organizationReference, "Organization/practice-fixture");
      assert.equal(manifest.locationReference, "Location/location-fixture");
      assert.equal(manifest.visitTypeMap["Office Visit"]?.code, "office-visit");
      for (const path of [
        chart.manifestPath,
        chart.appointmentsPath,
        chart.examsPath,
      ]) {
        assert.equal(statSync(path).mode & 0o777, 0o600);
      }
      assert.equal(readFileSync(chart.appointmentsPath, "utf8").split("\n")[0], APPOINTMENT_EXPORT_COLUMNS.join(","));
      assert.equal(
        readFileSync(chart.examsPath, "utf8").split("\n")[0],
        "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye",
      );
    }
    const chartWithoutExams = result.charts.find((chart) => chart.chartKey === "972");
    assert.equal(
      readFileSync(chartWithoutExams!.examsPath, "utf8"),
      "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye\n",
    );
  } finally {
    fixture.cleanup();
  }
});

test("phase 2 resolves setup state from ODOS_SETUP_STATE_PATH and never needs fixed ids", () => {
  const root = mkdtempSync(join(tmpdir(), "odos-manifest-state-"));
  try {
    const environment = {
      ODOS_SETUP_STATE_PATH: join(root, "selected-state.json"),
    };
    assert.equal(
      resolveSetupStatePath(undefined, environment, join(root, "other")),
      environment.ODOS_SETUP_STATE_PATH,
    );
    assert.equal(
      resolveSetupStatePath(undefined, {}, root),
      join(root, ".odos-setup-state.json"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("phase 2 hard-errors on a sqlcmd separator artifact", () => {
  const fixture = visitFixture();
  try {
    writeFileSync(
      fixture.input.examsTsvPath,
      "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye\n"
      + "------\t------\t-----------------------\t---------\t----------\n",
    );
    assert.throws(
      () => generateVisitImportManifests(fixture.input),
      /separator-artifact row/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("phase 2 reports and stops on an unmapped target appt_type", () => {
  const fixture = visitFixture();
  try {
    const appointments = appointmentRows();
    appointments[0] = { ...appointments[0]!, appt_type: "Unclassified Legacy Type" };
    writeFileSync(fixture.input.appointmentsExportPath, appointmentCsv(appointments));
    assert.throws(
      () => generateVisitImportManifests(fixture.input),
      /Unmapped target appt_type values: Unclassified Legacy Type/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("phase 2 rejects a supplied mapping that is not an exact shipped eyecare coding", () => {
  const fixture = visitFixture();
  try {
    writeFileSync(
      fixture.input.visitTypeMapPath,
      JSON.stringify({
        "Office Visit": {
          code: "invented-code",
          display: "Invented Visit",
        },
      }),
    );
    assert.throws(
      () => generateVisitImportManifests(fixture.input),
      /not an exact shipped eyecare coding/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("both generator CLIs expose the documented required paths and setup-state precedence", () => {
  const patientArgs = parsePatientManifestGeneratorArguments([
    "--patients",
    "patients.csv",
    "--ehr-people",
    "ehr.json",
    "--output",
    "patient-output",
  ]);
  assert.equal(patientArgs.patientExportPath.endsWith("/patients.csv"), true);
  assert.equal(patientArgs.ehrPeoplePath.endsWith("/ehr.json"), true);

  const visitArgs = parseVisitManifestGeneratorArguments([
    "--appointments",
    "appointments.csv",
    "--exams",
    "exams.tsv",
    "--patient-references",
    "references.json",
    "--visit-type-map",
    "visit-types.json",
    "--output",
    "visit-output",
  ], {
    ODOS_SETUP_STATE_PATH: "/synthetic/setup-state.json",
  });
  assert.equal(visitArgs.setupStatePath, "/synthetic/setup-state.json");
  assert.equal(visitArgs.outputDirectory.endsWith("/visit-output"), true);
});

function patientFixture(): {
  patientExportPath: string;
  ehrPeoplePath: string;
  outputDirectory: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "odos-patient-manifests-"));
  const patientExportPath = join(root, "PatientExport.csv");
  const ehrPeoplePath = join(root, "ehr-people.json");
  const outputDirectory = join(root, "output");
  const ehrPeople = targetPeople();
  const epmRows = [
    ...ehrPeople.map((person, index) => patientRow({
      ID: person.sourceKey === "969" ? "6499570" : `7000${person.sourceKey}`,
      FirstName: person.firstName,
      LastName: person.lastName,
      BirthDate: usDate(person.birthDate),
      PatientUID: `uid-${person.sourceKey}`,
      Sex: index % 2 === 0 ? "F" : "M",
    })),
    patientRow({
      ID: "junk-9999",
      FirstName: "Sentinel",
      LastName: "Future",
      BirthDate: "12/31/9999",
    }),
    patientRow({
      ID: "junk-1899",
      FirstName: "Sentinel",
      LastName: "Past",
      BirthDate: "12/31/1899",
    }),
    patientRow({
      ID: "junk-comma-date",
      FirstName: "Broken, 01/02/2020",
      LastName: "Name",
      BirthDate: "01/01/1980",
    }),
    patientRow({
      ID: "junk-guid",
      FirstName: "123e4567-e89b-12d3-a456-426614174000",
      LastName: "Name",
      BirthDate: "01/01/1980",
    }),
    patientRow({
      ID: "unrelated-normal",
      FirstName: "Outside",
      LastName: "Cohort",
      BirthDate: "01/01/1960",
    }),
  ];
  writeFileSync(patientExportPath, patientCsv(epmRows));
  writeFileSync(ehrPeoplePath, JSON.stringify(ehrPeople, null, 2));
  return {
    patientExportPath,
    ehrPeoplePath,
    outputDirectory,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function visitFixture(): {
  input: Parameters<typeof generateVisitImportManifests>[0];
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "odos-visit-manifests-"));
  const appointmentsExportPath = join(root, "AppointmentsExport.csv");
  const examsTsvPath = join(root, "exams.tsv");
  const patientReferencesPath = join(root, "patient-references.json");
  const visitTypeMapPath = join(root, "visit-type-map.json");
  const setupStatePath = join(root, "setup-state.json");
  const outputDirectory = join(root, "output");
  writeFileSync(appointmentsExportPath, appointmentCsv(appointmentRows()));
  writeFileSync(examsTsvPath, examTsv());
  writeFileSync(
    patientReferencesPath,
    JSON.stringify({ charts: patientReferences() }, null, 2),
  );
  writeFileSync(
    visitTypeMapPath,
    JSON.stringify({
      "Office Visit": {
        code: "office-visit",
        display: "Office Visit (Medical)",
      },
    }, null, 2),
  );
  writeFileSync(
    setupStatePath,
    JSON.stringify({
      version: "v0.5d",
      organizationId: "practice-fixture",
      locationId: "location-fixture",
    }),
  );
  return {
    input: {
      appointmentsExportPath,
      examsTsvPath,
      patientReferencesPath,
      visitTypeMapPath,
      setupStatePath,
      outputDirectory,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function targetPeople(): SourcePerson[] {
  return Array.from({ length: 12 }, (_, index) => {
    const sourceKey = String(969 + index);
    if (sourceKey === "970") {
      return {
        sourceKey,
        firstName: "Same",
        lastName: "Family",
        birthDate: "1970-01-01",
      };
    }
    if (sourceKey === "971") {
      return {
        sourceKey,
        firstName: "Same",
        lastName: "Family",
        birthDate: "2000-01-01",
      };
    }
    return {
      sourceKey,
      firstName: sourceKey === "969" ? "Operator" : `Person${sourceKey}`,
      lastName: sourceKey === "969" ? "Chart" : "Fixture",
      birthDate: `1980-01-${String(index + 1).padStart(2, "0")}`,
    };
  });
}

function approvedJunkPeople(): SourcePerson[] {
  return [
    {
      sourceKey: "junk-9999",
      firstName: "Sentinel",
      lastName: "Future",
      birthDate: "9999-12-31",
    },
    {
      sourceKey: "junk-1899",
      firstName: "Sentinel",
      lastName: "Past",
      birthDate: "1899-12-31",
    },
    {
      sourceKey: "junk-comma-date",
      firstName: "Broken, 01/02/2020",
      lastName: "Name",
      birthDate: "1980-01-01",
    },
    {
      sourceKey: "junk-guid",
      firstName: "123e4567-e89b-12d3-a456-426614174000",
      lastName: "Name",
      birthDate: "1980-01-01",
    },
  ];
}

function patientRow(overrides: Partial<Record<(typeof PATIENT_EXPORT_COLUMNS)[number], string>> = {}) {
  return {
    ID: "7000000",
    FirstName: "Fixture",
    LastName: "Patient",
    LastExamDate: "",
    CreatedDate: "01/01/2020 12:00:00 AM",
    BirthDate: "01/01/1980",
    Sex: "F",
    email: "fixture@example.test",
    SSN: "",
    OldPatientNo: "",
    address1: "1 Test Way",
    address2: "",
    city: "Greenwood",
    state: "SC",
    zipcode: "29649",
    country: "US",
    homephone: "8645550100",
    homephoneext: "",
    workphone: "",
    workphoneext: "",
    mobilephone: "",
    mobilephoneext: "",
    salutation: "",
    companyid: "",
    HomeOffice: VERIFIED_APPOINTMENT_EXPORT_OFFICE,
    ConversionOrigin: "",
    EMRPatientNum: "",
    PatientUID: "fixture-uid",
    ExamOffice: VERIFIED_APPOINTMENT_EXPORT_OFFICE,
    Active: "True",
    ...overrides,
  };
}

function patientCsv(rows: readonly ReturnType<typeof patientRow>[]): string {
  return [
    PATIENT_EXPORT_COLUMNS.join(","),
    ...rows.map((row) => PATIENT_EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(",")),
  ].join("\n") + "\n";
}

function appointmentRows(): AppointmentExportRow[] {
  return patientReferences().map((reference, index) => ({
    OfficeNum: VERIFIED_APPOINTMENT_EXPORT_OFFICE,
    PatientID: reference.epmPatientId,
    FirstName: `Patient${index + 1}`,
    lastname: "Fixture",
    BirthDate: "01/01/1980 12:00:00 AM",
    Patient_no_old: "",
    appt_date: `01/${String(index + 1).padStart(2, "0")}/2020 12:00:00 AM`,
    appt_start_time: "09:00:00",
    appt_end_time: "09:30:00",
    ProviderID: "provider-1",
    ProviderFirst: "Synthetic",
    ProviderLast: "Clinician",
    resourceid: "resource-1",
    appt_cancel_ind: "False",
    appt_confirmed_ind: "True",
    PatientUID: reference.patientUid,
    appt_type: "Office Visit",
    Notes: index === 0 ? "comma, quote \"fixture\"" : "",
  }));
}

function appointmentCsv(rows: readonly AppointmentExportRow[]): string {
  return [
    APPOINTMENT_EXPORT_COLUMNS.join(","),
    ...rows.map((row) =>
      APPOINTMENT_EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(",")
    ),
  ].join("\n") + "\n";
}

function patientReferences(): PatientReferenceInput[] {
  return targetPeople().map((person) => ({
    patientReference: `Patient/patient-${person.sourceKey}`,
    patientUid: `uid-${person.sourceKey}`,
    epmPatientId: person.sourceKey === "969" ? "6499570" : `7000${person.sourceKey}`,
    ehrPatientId: person.sourceKey,
  }));
}

function examTsv(): string {
  const rows = patientReferences()
    .filter((reference) => reference.ehrPatientId !== "972")
    .map((reference, index) => [
      reference.ehrPatientId,
      `exam-${index + 1}`,
      `2020-01-${String(index + 1).padStart(2, "0")} 00:00:00.000`,
      "4",
      "OU",
    ].join("\t"));
  return [
    "ptSrNo\texSrNo\texDateTime\texDevType\texWhichEye",
    ...rows,
  ].join("\n") + "\n";
}

function usDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}
