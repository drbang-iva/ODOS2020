import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Bundle,
  Condition,
  Encounter,
  MedicationAdministration,
  Observation,
  Practitioner,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import { ODOS_CLINICAL_ATTESTATION_POLICY_URL } from "../../policy/attestation-policy-urls.js";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  DIAGNOSIS_FINDING_REASSERTION_CODE,
  ODOS_PROVENANCE_ACTIVITY_CODE_SYSTEM,
} from "../src/clinical-graph/diagnosis-carry-provenance.js";
import {
  handleExamOverviewRequest,
  type ExamOverviewFhirClient,
} from "../src/clinical-graph/exam-overview-endpoint.js";
import type {
  ExamOverviewProjection,
} from "../src/clinical-graph/exam-overview-projection.js";
import type { ClinicalFindingDefinition } from "../src/clinical-graph/glaucoma-suspect.js";
import { ODOS_VISIT_TYPE_SYSTEM } from "../src/fhir/schedulingVisitType.js";
import { mdmProblemStatusExtension } from "../src/fhir/condition.js";

test("exam overview requires chart read access before touching FHIR", async () => {
  const fhir = new OverviewMemoryFhir([]);
  const unauthenticated = await handleExamOverviewRequest(deps(fhir, null), request());
  const forbidden = await handleExamOverviewRequest(
    deps(fhir, "forbidden" as PracticeRoleId),
    request(),
  );

  assert.equal(unauthenticated.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(fhir.readCount, 0);
});

test("derived completeness and prior change survive a fresh reload with zero clinical writes", async () => {
  const resources: Resource[] = [
    encounter(),
    historyFinding("history-current", "e1", "2026-08-16T12:00:00.000Z"),
    {
      ...quantityFinding("iop-current", "e1", "2026-08-16T12:00:00.000Z", 18),
      interpretation: [{ coding: [{ code: "abnormal" }] }],
    },
    quantityFinding("iop-prior", "e0", "2026-07-10T12:00:00.000Z", 15),
  ];
  const fhir = new OverviewMemoryFhir(resources);

  const first = await handleExamOverviewRequest(deps(fhir, "provider"), request());
  const second = await handleExamOverviewRequest(deps(new OverviewMemoryFhir(resources), "provider"), request());

  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(second, first);
  const body = first.body as ExamOverviewProjection;
  const iop = body.findings.find((row) => row.findingKey === "intraocular_pressure");
  assert.deepEqual(iop?.changeFromPrior, {
    kind: "numeric",
    delta: 3,
    unit: "mmHg",
  });
  assert.equal(iop?.interpretation, "abnormal");
  assert.equal(body.sections.find((row) => row.sectionKey === "pretest")?.abnormalCount, 1);
  assert.equal(body.completeness.status, "incomplete");
  assert.equal(body.completeness.trace.find((row) => row.sectionKey === "history")?.resolved, true);
  assert.equal(fhir.writeCount, 0);
  assert.equal(fhir.resources.some((resource) => resource.resourceType === "Observation" &&
    resource.component?.some((component) => component.code.coding?.some((coding) => coding.code === "DELTA"))), false);
});

test("endpoint projects carried-unreasserted and carried-reasserted from durable Provenance", async () => {
  const current = condition("current-condition", "Encounter/e1", ["Observation/history-current"]);
  const prior = condition("prior-condition", "Encounter/e0", []);
  const resources: Resource[] = [
    encounter(),
    {
      ...encounter("e0"),
      period: { start: "2026-07-10T09:00:00.000Z" },
    },
    current,
    prior,
    historyFinding("history-current", "e1", "2026-08-16T12:00:00.000Z"),
    carryProvenance(),
  ];
  const fhir = new OverviewMemoryFhir(resources);

  const unreasserted = await handleExamOverviewRequest(deps(fhir, "provider"), request());
  assert.equal(unreasserted.status, 200, JSON.stringify(unreasserted.body));
  assert.deepEqual((unreasserted.body as ExamOverviewProjection).findings[0]?.provenance, {
    state: "carried-unreasserted",
    sourceDate: "2026-07-10T09:00:00.000Z",
  });

  fhir.resources.push(reassertionProvenance());
  const reasserted = await handleExamOverviewRequest(deps(fhir, "provider"), request());
  assert.equal(reasserted.status, 200, JSON.stringify(reasserted.body));
  assert.deepEqual((reasserted.body as ExamOverviewProjection).findings[0]?.provenance, {
    state: "carried-reasserted",
    sourceDate: "2026-07-10T09:00:00.000Z",
  });
});

test("overview context explicitly allowlists stored human-facing event, diagnosis, attestation, and summary fields", async () => {
  const dilation: Observation = {
    ...historyFinding("dilation", "e1", "2026-08-24T14:42:00.000Z"),
    code: { coding: [{ code: "entrance:dilation", display: "Dilation" }] },
    performer: [{ display: "Technician Taylor" }],
    partOf: [
      { reference: "MedicationAdministration/dilation-agent" },
      { reference: "MedicationAdministration/foreign-dilation-agent" },
      { reference: "MedicationAdministration/not-done-dilation-agent" },
      { reference: "MedicationAdministration/missing" },
      { reference: "MedicationAdministration/text-only-dilation-agent" },
    ],
    component: [{
      code: { coding: [{ code: "DFE_PERFORMED", display: "DFE performed" }] },
      valueBoolean: true,
    }],
    note: [{ text: "internal dilation bookkeeping must not become the event label" }],
  };
  const cover: Observation = {
    ...historyFinding("cover", "e1", "2026-08-24T14:41:00.000Z"),
    code: { coding: [{ code: "entrance:cover", display: "Cover test" }] },
    performer: [{ reference: "Practitioner/missing" }],
    note: [{ text: "NEAR 3 XP" }],
  };
  const administration: MedicationAdministration = {
    resourceType: "MedicationAdministration",
    id: "dilation-agent",
    status: "completed",
    medicationCodeableConcept: {
      coding: [{ code: "tropicamide-1", display: "Tropicamide 1%" }],
      text: "must not override the allowlisted display",
    },
    subject: { reference: "Patient/p1" },
    context: { reference: "Encounter/e1" },
    effectiveDateTime: "2026-08-24T14:42:00.000Z",
    performer: [{ actor: { reference: "Practitioner/doc" } }],
  };
  const practitioner: Practitioner = {
    resourceType: "Practitioner",
    id: "doc",
    active: true,
    name: [{ prefix: ["Dr."], given: ["Avery"], family: "Chen" }],
    identifier: [{ value: "internal-staff-uuid" }],
  };
  const foreignAdministration: MedicationAdministration = {
    ...administration,
    id: "foreign-dilation-agent",
    medicationCodeableConcept: { coding: [{ display: "Must not cross patient boundary" }] },
    subject: { reference: "Patient/other-patient" },
    context: { reference: "Encounter/other-encounter" },
  };
  const notDoneAdministration: MedicationAdministration = {
    ...administration,
    id: "not-done-dilation-agent",
    status: "not-done",
    medicationCodeableConcept: { coding: [{ display: "Must not render as administered" }] },
  };
  const textOnlyAdministration: MedicationAdministration = {
    ...administration,
    id: "text-only-dilation-agent",
    medicationCodeableConcept: {
      coding: [{ code: "internal-agent-code" }],
      text: "Text-only dilating agent",
    },
  };
  const diagnosis = condition("diagnosis", "Encounter/e1", ["Observation/dilation"]);
  diagnosis.code = { text: "Cataract, nuclear" };
  diagnosis.bodySite = [{ coding: [{ code: "OU", display: "OU" }] }];
  const attestation: Provenance = {
    resourceType: "Provenance",
    id: "signed-dilation",
    target: [{ reference: "Observation/dilation" }, { reference: "Patient/p1" }],
    recorded: "2026-08-24T14:43:00.000Z",
    policy: [ODOS_CLINICAL_ATTESTATION_POLICY_URL],
    agent: [{ who: { reference: "Practitioner/doc" } }],
    signature: [{
      type: [{ code: "1.2.840.10065.1.12.1.1" }],
      when: "2026-08-24T14:43:00.000Z",
      who: { reference: "Practitioner/doc" },
      data: "signed-proof",
    }],
  };
  const unsignedPerformerEvent: Provenance = {
    resourceType: "Provenance",
    id: "not-an-attestation",
    target: [{ reference: "Observation/cover" }, { reference: "Patient/p1" }],
    recorded: "2026-08-24T14:44:00.000Z",
    agent: [{ who: { display: "Must not become an attestation" } }],
    signature: [{
      type: [{ code: "untrusted-signature" }],
      when: "2026-08-24T14:44:00.000Z",
      who: { display: "Must not become an attestation" },
      data: "untrusted-proof",
    }],
  };
  const fhir = new OverviewMemoryFhir([
    encounter(), dilation, cover, administration, foreignAdministration, notDoneAdministration,
    textOnlyAdministration, practitioner, diagnosis, attestation, unsignedPerformerEvent,
  ]);

  const response = await handleExamOverviewRequest(deps(fhir, "provider"), request());

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body as ExamOverviewProjection;
  const dilationRow = body.findings.find((row) => row.findingKey === "entrance:dilation");
  const coverRow = body.findings.find((row) => row.findingKey === "entrance:cover");
  assert.deepEqual(dilationRow?.event, {
    administrations: [{
      agent: "Tropicamide 1%",
      occurredAt: "2026-08-24T14:42:00.000Z",
    }, {
      agent: "Text-only dilating agent",
      occurredAt: "2026-08-24T14:42:00.000Z",
    }],
  });
  assert.deepEqual(dilationRow?.diagnoses, [{ display: "Cataract, nuclear", laterality: "OU" }]);
  assert.deepEqual(dilationRow?.attestation, {
    attestedBy: ["Dr. Avery Chen"],
    recordedAt: "2026-08-24T14:43:00.000Z",
  });
  assert.equal(coverRow?.summary, "NEAR 3 XP");
  assert.equal(coverRow?.attestation, undefined);
  assert.doesNotMatch(JSON.stringify({
    event: dilationRow?.event,
    diagnoses: dilationRow?.diagnoses,
    attestation: dilationRow?.attestation,
    summary: coverRow?.summary,
  }), /dilation-agent|Practitioner\/doc|internal-staff-uuid|internal-agent-code|Technician Taylor|Must not become an attestation|internal dilation bookkeeping|must not override/);
});

test("optional context dependency failures omit enrichment without hiding the core overview", async () => {
  const dilation: Observation = {
    ...historyFinding("dilation", "e1", "2026-08-24T14:42:00.000Z"),
    code: { coding: [{ code: "entrance:dilation", display: "Dilation" }] },
    partOf: [{ reference: "MedicationAdministration/unavailable" }],
  };
  const attestation: Provenance = {
    resourceType: "Provenance",
    id: "signed-dilation",
    target: [{ reference: "Observation/dilation" }, { reference: "Patient/p1" }],
    recorded: "2026-08-24T14:43:00.000Z",
    policy: [ODOS_CLINICAL_ATTESTATION_POLICY_URL],
    agent: [{ who: { reference: "Practitioner/unavailable" } }],
    signature: [{
      type: [{ code: "1.2.840.10065.1.12.1.1" }],
      when: "2026-08-24T14:43:00.000Z",
      who: { reference: "Practitioner/unavailable" },
      data: "signed-proof",
    }],
  };
  const fhir = new OverviewMemoryFhir([encounter(), dilation, attestation]);
  fhir.failedReads.add("MedicationAdministration/unavailable");
  fhir.failedReads.add("Practitioner/unavailable");

  const response = await handleExamOverviewRequest(deps(fhir, "provider"), request());

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const row = (response.body as ExamOverviewProjection).findings.find((finding) =>
    finding.findingKey === "entrance:dilation"
  );
  assert.equal(row?.event, undefined);
  assert.equal(row?.attestation, undefined);
});

test("an unavailable optional attestation search does not hide current findings", async () => {
  const fhir = new OverviewMemoryFhir([
    encounter(),
    historyFinding("history-current", "e1", "2026-08-24T14:40:00.000Z"),
  ]);
  fhir.failedSearches.add("Provenance");

  const response = await handleExamOverviewRequest(deps(fhir, "provider"), request());

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((response.body as ExamOverviewProjection).findings.length, 1);
});

test("an encounter with no patient is rejected without fabricating a projection", async () => {
  const missingPatient = encounter();
  delete missingPatient.subject;
  const fhir = new OverviewMemoryFhir([missingPatient]);

  const response = await handleExamOverviewRequest(deps(fhir, "provider"), request());

  assert.equal(response.status, 400);
});

test("an entered-in-error Condition cannot resolve Assessment completeness", async () => {
  const retracted = condition("retracted-condition", "Encounter/e1", []);
  retracted.verificationStatus = { coding: [{ code: "entered-in-error" }] };
  const fhir = new OverviewMemoryFhir([encounter(), retracted]);

  const response = await handleExamOverviewRequest(deps(fhir, "provider"), request());

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body as ExamOverviewProjection;
  assert.equal(body.sections.find((row) => row.sectionKey === "assessment")?.state, "not-examined");
  assert.equal(body.completeness.trace.find((row) => row.sectionKey === "assessment")?.resolved, false);
});

test("Conditions alone cannot resolve Assessment without diagnosis rows and required problem statuses", async () => {
  const diagnosisOnly = condition("diagnosis-only", "Encounter/e1", []);
  const diagnosisRowWithoutStatus = encounter();
  diagnosisRowWithoutStatus.diagnosis = [{ condition: { reference: "Condition/diagnosis-only" } }];
  const completeAssessment = encounter();
  completeAssessment.diagnosis = [{
    condition: { reference: "Condition/diagnosis-only" },
    extension: [mdmProblemStatusExtension("stable-chronic")],
  }];

  const states = await Promise.all([
    new OverviewMemoryFhir([encounter(), diagnosisOnly]),
    new OverviewMemoryFhir([diagnosisRowWithoutStatus, diagnosisOnly]),
    new OverviewMemoryFhir([completeAssessment, diagnosisOnly]),
  ].map(async (fhir) => {
    const response = await handleExamOverviewRequest(deps(fhir, "provider"), request());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return (response.body as ExamOverviewProjection).sections
      .find((row) => row.sectionKey === "assessment")?.state;
  }));

  assert.deepEqual(states, ["not-examined", "partial", "examined"]);
});

function request() {
  return { authHeader: "Bearer clinician", params: { encounterId: "e1" } };
}

function deps(fhir: OverviewMemoryFhir, role: PracticeRoleId | null) {
  return {
    fhirBaseUrl: "https://fhir.local",
    authenticate: async () => role
      ? { staffReference: "Practitioner/doc", actorRole: role, fhir }
      : null,
    serviceFhir: fhir,
    findingDefinitions: async () => [HISTORY_DEFINITION, IOP_DEFINITION, DILATION_DEFINITION, COVER_DEFINITION],
  };
}

const HISTORY_DEFINITION: ClinicalFindingDefinition = {
  id: "finding-def-history",
  stableKey: "hpi_ros",
  display: "History",
  sectionKey: "hpi",
  anatomyTarget: "other",
  valueSchema: {},
  normalSemantics: {},
  sourceStatus: "verified-seed",
  allowDiagnosisMapping: false,
  notBillReady: true,
  active: true,
  provenance: { source: "manual", recordedAt: "2026-08-16T12:00:00.000Z" },
};

const IOP_DEFINITION: ClinicalFindingDefinition = {
  ...HISTORY_DEFINITION,
  id: "finding-def-iop",
  stableKey: "intraocular_pressure",
  display: "Intraocular pressure",
  sectionKey: "tonometry",
  anatomyTarget: "eye",
};

const DILATION_DEFINITION: ClinicalFindingDefinition = {
  ...HISTORY_DEFINITION,
  id: "finding-def-dilation",
  stableKey: "entrance:dilation",
  display: "Dilation",
  sectionKey: "entrance:dilation",
  anatomyTarget: "eye",
};

const COVER_DEFINITION: ClinicalFindingDefinition = {
  ...HISTORY_DEFINITION,
  id: "finding-def-cover",
  stableKey: "entrance:cover",
  display: "Cover test",
  sectionKey: "entrance:cover",
  anatomyTarget: "eye",
};

function encounter(id = "e1"): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status: id === "e1" ? "in-progress" : "finished",
    class: {},
    subject: { reference: "Patient/p1" },
    type: [{ coding: [{ system: ODOS_VISIT_TYPE_SYSTEM, code: "comprehensive" }] }],
  };
}

function historyFinding(
  id: string,
  encounterId: string,
  effectiveDateTime: string,
): Observation {
  return {
    resourceType: "Observation",
    id,
    status: "final",
    code: { coding: [{ code: "hpi_ros", display: "History" }] },
    subject: { reference: "Patient/p1" },
    encounter: { reference: `Encounter/${encounterId}` },
    effectiveDateTime,
    valueString: "Routine comprehensive examination",
  };
}

function quantityFinding(
  id: string,
  encounterId: string,
  effectiveDateTime: string,
  value: number,
): Observation {
  return {
    resourceType: "Observation",
    id,
    status: "final",
    code: { coding: [{ code: "intraocular_pressure", display: "Intraocular pressure" }] },
    subject: { reference: "Patient/p1" },
    encounter: { reference: `Encounter/${encounterId}` },
    effectiveDateTime,
    valueQuantity: { value, unit: "mmHg", code: "mm[Hg]" },
  };
}

function condition(id: string, encounterReference: string, evidence: string[]): Condition {
  return {
    resourceType: "Condition",
    id,
    subject: { reference: "Patient/p1" },
    encounter: { reference: encounterReference },
    code: { text: "Synthetic diagnosis" },
    evidence: evidence.length ? [{ detail: evidence.map((reference) => ({ reference })) }] : undefined,
  };
}

function carryProvenance(): Provenance {
  return {
    resourceType: "Provenance",
    id: "carry",
    target: [
      { reference: "Condition/current-condition" },
      { reference: "Observation/history-current" },
    ],
    recorded: "2026-08-16T11:00:00.000Z",
    activity: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation",
        code: "CREATE",
      }],
      text: "Diagnosis pull-forward",
    },
    agent: [{ who: { reference: "Practitioner/doc" } }],
    entity: [{ role: "source", what: { reference: "Condition/prior-condition" } }],
  };
}

function reassertionProvenance(): Provenance {
  return {
    resourceType: "Provenance",
    id: "reassertion",
    target: [{ reference: "Observation/history-current" }],
    recorded: "2026-08-16T12:00:00.000Z",
    activity: {
      coding: [{
        system: ODOS_PROVENANCE_ACTIVITY_CODE_SYSTEM,
        code: DIAGNOSIS_FINDING_REASSERTION_CODE,
      }],
      text: "Diagnosis finding reassertion",
    },
    agent: [{ who: { reference: "Practitioner/doc" } }],
  };
}

class OverviewMemoryFhir implements ExamOverviewFhirClient {
  readonly resources: Resource[];
  readonly failedReads = new Set<string>();
  readonly failedSearches = new Set<Resource["resourceType"]>();
  readCount = 0;
  writeCount = 0;

  constructor(resources: Resource[]) {
    this.resources = structuredClone(resources);
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    this.readCount += 1;
    if (this.failedReads.has(`${resourceType}/${id}`)) {
      throw Object.assign(new Error(`Unavailable ${resourceType}/${id}`), { status: 503 });
    }
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) throw Object.assign(new Error(`Missing ${resourceType}/${id}`), { status: 404 });
    return structuredClone(resource as T);
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    if (this.failedSearches.has(resourceType)) {
      throw Object.assign(new Error(`Unavailable ${resourceType} search`), { status: 503 });
    }
    const resources = this.resources.filter((resource) => {
      if (resource.resourceType !== resourceType) return false;
      if (params.encounter && (resource as Condition | Observation).encounter?.reference !== params.encounter) {
        return false;
      }
      if (params.subject && (resource as Condition | Observation).subject?.reference !== params.subject) {
        return false;
      }
      return true;
    });
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resources.map((resource) => ({ resource: structuredClone(resource as T) })),
    };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    this.writeCount += 1;
    this.resources.push(structuredClone(resource));
    return structuredClone(resource);
  }

  async update<T extends Resource>(
    _resourceType: T["resourceType"],
    _id: string,
    resource: T,
  ): Promise<T> {
    this.writeCount += 1;
    return structuredClone(resource);
  }
}
