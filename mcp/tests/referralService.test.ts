import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AllergyIntolerance,
  Bundle,
  CarePlan,
  Condition,
  Encounter,
  Media,
  Observation,
  Organization,
  Patient,
  Resource,
  ServiceRequest,
} from "@medplum/fhirtypes";
import type { FhirSearchParams } from "../src/fhir-client.js";
import {
  buildReferralServiceRequest,
  generateReferralLetterBody,
  readReferralIncludeList,
  REFERRAL_MEDIA_MAX_ATTACHMENT_BYTES,
  ReferralService,
  type ReferralFhirClient,
  type ReferralIncludeList,
} from "../src/referral/referral-service.js";

const NOW = "2026-07-18T14:00:00.000Z";
const ALL_FLAGS: ReferralIncludeList = {
  letter: true,
  demographics: true,
  history: true,
  clinical_summary: true,
  images: true,
  hipaa_cover_sheet: true,
  history_count: 2,
};

test("referral round-trips its ServiceRequest links, structured include-list, and letter generated from encounter findings and plan", async () => {
  const fhir = seededFhir();
  await fhir.create<Observation>({
    resourceType: "Observation",
    status: "final",
    code: { text: "Macular finding" },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/current" },
    valueString: "New central distortion",
  });
  await fhir.create<CarePlan>({
    resourceType: "CarePlan",
    status: "active",
    intent: "plan",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/current" },
    activity: [{ detail: { status: "not-started", description: "Retina consultation within one week" } }],
  });
  const target = await fhir.create<Organization>({
    resourceType: "Organization",
    name: "Bergstrom Retina Associates",
  });
  const service = new ReferralService(fhir, () => NOW);

  const created = await service.createReferral({
    subjectReference: "Patient/p1",
    requesterReference: "Practitioner/referrer-1",
    requesterDisplay: "Dr. Referring OD",
    targetReference: `Organization/${target.id}`,
    encounterReference: "Encounter/current",
    includeList: ALL_FLAGS,
  });
  const persisted = await fhir.read<ServiceRequest>("ServiceRequest", created.id!);

  assert.equal(persisted.subject.reference, "Patient/p1");
  assert.equal(persisted.requester?.reference, "Practitioner/referrer-1");
  assert.equal(persisted.performer?.[0]?.reference, `Organization/${target.id}`);
  assert.equal(persisted.performer?.[0]?.display, "Bergstrom Retina Associates");
  assert.equal(persisted.encounter?.reference, "Encounter/current");
  assert.equal(persisted.status, "draft");
  assert.deepEqual(readReferralIncludeList(persisted), ALL_FLAGS);
  const html = await service.assembleReferralArtifact(created.id!);
  assert.match(html, /Macular finding: New central distortion/);
  assert.match(html, /Retina consultation within one week/);
});

test("referral priority and reason text each map to their core ServiceRequest fields", async () => {
  const fhir = seededFhir();
  const target = await fhir.create<Organization>({
    resourceType: "Organization",
    name: "Retina Group",
  });
  const service = new ReferralService(fhir, () => NOW);
  const common = {
    subjectReference: "Patient/p1",
    requesterReference: "Practitioner/referrer-1",
    targetReference: `Organization/${target.id}`,
    encounterReference: "Encounter/current",
    includeList: flagsOff(),
  };

  const priorityReferral = await service.createReferral({ ...common, priority: "urgent" });
  const reasonReferral = await service.createReferral({
    ...common,
    reasonText: "New central distortion",
  });

  assert.equal(priorityReferral.priority, "urgent");
  assert.equal(priorityReferral.reasonCode, undefined);
  assert.equal(reasonReferral.priority, undefined);
  assert.deepEqual(reasonReferral.reasonCode, [{ text: "New central distortion" }]);
});

test("referral letters include only finalized findings", () => {
  const letter = generateReferralLetterBody({
    patientDisplay: "Avery Patient",
    targetDisplay: "Retina Group",
    findings: [
      observation("final", "Final finding"),
      observation("amended", "Amended finding"),
      observation("corrected", "Corrected finding"),
      observation("preliminary", "Preliminary finding"),
      observation("registered", "Registered finding"),
    ],
    plans: [],
  });

  assert.match(letter, /Final finding/);
  assert.match(letter, /Amended finding/);
  assert.match(letter, /Corrected finding/);
  assert.doesNotMatch(letter, /Preliminary finding/);
  assert.doesNotMatch(letter, /Registered finding/);
});

test("referral creation rejects an encounter that belongs to a different patient", async () => {
  const fhir = seededFhir();
  await fhir.create<Patient>({ resourceType: "Patient", id: "p2", name: [{ text: "Other Patient" }] });
  const target = await fhir.create<Organization>({ resourceType: "Organization", name: "Retina Group" });

  await assert.rejects(
    new ReferralService(fhir).createReferral({
      subjectReference: "Patient/p2",
      requesterReference: "Practitioner/referrer-1",
      targetReference: `Organization/${target.id}`,
      encounterReference: "Encounter/current",
      includeList: flagsOff(),
    }),
    /Referral encounter does not belong to the subject patient/,
  );
});

test("each include-list flag independently governs its printable section", async () => {
  const fhir = seededFhir();
  await seedArtifactResources(fhir);
  const service = new ReferralService(fhir, () => NOW);
  const sectionByFlag = {
    letter: "letter",
    demographics: "demographics",
    history: "history",
    clinical_summary: "clinical_summary",
    images: "images",
    hipaa_cover_sheet: "hipaa_cover_sheet",
  } as const;

  for (const flag of Object.keys(sectionByFlag) as Array<keyof typeof sectionByFlag>) {
    const includeList: ReferralIncludeList = {
      letter: false,
      demographics: false,
      history: false,
      clinical_summary: false,
      images: false,
      hipaa_cover_sheet: false,
      history_count: 2,
      [flag]: true,
    };
    const referral = await fhir.create<ServiceRequest>(referralResource(`only-${flag}`, includeList));
    const html = await service.assembleReferralArtifact(referral.id!);

    for (const [candidateFlag, section] of Object.entries(sectionByFlag)) {
      assert.equal(
        html.includes(`data-section="${section}"`),
        candidateFlag === flag,
        `${flag} should be the only rendered optional section`,
      );
    }
  }
});

test("history includes exactly the configured last N finalized prior exams", async () => {
  const fhir = seededFhir();
  await Promise.all([
    fhir.create<Encounter>(finishedEncounter("oldest", "2026-01-01T15:00:00.000Z", "Oldest exam")),
    fhir.create<Encounter>(finishedEncounter("middle", "2026-03-01T15:00:00.000Z", "Middle exam")),
    fhir.create<Encounter>(finishedEncounter("latest", "2026-05-01T15:00:00.000Z", "Latest exam")),
    fhir.create<Encounter>({
      ...finishedEncounter("not-finalized", "2026-06-01T15:00:00.000Z", "In progress exam"),
      status: "in-progress",
    }),
  ]);
  const referral = await fhir.create<ServiceRequest>(referralResource("history-two", {
    ...flagsOff(),
    history: true,
    history_count: 2,
  }));

  const html = await new ReferralService(fhir).assembleReferralArtifact(referral.id!);

  assert.equal((html.match(/data-history-exam/g) ?? []).length, 2);
  assert.match(html, /Latest exam/);
  assert.match(html, /Middle exam/);
  assert.doesNotMatch(html, /Oldest exam/);
  assert.doesNotMatch(html, /In progress exam/);
});

test("edited letter text replaces the auto-generated findings letter before assembly", async () => {
  const fhir = seededFhir();
  await fhir.create<Observation>({
    resourceType: "Observation",
    status: "final",
    code: { text: "AUTO FINDING" },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/current" },
    valueString: "AUTO VALUE",
  });
  const target = await fhir.create<Organization>({ resourceType: "Organization", name: "Retina Group" });
  const service = new ReferralService(fhir, () => NOW);
  const referral = await service.createReferral({
    subjectReference: "Patient/p1",
    requesterReference: "Practitioner/referrer-1",
    targetReference: `Organization/${target.id}`,
    encounterReference: "Encounter/current",
    includeList: { ...flagsOff(), letter: true },
  });

  const html = await service.assembleReferralArtifact(referral.id!, {
    editedLetterBody: "Clinician edited referral body <reviewed>",
  });

  assert.match(html, /Clinician edited referral body &lt;reviewed&gt;/);
  assert.doesNotMatch(html, /AUTO FINDING/);
  assert.doesNotMatch(html, /AUTO VALUE/);
});

test("an old referral keeps its snapshotted target display after the target resource is renamed", async () => {
  const fhir = seededFhir();
  const target = await fhir.create<Organization>({
    resourceType: "Organization",
    name: "Dr. Bergstrom, Retina",
  });
  const service = new ReferralService(fhir, () => NOW);
  const referral = await service.createReferral({
    subjectReference: "Patient/p1",
    requesterReference: "Practitioner/referrer-1",
    targetReference: `Organization/${target.id}`,
    encounterReference: "Encounter/current",
    includeList: { ...flagsOff(), letter: true },
  });
  const before = await service.assembleReferralArtifact(referral.id!);

  await fhir.update<Organization>(
    "Organization",
    target.id!,
    { ...target, name: "Bergstrom Retina Associates" },
  );
  const persisted = await fhir.read<ServiceRequest>("ServiceRequest", referral.id!);
  const after = await service.assembleReferralArtifact(persisted.id!);

  assert.match(before, /Dr\. Bergstrom, Retina/);
  assert.match(after, /Dr\. Bergstrom, Retina/);
  assert.doesNotMatch(after, /Bergstrom Retina Associates/);
  assert.equal(persisted.performer?.[0]?.display, "Dr. Bergstrom, Retina");
});

test("clinical summary omits refuted conditions and allergies", async () => {
  const fhir = seededFhir();
  await Promise.all([
    fhir.create<Condition>({
      resourceType: "Condition",
      subject: { reference: "Patient/p1" },
      verificationStatus: { coding: [{ code: "confirmed" }] },
      code: { text: "Confirmed condition" },
    }),
    fhir.create<Condition>({
      resourceType: "Condition",
      subject: { reference: "Patient/p1" },
      verificationStatus: { coding: [{ code: "refuted" }] },
      code: { text: "Refuted condition" },
    }),
    fhir.create<AllergyIntolerance>({
      resourceType: "AllergyIntolerance",
      patient: { reference: "Patient/p1" },
      verificationStatus: { coding: [{ code: "confirmed" }] },
      code: { text: "Confirmed allergy" },
    }),
    fhir.create<AllergyIntolerance>({
      resourceType: "AllergyIntolerance",
      patient: { reference: "Patient/p1" },
      verificationStatus: { coding: [{ code: "refuted" }] },
      code: { text: "Refuted allergy" },
    }),
  ]);
  const referral = await fhir.create<ServiceRequest>(referralResource("clinical-summary", {
    ...flagsOff(),
    clinical_summary: true,
  }));

  const html = await new ReferralService(fhir).assembleReferralArtifact(referral.id!);

  assert.match(html, /Confirmed condition/);
  assert.match(html, /Confirmed allergy/);
  assert.doesNotMatch(html, /Refuted condition/);
  assert.doesNotMatch(html, /Refuted allergy/);
});

test("inline media is attribute-escaped and bounded by per-file and aggregate byte budgets", async () => {
  const fhir = seededFhir();
  await Promise.all([
    fhir.create<Media>(media("accepted-one", "Accepted one", REFERRAL_MEDIA_MAX_ATTACHMENT_BYTES)),
    fhir.create<Media>(media("accepted-two", "Accepted two", REFERRAL_MEDIA_MAX_ATTACHMENT_BYTES)),
    fhir.create<Media>(media("aggregate-rejected", "Aggregate rejected", REFERRAL_MEDIA_MAX_ATTACHMENT_BYTES)),
    fhir.create<Media>(media("oversized", "Oversized", REFERRAL_MEDIA_MAX_ATTACHMENT_BYTES + 1)),
    fhir.create<Media>({
      ...media("escaped", "Escaped attachment", 1),
      content: { contentType: "image/png", title: "Escaped attachment", data: 'AA\" onerror=\"alert(1)' },
    }),
  ]);
  const referral = await fhir.create<ServiceRequest>(referralResource("images", {
    ...flagsOff(),
    images: true,
  }));

  const html = await new ReferralService(fhir).assembleReferralArtifact(referral.id!);

  assert.match(html, /Accepted one/);
  assert.match(html, /Accepted two/);
  assert.match(html, /Escaped attachment/);
  assert.match(html, /AA&quot; onerror=&quot;alert\(1\)/);
  assert.doesNotMatch(html, /AA" onerror="/);
  assert.doesNotMatch(html, /Aggregate rejected/);
  assert.doesNotMatch(html, /Oversized/);
  assert.equal(fhir.readKeys.includes("Media/accepted-one"), true);
  assert.equal(fhir.readKeys.includes("Media/accepted-two"), true);
  assert.equal(fhir.readKeys.includes("Media/escaped"), true);
  assert.equal(fhir.readKeys.includes("Media/aggregate-rejected"), false);
  assert.equal(fhir.readKeys.includes("Media/oversized"), false);
});

class MemoryFhir implements ReferralFhirClient {
  private readonly rows = new Map<string, Resource>();
  private sequence = 0;
  readonly readKeys: string[] = [];

  async create<T extends Resource>(resource: T): Promise<T> {
    const id = resource.id ?? `${resource.resourceType.toLowerCase()}-${++this.sequence}`;
    const stored = structuredClone({
      ...resource,
      id,
      meta: { ...resource.meta, versionId: "1", lastUpdated: NOW },
    }) as T;
    this.rows.set(`${resource.resourceType}/${id}`, stored);
    return structuredClone(stored);
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    if (!resource.id) throw new Error("Memory update requires an id.");
    assert.equal(resource.resourceType, resourceType);
    assert.equal(resource.id, id);
    const current = this.rows.get(`${resourceType}/${id}`);
    if (!current) throw new Error(`Missing ${resourceType}/${id}`);
    const ifMatch = extraHeaders["If-Match"]?.match(/"(.+)"/)?.[1];
    if (ifMatch && ifMatch !== current.meta?.versionId) throw fhirConflict(412);
    const versionId = String(Number(current?.meta?.versionId ?? "0") + 1);
    const stored = structuredClone({
      ...resource,
      meta: { ...resource.meta, versionId, lastUpdated: NOW },
    }) as T;
    this.rows.set(`${resourceType}/${id}`, stored);
    return structuredClone(stored);
  }

  async executeTransaction(bundle: Bundle): Promise<Bundle> {
    const serviceRequest = bundle.entry?.[0]?.resource;
    const provenance = bundle.entry?.[1]?.resource;
    if (serviceRequest?.resourceType !== "ServiceRequest" || !serviceRequest.id) {
      throw new Error("Expected a ServiceRequest transaction update.");
    }
    if (provenance?.resourceType !== "Provenance") {
      throw new Error("Expected a Provenance transaction create.");
    }
    const current = this.rows.get(`ServiceRequest/${serviceRequest.id}`);
    if (!current) throw new Error(`Missing ServiceRequest/${serviceRequest.id}`);
    const ifMatch = bundle.entry?.[0]?.request?.ifMatch?.match(/"(.+)"/)?.[1];
    if (ifMatch !== current.meta?.versionId) throw fhirConflict(412);
    const storedServiceRequest = structuredClone({
      ...serviceRequest,
      meta: {
        ...serviceRequest.meta,
        versionId: String(Number(current.meta?.versionId ?? "0") + 1),
        lastUpdated: NOW,
      },
    });
    const provenanceId = provenance.id ?? `provenance-${++this.sequence}`;
    const storedProvenance = structuredClone({ ...provenance, id: provenanceId });
    this.rows.set(`ServiceRequest/${serviceRequest.id}`, storedServiceRequest);
    this.rows.set(`Provenance/${provenanceId}`, storedProvenance);
    return {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: [
        { response: { status: "200", location: `ServiceRequest/${serviceRequest.id}/_history/${storedServiceRequest.meta.versionId}` } },
        { response: { status: "201", location: `Provenance/${provenanceId}/_history/1` } },
      ],
    };
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    this.readKeys.push(`${resourceType}/${id}`);
    const row = this.rows.get(`${resourceType}/${id}`);
    if (!row) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(row) as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: FhirSearchParams = {},
  ): Promise<Bundle<T>> {
    const query = searchRecord(params);
    let rows = [...this.rows.values()].filter((resource) => resource.resourceType === resourceType);
    if (query.patient) rows = rows.filter((resource) => patientReference(resource) === normalizePatient(query.patient));
    if (query.subject) rows = rows.filter((resource) => patientReference(resource) === query.subject);
    if (query.encounter) rows = rows.filter((resource) => encounterReference(resource) === normalizeEncounter(query.encounter));
    if (query.status) rows = rows.filter((resource) => "status" in resource && resource.status === query.status);
    if (resourceType === "Encounter" && query._sort === "-date") {
      rows.sort((left, right) => encounterDate(right).localeCompare(encounterDate(left)));
    }
    const total = rows.length;
    if (query._count) rows = rows.slice(0, Number(query._count));
    return {
      resourceType: "Bundle",
      type: "searchset",
      total,
      entry: rows.map((resource) => ({
        resource: structuredClone(summaryResource(resource, query._summary === "true")) as T,
      })),
    };
  }
}

function seededFhir(): MemoryFhir {
  const fhir = new MemoryFhir();
  void fhir.create<Patient>({
    resourceType: "Patient",
    id: "p1",
    name: [{ use: "official", given: ["Avery"], family: "Patient" }],
    birthDate: "1980-01-02",
    gender: "female",
    telecom: [{ system: "phone", value: "555-0100" }],
  });
  void fhir.create<Encounter>({
    resourceType: "Encounter",
    id: "current",
    status: "finished",
    class: { code: "AMB" },
    subject: { reference: "Patient/p1" },
    period: { end: "2026-07-18T13:00:00.000Z" },
  });
  return fhir;
}

async function seedArtifactResources(fhir: MemoryFhir): Promise<void> {
  await Promise.all([
    fhir.create<Encounter>(finishedEncounter("prior-one", "2026-06-01T15:00:00.000Z", "Prior exam")),
    fhir.create<Media>({
      resourceType: "Media",
      status: "completed",
      subject: { reference: "Patient/p1" },
      encounter: { reference: "Encounter/current" },
      content: {
        contentType: "image/png",
        data: Buffer.from("image").toString("base64"),
        title: "Macular image",
      },
    }),
    fhir.create({
      resourceType: "Condition",
      subject: { reference: "Patient/p1" },
      code: { text: "Retinal condition" },
    }),
  ]);
}

function referralResource(id: string, includeList: ReferralIncludeList): ServiceRequest {
  return {
    ...buildReferralServiceRequest({
      subjectReference: "Patient/p1",
      subjectDisplay: "Avery Patient",
      requesterReference: "Practitioner/referrer-1",
      targetReference: "Organization/target-1",
      targetDisplay: "Retina Group",
      encounterReference: "Encounter/current",
      includeList,
      letterBody: "Generated referral letter",
      authoredOn: NOW,
    }),
    id,
  };
}

function flagsOff(): ReferralIncludeList {
  return {
    letter: false,
    demographics: false,
    history: false,
    clinical_summary: false,
    images: false,
    hipaa_cover_sheet: false,
    history_count: 1,
  };
}

function finishedEncounter(id: string, end: string, display: string): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status: "finished",
    class: { code: "AMB" },
    subject: { reference: "Patient/p1" },
    period: { start: end, end },
    type: [{ text: display }],
  };
}

function observation(status: Observation["status"], text: string): Observation {
  return {
    resourceType: "Observation",
    status,
    code: { text },
  };
}

function media(id: string, title: string, size: number): Media {
  return {
    resourceType: "Media",
    id,
    status: "completed",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/current" },
    content: { contentType: "image/png", title, data: "aW1hZ2U=", size },
  };
}

function searchRecord(params: FhirSearchParams): Record<string, string> {
  if (params instanceof URLSearchParams) return Object.fromEntries(params);
  if (Array.isArray(params)) return Object.fromEntries(params);
  return params;
}

function normalizePatient(value: string): string {
  return value.startsWith("Patient/") ? value : `Patient/${value}`;
}

function normalizeEncounter(value: string): string {
  return value.startsWith("Encounter/") ? value : `Encounter/${value}`;
}

function patientReference(resource: Resource): string | undefined {
  if ("subject" in resource && resource.subject && typeof resource.subject === "object" && "reference" in resource.subject) {
    return resource.subject.reference;
  }
  if (resource.resourceType === "AllergyIntolerance") return resource.patient?.reference;
  return undefined;
}

function encounterReference(resource: Resource): string | undefined {
  if (!("encounter" in resource) || !resource.encounter || typeof resource.encounter !== "object") return undefined;
  return "reference" in resource.encounter ? resource.encounter.reference : undefined;
}

function encounterDate(resource: Resource): string {
  if (resource.resourceType !== "Encounter") return "";
  return resource.period?.end ?? resource.period?.start ?? resource.meta?.lastUpdated ?? "";
}

function summaryResource(resource: Resource, summary: boolean): Resource {
  if (!summary || resource.resourceType !== "Media") return resource;
  const content = { ...resource.content };
  delete content.data;
  return { ...resource, content };
}

function fhirConflict(status: 409 | 412): Error & { status: number } {
  return Object.assign(new Error(`FHIR ${status}`), { status });
}
