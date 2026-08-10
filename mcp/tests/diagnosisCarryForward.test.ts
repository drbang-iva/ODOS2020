import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type {
  Bundle,
  Condition,
  Encounter,
  Observation,
  Resource,
} from "@medplum/fhirtypes";
import express from "express";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handlePreviousExamsReadRequest,
  type PreviousExamsPage,
} from "../src/clinical-graph/diagnosis-carry-forward-endpoint.js";
import {
  buildEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition,
  type ConditionVerificationStatusCode,
} from "../src/fhir/condition.js";
import { lateralityConcept, ODOS_EXTENSION_URLS } from "../src/fhir/ophthalmology/extensions.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../src/clinical-graph/diagnosis-pick-endpoint.js";

const AUTH_CLINICIAN = "Bearer clinician";
const AUTH_FORBIDDEN = "Bearer forbidden";

test("GET previous exams returns 401 when unauthenticated", async (t) => {
  const base = await startPreviousExamRoutes(t, new MemoryFhir(), "auditor");

  const response = await fetch(`${base}/clinical-graph/encounters/current/previous-exams`);

  assert.equal(response.status, 401);
});

test("GET previous exams returns 403 without chart.read", async (t) => {
  const base = await startPreviousExamRoutes(t, new MemoryFhir(), "auditor");

  const response = await fetch(`${base}/clinical-graph/encounters/current/previous-exams`, {
    headers: { Authorization: AUTH_FORBIDDEN },
  });

  assert.equal(response.status, 403);
});

test("previous exams page returns four encounters newest-first with exact identities and explicit findings", async () => {
  const fhir = previousExamFhir();

  const response = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const page = response.body as PreviousExamsPage;
  assert.equal(page.pageSize, 4);
  assert.equal(page.encounters.length, 4);
  assert.deepEqual(page.encounters.map((group) => ({
    encounterReference: group.encounterReference,
    date: group.date,
    visitType: group.visitType,
  })), [
    { encounterReference: "Encounter/prior-1", date: "2026-07-10T09:00:00.000Z", visitType: "Routine eye exam" },
    { encounterReference: "Encounter/prior-2", date: "2026-06-10T09:00:00.000Z", visitType: "Comprehensive eye exam" },
    { encounterReference: "Encounter/prior-3", date: "2026-05-10T09:00:00.000Z", visitType: "Problem visit" },
    { encounterReference: "Encounter/prior-4", date: "2026-04-10T09:00:00.000Z", visitType: "Visit type not recorded" },
  ]);
  assert.ok(page.nextCursor);
  assert.equal(page.nextCursor.includes("http"), false);
  assert.equal(page.nextCursor.includes("Encounter"), false);
  assert.equal(page.nextCursor.includes("_page"), false);

  const first = page.encounters[0]!;
  assert.deepEqual(first.diagnoses.map((diagnosis) => diagnosis.conditionReference), [
    "Condition/prior-1-dry-eye-od",
    "Condition/prior-1-dry-eye-os",
    "Condition/prior-1-uncataloged",
  ]);
  assert.deepEqual(first.diagnoses[0], {
    conditionReference: "Condition/prior-1-dry-eye-od",
    display: "Keratoconjunctivitis sicca, right eye",
    identity: {
      diagnosisKey: "dry_eye",
      coding: [
        { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H16.221", display: "Keratoconjunctivitis sicca, right eye" },
      ],
      text: "Keratoconjunctivitis sicca, right eye",
      laterality: "OD",
    },
    findings: [
      {
        observationReference: "Observation/prior-1-staining-present",
        code: "ocular-surface::STAINING::punctate",
        display: "Punctate staining",
        presence: "present",
        grade: "2+",
        laterality: "OD",
      },
      {
        observationReference: "Observation/prior-1-filaments-absent",
        code: "ocular-surface::FILAMENTS::present",
        display: "Corneal filaments",
        presence: "absent",
        laterality: "OD",
      },
    ],
    checked: true,
    currentConditionReference: "Condition/current-dry-eye-od",
  });
  assert.equal(first.diagnoses[1]!.identity.laterality, "OS");
  assert.equal(first.diagnoses[1]!.checked, false);
  assert.deepEqual(first.diagnoses[2]!.identity, {
    coding: [
      { system: "urn:system:a", code: "alpha", display: "Alpha coding" },
      { system: "urn:system:z", code: "zeta", display: "Zeta coding" },
    ],
    text: "Literal uncataloged diagnosis",
    laterality: "UNKNOWN",
  });

  const secondDryEye = page.encounters[1]!.diagnoses.find((diagnosis) =>
    diagnosis.conditionReference === "Condition/prior-2-dry-eye-od"
  );
  assert.deepEqual(secondDryEye?.identity, first.diagnoses[0]!.identity);
  assert.equal(secondDryEye?.currentConditionReference, "Condition/current-dry-eye-od");
  assert.deepEqual(fhir.initialEncounterSearch, {
    subject: "Patient/patient-1",
    date: "lt2026-08-10T09:00:00.000Z",
    _sort: "-date",
    _count: "4",
  });
});

test("previous exams cursor loads the next four-encounter page without accepting a URL", async () => {
  const fhir = previousExamFhir();
  const first = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });
  const firstPage = first.body as PreviousExamsPage;

  const second = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: { cursor: firstPage.nextCursor },
  });

  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(second.body, {
    pageSize: 4,
    encounters: [{
      encounterReference: "Encounter/prior-5",
      date: "2026-03-10T09:00:00.000Z",
      visitType: "Annual eye exam",
      diagnoses: [],
    }],
  });
  assert.equal(fhir.followedUrls.length, 1);
  assert.equal(fhir.followedUrls[0], "/fhir/R4/Encounter?_page=2&_count=4");

  const rejected = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: { cursor: "https://attacker.example/fhir/R4/Encounter?_page=2" },
  });
  assert.equal(rejected.status, 400);
  assert.equal(fhir.followedUrls.length, 1);
});

async function startPreviousExamRoutes(
  t: TestContext,
  fhir: MemoryFhir,
  forbiddenRole: PracticeRoleId,
): Promise<string> {
  const app = express();
  app.get("/clinical-graph/encounters/:encounterId/previous-exams", async (req, res) => {
    const result = await handlePreviousExamsReadRequest({
      authenticate: async (header: string | undefined) => header === AUTH_FORBIDDEN
        ? { staffReference: "Practitioner/forbidden", actorRole: forbiddenRole, fhir: unreachableFhir }
        : header === AUTH_CLINICIAN
          ? { staffReference: "Practitioner/doc", actorRole: "clinician", fhir }
          : null,
    }, {
      authHeader: req.header("authorization"),
      params: req.params,
      query: req.query,
    });
    res.status(result.status).json(result.body);
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  t.after(() => listener.close());
  return `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
}

function deps(fhir: MemoryFhir) {
  return {
    authenticate: async (header: string | undefined) => header === AUTH_CLINICIAN
      ? { staffReference: "Practitioner/doc", actorRole: "clinician" as const, fhir }
      : null,
  };
}

function previousExamFhir(): MemoryFhir {
  const fhir = new MemoryFhir();
  fhir.resources.push({ resourceType: "Patient", id: "patient-1", active: true });
  fhir.resources.push(encounter("current", "2026-08-10T09:00:00.000Z", "Current exam", ["current-dry-eye-od"]));
  fhir.resources.push(encounter("prior-1", "2026-07-10T09:00:00.000Z", "Routine eye exam", [
    "prior-1-dry-eye-od",
    "prior-1-dry-eye-os",
    "prior-1-uncataloged",
    "prior-1-refuted",
    "prior-1-entered-error",
  ]));
  fhir.resources.push(encounter("prior-2", "2026-06-10T09:00:00.000Z", "Comprehensive eye exam", ["prior-2-dry-eye-od"]));
  fhir.resources.push(encounter("prior-3", "2026-05-10T09:00:00.000Z", "Problem visit", ["prior-3-other"]));
  fhir.resources.push(encounter("prior-4", "2026-04-10T09:00:00.000Z", undefined, ["prior-4-other"]));
  fhir.resources.push(encounter("prior-5", "2026-03-10T09:00:00.000Z", "Annual eye exam", []));

  fhir.resources.push(diagnosis("current-dry-eye-od", "current", "dry_eye", "right", "confirmed", []));
  fhir.resources.push(diagnosis("prior-1-dry-eye-od", "prior-1", "dry_eye", "right", "confirmed", [
    "prior-1-staining-present",
    "prior-1-filaments-absent",
    "prior-1-no-boolean",
    "prior-1-entered-error-observation",
  ]));
  fhir.resources.push(diagnosis("prior-1-dry-eye-os", "prior-1", "dry_eye", "left", "confirmed", []));
  fhir.resources.push({
    ...diagnosis("prior-1-uncataloged", "prior-1", undefined, "unspecified", "provisional", []),
    code: {
      coding: [
        { system: "urn:system:z", code: "zeta", display: "Zeta coding" },
        { system: "urn:system:a", code: "alpha", display: "Alpha coding" },
      ],
      text: "Literal uncataloged diagnosis",
    },
  });
  fhir.resources.push(diagnosis("prior-1-refuted", "prior-1", "refuted", "right", "refuted", []));
  fhir.resources.push(diagnosis("prior-1-entered-error", "prior-1", "entered_error", "right", "entered-in-error", []));
  fhir.resources.push(diagnosis("prior-2-dry-eye-od", "prior-2", "dry_eye", "right", "confirmed", []));
  fhir.resources.push(diagnosis("prior-3-other", "prior-3", "other", "bilateral", "differential", []));
  fhir.resources.push(diagnosis("prior-4-other", "prior-4", "other", "unspecified", "unconfirmed", []));

  fhir.resources.push(finding(
    "prior-1-staining-present",
    "prior-1",
    "ocular-surface::STAINING::punctate",
    "Punctate staining",
    true,
    "OD",
    "2+",
  ));
  fhir.resources.push(finding(
    "prior-1-filaments-absent",
    "prior-1",
    "ocular-surface::FILAMENTS::present",
    "Corneal filaments",
    false,
    "OD",
  ));
  const noBoolean = finding(
    "prior-1-no-boolean",
    "prior-1",
    "ocular-surface::TEAR::debris",
    "Tear debris",
    true,
    "OD",
  );
  delete noBoolean.valueBoolean;
  noBoolean.valueString = "present";
  fhir.resources.push(noBoolean);
  fhir.resources.push({
    ...finding(
      "prior-1-entered-error-observation",
      "prior-1",
      "ocular-surface::SCAR::present",
      "Corneal scar",
      true,
      "OD",
    ),
    status: "entered-in-error",
  });
  return fhir;
}

function encounter(
  id: string,
  date: string,
  visitType: string | undefined,
  conditionIds: string[],
): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status: id === "current" ? "in-progress" : "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
    subject: { reference: "Patient/patient-1" },
    period: { start: date, end: date },
    ...(visitType ? { type: [{ text: visitType }] } : {}),
    diagnosis: conditionIds.map((conditionId, index) =>
      buildEncounterDiagnosisComponent(`Condition/${conditionId}`, index + 1)
    ),
  };
}

function diagnosis(
  id: string,
  encounterId: string,
  diagnosisKey: string | undefined,
  laterality: "right" | "left" | "bilateral" | "unspecified",
  verificationStatus: ConditionVerificationStatusCode,
  evidenceIds: string[],
): Condition {
  const code = diagnosisKey === "dry_eye"
    ? {
        coding: [{
          system: "http://hl7.org/fhir/sid/icd-10-cm",
          code: laterality === "left" ? "H16.222" : "H16.221",
          display: `Keratoconjunctivitis sicca, ${laterality === "left" ? "left" : "right"} eye`,
        }],
        text: `Keratoconjunctivitis sicca, ${laterality === "left" ? "left" : "right"} eye`,
      }
    : { text: diagnosisKey ?? "Literal uncataloged diagnosis" };
  return {
    ...buildEncounterDiagnosisCondition({
      patientReference: "Patient/patient-1",
      encounterReference: `Encounter/${encounterId}`,
      code,
      verificationStatus,
      ...(diagnosisKey ? {
        identifiers: [{
          system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
          value: `${encounterId}::${diagnosisKey}::${laterality}`,
        }],
      } : {}),
      evidenceObservationReferences: evidenceIds.map((evidenceId) => `Observation/${evidenceId}`),
    }),
    id,
  };
}

function finding(
  id: string,
  encounterId: string,
  code: string,
  display: string,
  valueBoolean: boolean,
  laterality: "OD" | "OS" | "OU",
  grade?: string,
): Observation {
  return {
    resourceType: "Observation",
    id,
    status: "preliminary",
    code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code, display }], text: display },
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: `Encounter/${encounterId}` },
    effectiveDateTime: "2026-07-10T09:05:00.000Z",
    valueBoolean,
    extension: [{
      url: ODOS_EXTENSION_URLS.eyeLaterality,
      valueCodeableConcept: lateralityConcept(laterality),
    }],
    ...(grade ? {
      component: [{
        code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: "GRADE", display: "Grade" }] },
        valueString: grade,
      }],
    } : {}),
  };
}

const unreachableFhir = new Proxy({}, {
  get() {
    throw new Error("FHIR must not be reached before route authorization succeeds.");
  },
});

class MemoryFhir {
  readonly resources: Resource[] = [];
  readonly followedUrls: string[] = [];
  initialEncounterSearch: Record<string, string> | undefined;

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((candidate) =>
      candidate.resourceType === resourceType && candidate.id === id
    );
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource as T);
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    if (resourceType !== "Encounter") throw new Error(`Unexpected search for ${resourceType}`);
    this.initialEncounterSearch = structuredClone(params);
    return this.encounterPage(["prior-1", "prior-2", "prior-3", "prior-4"], "/fhir/R4/Encounter?_page=2&_count=4");
  }

  async searchUrl<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>> {
    if (resourceType !== "Encounter") throw new Error(`Unexpected paged search for ${resourceType}`);
    this.followedUrls.push(url);
    if (url !== "/fhir/R4/Encounter?_page=2&_count=4") throw new Error(`Unexpected next URL ${url}`);
    return this.encounterPage(["prior-5"]);
  }

  private encounterPage<T extends Resource>(ids: string[], next?: string): Bundle<T> {
    const rows = ids.map((id) => this.resources.find((resource) =>
      resource.resourceType === "Encounter" && resource.id === id
    ) as T);
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource: structuredClone(resource) })),
      ...(next ? { link: [{ relation: "next", url: next }] } : {}),
    };
  }
}
