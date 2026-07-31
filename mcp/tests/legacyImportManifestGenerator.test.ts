import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  classifyApprovedJunkRows,
  generatePatientImportManifests,
  generateVisitImportManifests,
  isDirectExecution,
  PATIENT_EXPORT_COLUMNS,
  resolveSetupStatePath,
  shellArgument,
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

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("phase 1 emits 12 schema-valid private manifests joined by name and DOB", () => {
  const fixture = patientFixture();
  try {
    const result = generatePatientImportManifests({
      patientExportPath: fixture.patientExportPath,
      ehrPeoplePath: fixture.ehrPeoplePath,
      outputDirectory: fixture.outputDirectory,
      expectedChartCount: 12,
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
      assert.equal(entry.manifest.junkRows.length, 4);
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
      expectedChartCount: 12,
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
    chmodSync(result.bulkManifestPath, 0o644);
    generateVisitImportManifests(fixture.input);
    assert.equal(statSync(result.bulkManifestPath).mode & 0o777, 0o600);
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

test("phase 2 allows a quoted separator-shaped value when the row is not an artifact", () => {
  const fixture = visitFixture();
  try {
    writeFileSync(
      fixture.input.examsTsvPath,
      readFileSync(fixture.input.examsTsvPath, "utf8").replace("\t4\tOU", "\t\"---\"\tOU"),
    );
    assert.equal(generateVisitImportManifests(fixture.input).targetExamRows, 11);
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
    "--expected-charts",
    "13",
    "--output",
    "patient-output",
  ]);
  assert.equal(patientArgs.patientExportPath.endsWith("/patients.csv"), true);
  assert.equal(patientArgs.ehrPeoplePath.endsWith("/ehr.json"), true);
  assert.equal(patientArgs.expectedChartCount, 13);

  const visitArgs = parseVisitManifestGeneratorArguments([
    "--appointments",
    "appointments.csv",
    "--exams",
    "exams.tsv",
    "--patient-references",
    "references.json",
    "--visit-type-map",
    "visit-types.json",
    "--expected-charts",
    "13",
    "--output",
    "visit-output",
  ], {
    ODOS_SETUP_STATE_PATH: "/synthetic/setup-state.json",
  });
  assert.equal(visitArgs.setupStatePath, "/synthetic/setup-state.json");
  assert.equal(visitArgs.outputDirectory.endsWith("/visit-output"), true);
  assert.equal(visitArgs.expectedChartCount, 13);
  assert.throws(
    () => parsePatientManifestGeneratorArguments([
      "--patients",
      "one.csv",
      "--patients",
      "two.csv",
      "--ehr-people",
      "ehr.json",
      "--expected-charts",
      "12",
      "--output",
      "output",
    ]),
    /--patients was supplied more than once/,
  );
  assert.throws(
    () => parseVisitManifestGeneratorArguments([
      "--appointments",
      "appointments.csv",
      "--exams",
      "exams.tsv",
      "--patient-references",
      "references.json",
      "--visit-type-map",
      "visit-types.json",
      "--expected-charts",
      "12",
      "--out",
      "output",
    ]),
    /Unknown argument --out/,
  );
});

test("both generator CLIs exit non-zero when --expected-charts is omitted", () => {
  const patient = runGeneratorCli("generate-legacy-patient-manifests.ts", [
    "--patients",
    "patients.csv",
    "--ehr-people",
    "ehr.json",
    "--output",
    "output",
  ]);
  assert.equal(patient.status, 1);
  assert.match(patient.stderr, /--expected-charts requires a value\./);

  const visit = runGeneratorCli("generate-legacy-visit-manifests.ts", [
    "--appointments",
    "appointments.csv",
    "--exams",
    "exams.tsv",
    "--patient-references",
    "references.json",
    "--visit-type-map",
    "visit-types.json",
    "--output",
    "output",
  ]);
  assert.equal(visit.status, 1);
  assert.match(visit.stderr, /--expected-charts requires a value\./);
});

test("both generator CLIs reject non-positive and non-numeric expected chart counts", () => {
  for (const value of ["0", "-1", "not-a-number"]) {
    const patient = runGeneratorCli("generate-legacy-patient-manifests.ts", [
      "--patients",
      "patients.csv",
      "--ehr-people",
      "ehr.json",
      "--expected-charts",
      value,
      "--output",
      "output",
    ]);
    assert.equal(patient.status, 1);
    assert.match(
      patient.stderr,
      new RegExp(`--expected-charts must be a positive integer; got "${value}"\\.`),
    );

    const visit = runGeneratorCli("generate-legacy-visit-manifests.ts", [
      "--appointments",
      "appointments.csv",
      "--exams",
      "exams.tsv",
      "--patient-references",
      "references.json",
      "--visit-type-map",
      "visit-types.json",
      "--expected-charts",
      value,
      "--output",
      "output",
    ]);
    assert.equal(visit.status, 1);
    assert.match(
      visit.stderr,
      new RegExp(`--expected-charts must be a positive integer; got "${value}"\\.`),
    );
  }
});

test("both phases report independently supplied expected and actual chart counts", () => {
  const patient = patientFixture();
  try {
    assert.throws(
      () => generatePatientImportManifests({
        patientExportPath: patient.patientExportPath,
        ehrPeoplePath: patient.ehrPeoplePath,
        outputDirectory: patient.outputDirectory,
        expectedChartCount: 13,
      }),
      /exactly 13 non-junk charts; got 12/,
    );
  } finally {
    patient.cleanup();
  }

  const visit = visitFixture();
  try {
    assert.throws(
      () => generateVisitImportManifests({
        ...visit.input,
        expectedChartCount: 13,
      }),
      /exactly 13 chart objects; got 12/,
    );
  } finally {
    visit.cleanup();
  }
});

test("a synthetic 13-chart cohort passes both phases with independently supplied counts", () => {
  const patient = patientFixture(13);
  try {
    const result = generatePatientImportManifests({
      patientExportPath: patient.patientExportPath,
      ehrPeoplePath: patient.ehrPeoplePath,
      outputDirectory: patient.outputDirectory,
      expectedChartCount: 13,
    });
    assert.equal(result.manifests.length, 13);
  } finally {
    patient.cleanup();
  }

  const visit = visitFixture(13);
  try {
    const result = generateVisitImportManifests(visit.input);
    assert.equal(result.charts.length, 13);
    assert.equal(result.targetAppointmentRows, 13);
    assert.equal(result.targetExamRows, 12);
  } finally {
    visit.cleanup();
  }
});

test("bulk visit manifest schema accepts non-empty unique cohorts of different sizes", () => {
  for (const chartCount of [1, 12, 13]) {
    assert.equal(
      legacyVisitBulkManifestSchema.safeParse({
        charts: bulkFileCharts(chartCount),
      }).success,
      true,
    );
  }

  assert.equal(
    legacyVisitBulkManifestSchema.safeParse({ charts: [] }).success,
    false,
  );

  const duplicateKeys = bulkFileCharts(2);
  duplicateKeys[1] = {
    ...duplicateKeys[1]!,
    chartKey: duplicateKeys[0]!.chartKey,
  };
  const duplicateResult = legacyVisitBulkManifestSchema.safeParse({
    charts: duplicateKeys,
  });
  assert.equal(duplicateResult.success, false);
  if (!duplicateResult.success) {
    assert.equal(
      duplicateResult.error.issues.some((issue) =>
        issue.message === "Bulk chart keys must be unique."
      ),
      true,
    );
  }
});

test("direct-execution and printed shell arguments tolerate spaces and metacharacters", () => {
  const spacedPath = resolve("/tmp/ODOS synthetic checkout/generator.ts");
  assert.equal(isDirectExecution(pathToFileURL(spacedPath).href, spacedPath), true);
  assert.equal(shellArgument("/tmp/plain-path.json"), "/tmp/plain-path.json");
  assert.equal(
    shellArgument("/tmp/a path/$(unsafe)'file.json"),
    "'/tmp/a path/$(unsafe)'\"'\"'file.json'",
  );
});

test("phase 1 refuses to assign one EPM source row to two EHR cohort people", () => {
  const fixture = patientFixture();
  try {
    const people = JSON.parse(readFileSync(fixture.ehrPeoplePath, "utf8")) as SourcePerson[];
    people[2] = {
      ...people[2]!,
      firstName: people[1]!.firstName,
      lastName: people[1]!.lastName,
      birthDate: people[1]!.birthDate,
    };
    writeFileSync(fixture.ehrPeoplePath, JSON.stringify(people));
    assert.throws(
      () => generatePatientImportManifests({
        patientExportPath: fixture.patientExportPath,
        ehrPeoplePath: fixture.ehrPeoplePath,
        outputDirectory: fixture.outputDirectory,
        expectedChartCount: 12,
      }),
      /matched more than one EHR cohort person/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("phase 1 refuses zero matches, a non-12 cohort, and a partial operator pair", () => {
  const zeroMatch = patientFixture();
  try {
    const people = readEhrPeople(zeroMatch.ehrPeoplePath);
    people[3] = { ...people[3]!, firstName: "NoMatchingEpm" };
    writeFileSync(zeroMatch.ehrPeoplePath, JSON.stringify(people));
    assert.throws(
      () => generatePatientImportManifests({
        patientExportPath: zeroMatch.patientExportPath,
        ehrPeoplePath: zeroMatch.ehrPeoplePath,
        outputDirectory: zeroMatch.outputDirectory,
        expectedChartCount: 12,
      }),
      /matched 0 PatientExport rows/,
    );
  } finally {
    zeroMatch.cleanup();
  }

  const wrongCount = patientFixture();
  try {
    writeFileSync(
      wrongCount.ehrPeoplePath,
      JSON.stringify(readEhrPeople(wrongCount.ehrPeoplePath).slice(0, 11)),
    );
    assert.throws(
      () => generatePatientImportManifests({
        patientExportPath: wrongCount.patientExportPath,
        ehrPeoplePath: wrongCount.ehrPeoplePath,
        outputDirectory: wrongCount.outputDirectory,
        expectedChartCount: 12,
      }),
      /exactly 12 non-junk charts; got 11/,
    );
  } finally {
    wrongCount.cleanup();
  }

  const partialOperator = patientFixture();
  try {
    const people = readEhrPeople(partialOperator.ehrPeoplePath);
    people[0] = { ...people[0]!, sourceKey: "not-969" };
    writeFileSync(partialOperator.ehrPeoplePath, JSON.stringify(people));
    assert.throws(
      () => generatePatientImportManifests({
        patientExportPath: partialOperator.patientExportPath,
        ehrPeoplePath: partialOperator.ehrPeoplePath,
        outputDirectory: partialOperator.outputDirectory,
        expectedChartCount: 12,
      }),
      /operator chart acknowledgement is valid only for the exact/,
    );
  } finally {
    partialOperator.cleanup();
  }
});

test("phase 2 refuses out-of-cohort exams, PatientUID mismatches, and missing appointment slices", () => {
  const outOfCohort = visitFixture();
  try {
    writeFileSync(
      outOfCohort.input.examsTsvPath,
      readFileSync(outOfCohort.input.examsTsvPath, "utf8")
      + "outside\texam-x\t2020-01-01 00:00:00.000\t4\tOU\n",
    );
    assert.throws(
      () => generateVisitImportManifests(outOfCohort.input),
      /out-of-cohort ptSrNo outside/,
    );
  } finally {
    outOfCohort.cleanup();
  }

  const uidMismatch = visitFixture();
  try {
    const rows = appointmentRows();
    rows[0] = { ...rows[0]!, PatientUID: "wrong-uid" };
    writeFileSync(uidMismatch.input.appointmentsExportPath, appointmentCsv(rows));
    assert.throws(
      () => generateVisitImportManifests(uidMismatch.input),
      /instead of supplied/,
    );
  } finally {
    uidMismatch.cleanup();
  }

  const missingAppointments = visitFixture();
  try {
    writeFileSync(
      missingAppointments.input.appointmentsExportPath,
      appointmentCsv(appointmentRows().slice(1)),
    );
    assert.throws(
      () => generateVisitImportManifests(missingAppointments.input),
      /AppointmentsExport has no rows for EPM patients: 6499570/,
    );
  } finally {
    missingAppointments.cleanup();
  }
});

test("phase 2 refuses embedded TSV delimiter characters after parsing", () => {
  const fixture = visitFixture();
  try {
    const tsv = readFileSync(fixture.input.examsTsvPath, "utf8");
    writeFileSync(
      fixture.input.examsTsvPath,
      tsv.replace("exam-1", "\"exam-1\tshift\""),
    );
    assert.throws(
      () => generateVisitImportManifests(fixture.input),
      /exSrNo contains a delimiter character/,
    );
  } finally {
    fixture.cleanup();
  }
});

function patientFixture(chartCount = 12): {
  patientExportPath: string;
  ehrPeoplePath: string;
  outputDirectory: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "odos-patient-manifests-"));
  const patientExportPath = join(root, "PatientExport.csv");
  const ehrPeoplePath = join(root, "ehr-people.json");
  const outputDirectory = join(root, "output");
  const ehrPeople = targetPeople(chartCount);
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

function visitFixture(chartCount = 12): {
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
  writeFileSync(appointmentsExportPath, appointmentCsv(appointmentRows(chartCount)));
  writeFileSync(examsTsvPath, examTsv(chartCount));
  writeFileSync(
    patientReferencesPath,
    JSON.stringify({ charts: patientReferences(chartCount) }, null, 2),
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
      expectedChartCount: chartCount,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function targetPeople(chartCount = 12): SourcePerson[] {
  const people = Array.from({ length: chartCount }, (_, index) => {
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
  assert.equal(new Set(people.map((person) => person.birthDate)).size, people.length);
  return people;
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

function readEhrPeople(path: string): SourcePerson[] {
  return JSON.parse(readFileSync(path, "utf8")) as SourcePerson[];
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

function appointmentRows(chartCount = 12): AppointmentExportRow[] {
  return patientReferences(chartCount).map((reference, index) => ({
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

function patientReferences(chartCount = 12): PatientReferenceInput[] {
  return targetPeople(chartCount).map((person) => ({
    patientReference: `Patient/patient-${person.sourceKey}`,
    patientUid: `uid-${person.sourceKey}`,
    epmPatientId: person.sourceKey === "969" ? "6499570" : `7000${person.sourceKey}`,
    ehrPatientId: person.sourceKey,
  }));
}

function examTsv(chartCount = 12): string {
  const rows = patientReferences(chartCount)
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

function runGeneratorCli(script: string, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(REPOSITORY_ROOT, "scripts", script), ...args],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
}

function bulkFileCharts(chartCount: number) {
  return Array.from({ length: chartCount }, (_, index) => ({
    chartKey: `chart-${index + 1}`,
    manifestPath: `charts/chart-${index + 1}/manifest.json`,
    appointmentsPath: `charts/chart-${index + 1}/appointments.csv`,
    examsPath: `charts/chart-${index + 1}/exams.tsv`,
  }));
}

function usDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}
