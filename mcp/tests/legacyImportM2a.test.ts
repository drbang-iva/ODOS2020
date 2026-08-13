import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  AccessPolicy,
  Bundle,
  Patient,
  ProjectMembership,
  Resource,
} from "@medplum/fhirtypes";
import type { JsonPatchOperation, MedplumClient } from "../src/fhir-client.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
} from "../src/authz/roles.js";
import {
  ImportLedger,
} from "../src/legacy-import/import-ledger.js";
import {
  EHR_PATIENT_IDENTIFIER_SYSTEM,
  EPM_PATIENT_IDENTIFIER_SYSTEM,
  FORBIDDEN_M2A_EHR_SOURCE_KEY,
  FORBIDDEN_M2A_EPM_SOURCE_KEY,
  assertIdentityJoin,
  importLegacyPatient,
  junkRowReasons,
  type PatientImportManifest,
} from "../src/legacy-import/patient-import.js";
import {
  LiveMigratedPatientAccessGrantAdapter,
  PolicyDriftError,
  grantMigratedPatientAccess,
  type MigratedPatientAccessGrantAdapter,
} from "../../scripts/grant-migrated-patient-access.js";
import {
  ReachabilityVerificationError,
  verifyImporterProjectMembershipDenied,
  verifyLegacyImportM2aReachability,
} from "../../scripts/verify-legacy-import-m2a.js";
import {
  parsePatientImportCliArguments,
} from "../../scripts/import-legacy-patient-m2a.js";

const PROJECT_ID = "project-1";

test("importer ProjectMembership probe accepts only a 403 response", async () => {
  assert.equal(
    await verifyImporterProjectMembershipDenied({
      baseUrl: "http://localhost:8103",
      importerToken: "importer-token",
      request: async () => new Response(null, { status: 403 }),
    }),
    403,
  );
  await assert.rejects(
    verifyImporterProjectMembershipDenied({
      baseUrl: "http://localhost:8103",
      importerToken: "importer-token",
      request: async () => new Response(null, { status: 200 }),
    }),
    /returned 200; expected 403/,
  );
});

test("patient import CLI requires the explicit operator-chart acknowledgement flag", () => {
  assert.equal(
    parsePatientImportCliArguments(["--manifest", "synthetic.json"])
      .allowOperatorTestDataChart,
    false,
  );
  assert.equal(
    parsePatientImportCliArguments([
      "--manifest",
      "synthetic.json",
      "--allow-operator-test-data-chart",
    ]).allowOperatorTestDataChart,
    true,
  );
});

test("Patient import creates once, records junk, then converges and version-updates changed source data", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const fhir = new PatientFhir();
  try {
    const firstRun = ledger.startRun("run-first");
    const first = await importLegacyPatient({
      fhir,
      ledger,
      runId: firstRun,
      projectId: PROJECT_ID,
      manifest: manifest(),
    });
    ledger.finishRun(firstRun, "patient-imported");
    ledger.resumePatientImportedRun(firstRun);
    assert.throws(() => ledger.startRun(firstRun), /already exists/);
    assert.throws(
      () => ledger.finishRun("missing-run", "failed"),
      /missing-run is not present/,
    );

    assert.equal(first.action, "created");
    assert.equal(first.junkRejections, 1);
    assert.equal(fhir.patients.size, 1);
    const created = [...fhir.patients.values()][0]!;
    assert.deepEqual(
      created.identifier?.map((identifier) => [identifier.system, identifier.value]),
      [
        [EPM_PATIENT_IDENTIFIER_SYSTEM, "epm-typical-1"],
        [EHR_PATIENT_IDENTIFIER_SYSTEM, "ehr-typical-1"],
      ],
    );

    const secondRun = ledger.startRun("run-second");
    const second = await importLegacyPatient({
      fhir,
      ledger,
      runId: secondRun,
      projectId: PROJECT_ID,
      manifest: manifest(),
    });
    ledger.finishRun(secondRun, "patient-imported");
    assert.equal(second.action, "skipped");
    assert.equal(fhir.patients.size, 1);

    const changed = manifest();
    changed.epm.telecom = [{ system: "phone", value: "555-0100", use: "mobile" }];
    const thirdRun = ledger.startRun("run-third");
    const third = await importLegacyPatient({
      fhir,
      ledger,
      runId: thirdRun,
      projectId: PROJECT_ID,
      manifest: changed,
    });
    ledger.finishRun(thirdRun, "patient-imported");
    assert.equal(third.action, "updated");
    assert.equal(fhir.patients.size, 1);
    assert.deepEqual(fhir.updateHeaders, [{
      "If-Match": 'W/"1"',
      "X-ODOS-Source": "scripts/import-legacy-patient-m2a",
    }]);

    const report = ledger.renderReport(firstRun);
    assert.match(report, /Resource actions: 1/);
    assert.match(report, /Junk rejections: 1/);
    assert.doesNotMatch(report, /Typical Patient|1980-02-03/);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("Patient import refuses the operator chart unless the caller acknowledges it", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const fhir = new PatientFhir();
  try {
    await assert.rejects(
      importLegacyPatient({
        fhir,
        ledger,
        runId: ledger.startRun("run-operator-default"),
        projectId: PROJECT_ID,
        manifest: operatorManifest(),
      }),
      /M2a refuses the operator test-data chart; select one typical chart/,
    );
    assert.equal(fhir.creates, 0);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("Patient import creates an acknowledged operator chart with both migration identifiers", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const fhir = new PatientFhir();
  try {
    const result = await importLegacyPatient({
      fhir,
      ledger,
      runId: ledger.startRun("run-operator-acknowledged"),
      projectId: PROJECT_ID,
      manifest: operatorManifest(),
      allowOperatorTestDataChart: true,
    });
    assert.equal(result.action, "created");
    assert.deepEqual(
      [...fhir.patients.values()][0]?.identifier?.map(
        (identifier) => [identifier.system, identifier.value],
      ),
      [
        [EPM_PATIENT_IDENTIFIER_SYSTEM, FORBIDDEN_M2A_EPM_SOURCE_KEY],
        [EHR_PATIENT_IDENTIFIER_SYSTEM, FORBIDDEN_M2A_EHR_SOURCE_KEY],
      ],
    );
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("Patient import refuses acknowledged partial matches to the operator chart", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const fhir = new PatientFhir();
  const epmOnly = manifest();
  epmOnly.epm.sourceKey = FORBIDDEN_M2A_EPM_SOURCE_KEY;
  const ehrOnly = manifest();
  ehrOnly.ehr.sourceKey = FORBIDDEN_M2A_EHR_SOURCE_KEY;
  try {
    for (const [runId, selectedManifest] of [
      ["run-operator-epm-only", epmOnly],
      ["run-operator-ehr-only", ehrOnly],
    ] as const) {
      await assert.rejects(
        importLegacyPatient({
          fhir,
          ledger,
          runId: ledger.startRun(runId),
          projectId: PROJECT_ID,
          manifest: selectedManifest,
          allowOperatorTestDataChart: true,
        }),
        /M2a refuses the operator test-data chart; select one typical chart/,
      );
    }
    assert.equal(fhir.creates, 0);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("Patient import refuses a junk source pair with or without operator-chart acknowledgement", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const fhir = new PatientFhir();
  const defaultJunkManifest = manifest();
  defaultJunkManifest.epm.birthDate = "9999-12-31";
  defaultJunkManifest.ehr.birthDate = "9999-12-31";
  const acknowledgedOperatorJunkManifest = operatorManifest();
  acknowledgedOperatorJunkManifest.epm.birthDate = "9999-12-31";
  acknowledgedOperatorJunkManifest.ehr.birthDate = "9999-12-31";
  try {
    for (const [runId, selectedManifest, allowOperatorTestDataChart] of [
      ["run-junk-default", defaultJunkManifest, false],
      ["run-junk-acknowledged", acknowledgedOperatorJunkManifest, true],
    ] as const) {
      await assert.rejects(
        importLegacyPatient({
          fhir,
          ledger,
          runId: ledger.startRun(runId),
          projectId: PROJECT_ID,
          manifest: selectedManifest,
          allowOperatorTestDataChart,
        }),
        /Selected source pair is a junk-row candidate \(sentinel-birth-date\)/,
      );
    }
    assert.equal(fhir.creates, 0);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("Patient adoption attaches both migration identifiers to one exact native name+DOB match", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const native: Patient = {
    resourceType: "Patient",
    id: "native-1",
    meta: { versionId: "7", project: PROJECT_ID },
    name: [
      { family: "Patient", given: ["Typical"] },
      { use: "old", family: "Maiden", given: ["Typical"] },
    ],
    birthDate: "1980-02-03",
    gender: "unknown",
  };
  const fhir = new PatientFhir([native]);
  try {
    const runId = ledger.startRun("run-adopt");
    const result = await importLegacyPatient({
      fhir,
      ledger,
      runId,
      projectId: PROJECT_ID,
      manifest: manifest(),
    });
    assert.equal(result.action, "updated");
    assert.equal(result.patientReference, "Patient/native-1");
    assert.equal(fhir.patients.size, 1);
    assert.equal(fhir.updateHeaders[0]?.["If-Match"], 'W/"7"');
    assert.deepEqual(
      fhir.patients.get("native-1")?.identifier?.map((identifier) => identifier.system),
      [EPM_PATIENT_IDENTIFIER_SYSTEM, EHR_PATIENT_IDENTIFIER_SYSTEM],
    );
    assert.deepEqual(
      fhir.patients.get("native-1")?.name,
      [
        { family: "Patient", given: ["Typical"] },
        { use: "old", family: "Maiden", given: ["Typical"] },
      ],
    );
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("Patient convergence ignores server reordering of managed repeating fields", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const fhir = new PatientFhir();
  const source = manifest();
  source.epm.telecom = [
    { system: "phone", value: "555-0100", use: "mobile" },
    { system: "email", value: "patient@example.test", use: "home" },
  ];
  source.epm.address = [
    { use: "home", line: ["1 Main St"], city: "Example" },
    { use: "old", line: ["2 Prior St"], city: "Example" },
  ];
  try {
    await importLegacyPatient({
      fhir,
      ledger,
      runId: ledger.startRun("run-order-first"),
      projectId: PROJECT_ID,
      manifest: source,
    });
    const patient = [...fhir.patients.values()][0]!;
    patient.identifier?.reverse();
    patient.telecom?.reverse();
    patient.address?.reverse();

    const rerun = await importLegacyPatient({
      fhir,
      ledger,
      runId: ledger.startRun("run-order-second"),
      projectId: PROJECT_ID,
      manifest: source,
    });
    assert.equal(rerun.action, "skipped");
    assert.equal(fhir.updateHeaders.length, 0);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("Patient adoption reports an ambiguous native match without creating or updating", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const fhir = new PatientFhir([
    nativePatient("native-1"),
    nativePatient("native-2"),
  ]);
  try {
    const result = await importLegacyPatient({
      fhir,
      ledger,
      runId: ledger.startRun("run-conflict"),
      projectId: PROJECT_ID,
      manifest: manifest(),
    });
    assert.equal(result.action, "conflict");
    assert.equal(fhir.creates, 0);
    assert.equal(fhir.updateHeaders.length, 0);
    assert.match(ledger.renderReport("run-conflict"), /native-identity-multi-match:2/);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("person identity and junk filters enforce the approved source rules", () => {
  assert.throws(
    () => assertIdentityJoin(
      manifest().epm,
      { ...manifest().ehr, birthDate: "1980-02-04" },
    ),
    /do not match on firstName\+lastName\+birthDate/,
  );
  assert.deepEqual(junkRowReasons({
    sourceKey: "junk-sentinel",
    firstName: "Junk",
    lastName: "Row",
    birthDate: "9999-12-31",
  }), ["sentinel-birth-date"]);
  assert.deepEqual(junkRowReasons({
    sourceKey: "junk-date-name",
    firstName: "Junk, 1/2/2000",
    lastName: "Row",
    birthDate: "2000-01-02",
  }), ["comma-date-in-name"]);
  assert.deepEqual(junkRowReasons({
    sourceKey: "junk-guid",
    firstName: "550e8400-e29b-41d4-a716-446655440000",
    lastName: "Row",
    birthDate: "2000-01-02",
  }), ["guid-name"]);
});

test("adjudication decisions persist when the SQLite ledger is reopened", () => {
  const state = tempState();
  const decidedAt = "2026-07-29T12:34:56.000Z";
  const first = new ImportLedger({
    stateDirectory: state.path,
    now: () => decidedAt,
  });
  first.recordAdjudication({
    sourceKind: "patient",
    sourceKey: "source-key-1",
    decision: "exclude",
    decidedBy: "operator",
    note: "synthetic test decision",
  });
  first.close();
  const reopened = new ImportLedger({ stateDirectory: state.path });
  try {
    assert.deepEqual(reopened.readAdjudication("patient", "source-key-1"), {
      decision: "exclude",
      decidedBy: "operator",
      decidedAt,
      note: "synthetic test decision",
    });
  } finally {
    reopened.close();
    state.cleanup();
  }
});

test("ImportLedger enforces mode 0700 on its PHI-adjacent state directory", () => {
  const state = tempState();
  const stateDirectory = join(state.path, "ledger-state");
  mkdirSync(stateDirectory, { mode: 0o777 });
  const ledger = new ImportLedger({ stateDirectory });
  try {
    assert.equal(statSync(stateDirectory).mode & 0o777, 0o700);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("operator provisioning writes exactly clinician + front-desk grants and converges on rerun", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const adapter = new GrantAdapter();
  try {
    const firstRun = ledger.startRun("grant-first");
    const first = await grantMigratedPatientAccess({
      adapter,
      ledger,
      runId: firstRun,
      patientReference: "Patient/patient-1",
      clinicianProfileReference: "Practitioner/clinician-1",
      frontDeskProfileReference: "Practitioner/front-desk-1",
    });
    ledger.finishRun(firstRun, "completed");

    assert.deepEqual(first, {
      patientReference: "Patient/patient-1",
      generalPractitioner: "added",
      clinicianMembership: "added",
      frontDeskMembership: "added",
    });
    assert.deepEqual(adapter.patient.generalPractitioner, [{
      reference: "Practitioner/clinician-1",
    }]);
    assert.equal(adapter.memberships.size, 2);
    assert.deepEqual(patientEntry(adapter.memberships.get("clinician-1")!), {
      policy: "AccessPolicy/clinician-policy",
      parameters: [
        ["provider_profile", "Practitioner/clinician-1"],
        ["patient_compartment", "Patient/patient-1"],
      ],
    });
    assert.deepEqual(patientEntry(adapter.memberships.get("front-desk-1")!), {
      policy: "AccessPolicy/front-desk-policy",
      parameters: [["patient_compartment", "Patient/patient-1"]],
    });
    assert.deepEqual(adapter.versionHeaders, ['W/"1"', 'W/"1"', 'W/"1"']);

    const secondRun = ledger.startRun("grant-second");
    const second = await grantMigratedPatientAccess({
      adapter,
      ledger,
      runId: secondRun,
      patientReference: "Patient/patient-1",
      clinicianProfileReference: "Practitioner/clinician-1",
      frontDeskProfileReference: "Practitioner/front-desk-1",
    });
    ledger.finishRun(secondRun, "completed");
    assert.deepEqual(second, {
      patientReference: "Patient/patient-1",
      generalPractitioner: "skipped",
      clinicianMembership: "skipped",
      frontDeskMembership: "skipped",
    });
    assert.equal(adapter.versionHeaders.length, 3);
    assert.match(ledger.renderReport(secondRun), /Access grants: 3/);
    assert.match(ledger.renderReport(secondRun), /generalPractitioner/);
    assert.match(ledger.renderReport(secondRun), /provider_profile/);
    assert.match(ledger.renderReport(secondRun), /patient_compartment/);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("operator provisioning hard-stops an existing compartment entry with the wrong role shape", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const adapter = new GrantAdapter();
  adapter.memberships.get("clinician-1")!.access!.push({
    policy: { reference: "AccessPolicy/clinician-policy" },
    parameter: [{
      name: "patient_compartment",
      valueString: "Patient/patient-1",
    }],
  });
  try {
    const runId = ledger.startRun("grant-conflict");
    await assert.rejects(
      grantMigratedPatientAccess({
        adapter,
        ledger,
        runId,
        patientReference: "Patient/patient-1",
        clinicianProfileReference: "Practitioner/clinician-1",
        frontDeskProfileReference: "Practitioner/front-desk-1",
      }),
      /does not match the required role shape/,
    );
    assert.match(ledger.renderReport(runId), /conflict/);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("operator provisioning records policy drift and refuses every grant", async () => {
  const state = tempState();
  const ledger = new ImportLedger({ stateDirectory: state.path });
  const adapter = new GrantAdapter();
  adapter.policies.get("staff")!.resource![0]!.interaction = ["read"];
  try {
    const runId = ledger.startRun("grant-policy-drift");
    await assert.rejects(
      grantMigratedPatientAccess({
        adapter,
        ledger,
        runId,
        patientReference: "Patient/patient-1",
        clinicianProfileReference: "Practitioner/clinician-1",
        frontDeskProfileReference: "Practitioner/front-desk-1",
      }),
      PolicyDriftError,
    );
    assert.equal(adapter.versionHeaders.length, 0);
    assert.match(ledger.renderReport(runId), /AccessPolicy\/front-desk-policy/);
    assert.match(ledger.renderReport(runId), /canonical-policy-rules-diverged/);
  } finally {
    ledger.close();
    state.cleanup();
  }
});

test("live policy resolution uses active-project search context and hard-stops duplicates", async () => {
  const policy: AccessPolicy = {
    ...buildMedplumAccessPolicy(getRoleDeclaration("staff")),
    id: "front-desk-policy",
  };
  const rows = [policy];
  const fhir = {
    search: async () => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource })),
    }),
  } as unknown as MedplumClient;
  const adapter = new LiveMigratedPatientAccessGrantAdapter(fhir, PROJECT_ID);
  assert.equal(await adapter.resolvePolicy("staff"), policy);

  const drifted = structuredClone(policy);
  drifted.resource![0]!.interaction = ["read"];
  const driftAdapter = new LiveMigratedPatientAccessGrantAdapter({
    search: async () => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: [{ resource: drifted }],
    }),
  } as unknown as MedplumClient, PROJECT_ID);
  await assert.rejects(
    driftAdapter.resolvePolicy("staff"),
    /rules diverge from the canonical staff AccessPolicy/,
  );

  rows.push({ ...policy, id: "front-desk-policy-duplicate" });
  await assert.rejects(
    adapter.resolvePolicy("staff"),
    /Expected one tagged ODOS Staff policy; found 2/,
  );
});

test("reachability gate requires every ordinary-role allow and both front-desk denials", async () => {
  const statuses = new Map<string, number>([
    ["/fhir/R4/Patient?_id=patient-1|provider", 200],
    ["/fhir/R4/Patient/patient-1|provider", 200],
    ["/fhir/R4/Encounter/encounter-1|provider", 200],
    ["/fhir/R4/Media/media-1|provider", 200],
    ["/fhir/R4/Observation/observation-1|provider", 200],
    ["/fhir/R4/Patient?_id=patient-1|staff", 200],
    ["/fhir/R4/Patient/patient-1|staff", 200],
    ["/fhir/R4/Coverage/coverage-1|staff", 200],
    ["/fhir/R4/Encounter/encounter-1|staff", 200],
    ["/fhir/R4/Media/media-1|staff", 200],
    ["/fhir/R4/Observation/observation-1|staff", 200],
  ]);
  const request = async (urlValue: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(urlValue));
    const token = String((init?.headers as Record<string, string>)?.Authorization ?? "")
      .replace("Bearer ", "");
    if (url.pathname === "/auth/me") {
      const role = token === "provider" ? "clinician-1" : "front-desk-1";
      return Response.json({
        project: { id: PROJECT_ID, superAdmin: false },
        profile: { resourceType: "Practitioner", id: role },
      });
    }
    const status = statuses.get(`${url.pathname}${url.search}|${token}`) ?? 500;
    if (url.pathname === "/fhir/R4/Patient" && status === 200) {
      return Response.json({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: { resourceType: "Patient", id: "patient-1" } }],
      }, { status });
    }
    return new Response("", { status });
  };
  const result = await verifyLegacyImportM2aReachability({
    baseUrl: "http://localhost:8103",
    clinicianToken: "provider",
    frontDeskToken: "staff",
    clinicianProfileReference: "Practitioner/clinician-1",
    frontDeskProfileReference: "Practitioner/front-desk-1",
    patientReference: "Patient/patient-1",
    encounterReference: "Encounter/encounter-1",
    mediaReference: "Media/media-1",
    coverageReference: "Coverage/coverage-1",
    observationReference: "Observation/observation-1",
    request: request as typeof fetch,
  });
  assert.deepEqual(result.transcript, [
    "clinician patient_search status=200 matches=1",
    "clinician patient_read status=200",
    "clinician encounter_read status=200",
    "clinician media_read status=200",
    "clinician observation_read status=200",
    "front_desk patient_search status=200 matches=1",
    "front_desk patient_read status=200",
    "front_desk coverage_read status=200",
    "front_desk encounter_read status=200",
    "front_desk media_read status=200",
    "front_desk observation_read status=200",
  ]);

  statuses.set("/fhir/R4/Media/media-1|staff", 403);
  await assert.rejects(
    verifyLegacyImportM2aReachability({
      baseUrl: "http://localhost:8103",
      clinicianToken: "provider",
      frontDeskToken: "staff",
      clinicianProfileReference: "Practitioner/clinician-1",
      frontDeskProfileReference: "Practitioner/front-desk-1",
      patientReference: "Patient/patient-1",
      encounterReference: "Encounter/encounter-1",
      mediaReference: "Media/media-1",
      coverageReference: "Coverage/coverage-1",
      observationReference: "Observation/observation-1",
      request: request as typeof fetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ReachabilityVerificationError);
      assert.equal(error.transcript.at(-1), "front_desk media_read status=403");
      return true;
    },
  );
});

class PatientFhir {
  readonly patients = new Map<string, Patient>();
  readonly updateHeaders: Array<Record<string, string>> = [];
  creates = 0;

  constructor(patients: readonly Patient[] = []) {
    for (const patient of patients) this.patients.set(patient.id!, structuredClone(patient));
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    assert.equal(resourceType, "Patient");
    let rows = [...this.patients.values()];
    if (params.identifier) {
      const [system, value] = params.identifier.split("|");
      rows = rows.filter((patient) => patient.identifier?.some((identifier) =>
        identifier.system === system && identifier.value === value
      ));
    }
    if (params.family) {
      rows = rows.filter((patient) => patient.name?.some(
        (name) => name.family === params.family,
      ));
    }
    if (params.birthdate) {
      rows = rows.filter((patient) => patient.birthDate === params.birthdate);
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource: resource as T })),
    };
  }

  async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
    throw new Error("Unexpected paged search.");
  }

  async create<T extends Resource>(
    resource: T,
  ): Promise<T> {
    assert.equal(resource.resourceType, "Patient");
    this.creates += 1;
    const patient = {
      ...structuredClone(resource as Patient),
      id: `created-${this.creates}`,
      meta: { ...(resource.meta ?? {}), versionId: "1" },
    };
    this.patients.set(patient.id, patient);
    return patient as T;
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers: Record<string, string>,
  ): Promise<T> {
    assert.equal(resourceType, "Patient");
    const existing = this.patients.get(id)!;
    assert.equal(headers["If-Match"], `W/"${existing.meta?.versionId}"`);
    this.updateHeaders.push(headers);
    const patient = {
      ...structuredClone(resource as Patient),
      meta: {
        ...(resource.meta ?? {}),
        versionId: String(Number(existing.meta?.versionId ?? "0") + 1),
      },
    };
    this.patients.set(id, patient);
    return patient as T;
  }
}

class GrantAdapter implements MigratedPatientAccessGrantAdapter {
  patient: Patient = {
    resourceType: "Patient",
    id: "patient-1",
    meta: { versionId: "1" },
  };
  readonly policies = new Map<string, AccessPolicy>([
    ["provider", policy("clinician-policy", "provider")],
    ["staff", policy("front-desk-policy", "staff")],
  ]);
  readonly memberships = new Map<string, ProjectMembership>([
    ["clinician-1", membership(
      "membership-clinician",
      "Practitioner/clinician-1",
      "AccessPolicy/clinician-policy",
    )],
    ["front-desk-1", membership(
      "membership-front-desk",
      "Practitioner/front-desk-1",
      "AccessPolicy/front-desk-policy",
    )],
  ]);
  readonly versionHeaders: string[] = [];

  async readPatient(): Promise<Patient> {
    return structuredClone(this.patient);
  }

  async resolveMembership(profileReference: string): Promise<ProjectMembership> {
    return structuredClone(this.memberships.get(profileReference.split("/")[1]!)!);
  }

  async resolvePolicy(role: "provider" | "staff"): Promise<AccessPolicy> {
    return structuredClone(this.policies.get(role)!);
  }

  async patchPatient(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<Patient> {
    assert.equal(id, this.patient.id);
    this.versionHeaders.push(`W/"${versionId}"`);
    applyPatientPatch(this.patient, operations);
    this.patient.meta = { ...this.patient.meta, versionId: String(Number(versionId) + 1) };
    return structuredClone(this.patient);
  }

  async patchMembership(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<ProjectMembership> {
    const membership = [...this.memberships.values()].find((row) => row.id === id)!;
    this.versionHeaders.push(`W/"${versionId}"`);
    applyMembershipPatch(membership, operations);
    membership.meta = { ...membership.meta, versionId: String(Number(versionId) + 1) };
    return structuredClone(membership);
  }
}

function manifest(): PatientImportManifest {
  return {
    epm: {
      sourceKey: "epm-typical-1",
      firstName: "Typical",
      lastName: "Patient",
      birthDate: "1980-02-03",
      gender: "unknown",
    },
    ehr: {
      sourceKey: "ehr-typical-1",
      firstName: "Typical",
      lastName: "Patient",
      birthDate: "1980-02-03",
    },
    junkRows: [{
      sourceSystem: "ehr",
      sourceKey: "junk-row-1",
      firstName: "Junk",
      lastName: "Row",
      birthDate: "9999-12-31",
    }],
  };
}

function operatorManifest(): PatientImportManifest {
  const value = manifest();
  value.epm.sourceKey = FORBIDDEN_M2A_EPM_SOURCE_KEY;
  value.ehr.sourceKey = FORBIDDEN_M2A_EHR_SOURCE_KEY;
  return value;
}

function nativePatient(id: string): Patient {
  return {
    resourceType: "Patient",
    id,
    meta: { versionId: "1", project: PROJECT_ID },
    name: [{ family: "Patient", given: ["Typical"] }],
    birthDate: "1980-02-03",
    gender: "unknown",
  };
}

function policy(id: string, role: "provider" | "staff"): AccessPolicy {
  return {
    ...buildMedplumAccessPolicy(getRoleDeclaration(role)),
    id,
  };
}

function membership(
  id: string,
  profileReference: string,
  policyReference: string,
): ProjectMembership {
  return {
    resourceType: "ProjectMembership",
    id,
    meta: { versionId: "1" },
    project: { reference: `Project/${PROJECT_ID}` },
    profile: { reference: profileReference },
    access: [{ policy: { reference: policyReference } }],
  };
}

function patientEntry(membership: ProjectMembership): {
  policy: string | undefined;
  parameters: Array<[string | undefined, string | undefined]>;
} {
  const entry = membership.access?.find((access) =>
    access.parameter?.some((parameter) => parameter.name === "patient_compartment")
  )!;
  return {
    policy: entry.policy.reference,
    parameters: entry.parameter!.map((parameter) => [
      parameter.name,
      parameter.valueReference?.reference ?? parameter.valueString,
    ]),
  };
}

function applyPatientPatch(patient: Patient, operations: JsonPatchOperation[]): void {
  for (const operation of operations) {
    if (operation.op !== "add") throw new Error("Unexpected Patient patch operation.");
    if (operation.path === "/generalPractitioner") {
      patient.generalPractitioner = structuredClone(operation.value) as Patient["generalPractitioner"];
    } else if (operation.path === "/generalPractitioner/-") {
      patient.generalPractitioner!.push(
        structuredClone(operation.value) as NonNullable<Patient["generalPractitioner"]>[number],
      );
    } else {
      throw new Error(`Unexpected Patient patch path ${operation.path}.`);
    }
  }
}

function applyMembershipPatch(
  membership: ProjectMembership,
  operations: JsonPatchOperation[],
): void {
  for (const operation of operations) {
    if (operation.op !== "add") throw new Error("Unexpected membership patch operation.");
    if (operation.path === "/access") {
      membership.access = structuredClone(operation.value) as ProjectMembership["access"];
    } else if (operation.path === "/access/-") {
      membership.access!.push(
        structuredClone(operation.value) as NonNullable<ProjectMembership["access"]>[number],
      );
    } else {
      throw new Error(`Unexpected membership patch path ${operation.path}.`);
    }
  }
}

function tempState(): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), "odos-m2a-"));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}
