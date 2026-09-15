import { randomUUID } from "node:crypto";
import type { Account, Bundle, Coverage, Patient, Person, RelatedPerson, Resource, Task } from "@medplum/fhirtypes";
import { buildCoverageSaveBundle, emptyCoverageDraft } from "../../../ui/src/lib/patient-insurance.js";
import {
  CONSENT_AUTHORITY_EXTENSION_URL,
  RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL,
  registerPatientFromDemographics,
  type PatientRegistrationInput,
} from "../../src/clinic/patient-registration-endpoint.js";
import { GUARANTOR_CLAIM_URL, GUARANTOR_OPERATION_SYSTEM } from "../../src/clinic/guarantor-link-operation.js";
import { guarantorReaderFixture } from "./guarantor-reader-fixture.js";

export const CENSUS_PROJECT_A = "census-project-a";
export const CENSUS_PROJECT_B = "census-project-b";
export const CENSUS_SERVICE = "ClientApplication/census-service";
export const CENSUS_TODAY = "2026-09-15";

const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function registrationWriterResources(): Promise<{ patient: Patient; relatedPerson: RelatedPerson; person: Person; account: Account }> {
  let transaction: Bundle | undefined;
  const capture = new Error("registration bundle captured");
  const input: PatientRegistrationInput = {
    demographics: {
      firstName: "ALEX", middleName: "", lastName: "EXAM", preferredName: "",
      birthDate: "2015-04-03", gender: "female",
      phones: [{ value: "864-555-0100", use: "home" }, { value: "", use: "mobile" }], textable: "",
      email: "", address: "1 Synthetic Way", city: "Greenville", state: "SC", postalCode: "29601",
    },
    responsibleParties: [{
      localId: "guardian-new", kind: "person", relationship: "parent", financialResponsible: true,
      consentAuthority: true, primary: true, courtOrderNotes: "", effectiveDate: "2026-01-01", endDate: "",
      birthDate: "1980-01-02", firstName: "ODOS", middleName: "", lastName: "EXAM", phones: [{ value: "864-555-0101", use: "home" }, { value: "", use: "mobile" }], textable: "",
      address: "2 Synthetic Way", city: "Greenville", state: "SC", postalCode: "29601",
    }],
    confirmDuplicate: false,
  };
  const fhir = {
    baseUrl: "http://registration-writer-fixture.test",
    async search<T extends Resource>(): Promise<Bundle<T>> { return { resourceType: "Bundle", type: "searchset", entry: [] }; },
    async searchProject<T extends Resource>(): Promise<Bundle<T>> { return { resourceType: "Bundle", type: "searchset", entry: [] }; },
    async searchProjectUrl<T extends Resource>(): Promise<Bundle<T>> { throw new Error("unexpected registration pagination"); },
    async create<T extends Resource>(resource: T): Promise<T> {
      return { ...resource, id: "registration-reservation", meta: { ...resource.meta, project: CENSUS_PROJECT_A, versionId: "1" } } as T;
    },
    async executeTransactionAsActor(bundle: Bundle): Promise<Bundle> { transaction = jsonRoundTrip(bundle); throw capture; },
  };
  try {
    await registerPatientFromDemographics(input, {
      staffReference: "Practitioner/synthetic-registration-staff", actorRole: "staff", roles: ["staff"],
      businessActions: ["patients.register"], project: { reference: `Project/${CENSUS_PROJECT_A}` },
    }, { serviceFhir: fhir as never, now: () => `${CENSUS_TODAY}T12:00:00.000Z` });
  } catch (error) {
    if (error !== capture) throw error;
  }
  if (!transaction) throw new Error("The registration writer did not emit a transaction fixture.");
  const patient = jsonRoundTrip(transaction.entry!.find(entry => entry.resource?.resourceType === "Patient")!.resource as Patient);
  const relatedPerson = jsonRoundTrip(transaction.entry!.find(entry => entry.resource?.resourceType === "RelatedPerson")!.resource as RelatedPerson);
  const person = jsonRoundTrip(transaction.entry!.find(entry => entry.resource?.resourceType === "Person")!.resource as Person);
  const account = jsonRoundTrip(transaction.entry!.find(entry => entry.resource?.resourceType === "Account")!.resource as Account);
  patient.id = "writer-patient";
  relatedPerson.id = "writer-related";
  relatedPerson.patient = { reference: `Patient/${patient.id}` };
  person.id = "writer-person";
  person.link = [{ target: { reference: `RelatedPerson/${relatedPerson.id}` }, assurance: "level2" }];
  account.id = "writer-account";
  account.subject = [{ reference: `Patient/${patient.id}` }];
  account.guarantor = [{ party: { reference: `RelatedPerson/${relatedPerson.id}` }, onHold: false }];
  for (const resource of [patient, relatedPerson, person, account]) {
    resource.meta = { ...resource.meta, project: CENSUS_PROJECT_A, versionId: "1", author: { reference: CENSUS_SERVICE } };
  }
  return jsonRoundTrip({ patient, relatedPerson, person, account });
}

function insuranceWriterResources(): { relatedPerson: RelatedPerson; coverage: Coverage } {
  const draft = {
    ...emptyCoverageDraft("Patient/writer-patient", CENSUS_TODAY),
    carrierReference: "Organization/synthetic-payer", carrierName: "ODOS", memberId: "SYNTHETIC-MEMBER",
    relationship: "other" as const, subscriberReference: "",
    subscriber: {
      firstName: "ALEX", middleName: "", lastName: "EXAM", birthDate: "1978-03-04",
      gender: "female" as const, address: "3 Synthetic Way", city: "Greenville", state: "SC", postalCode: "29601",
    },
  };
  const bundle = jsonRoundTrip(buildCoverageSaveBundle({ draft, uuid: () => "insurance-writer" }));
  const relatedPerson = bundle.entry!.find(entry => entry.resource?.resourceType === "RelatedPerson")!.resource as RelatedPerson;
  const coverage = bundle.entry!.find(entry => entry.resource?.resourceType === "Coverage")!.resource as Coverage;
  relatedPerson.id = "writer-subscriber";
  relatedPerson.meta = { project: CENSUS_PROJECT_A, versionId: "1", author: { reference: CENSUS_SERVICE } };
  coverage.id = "writer-coverage";
  coverage.subscriber = { reference: `RelatedPerson/${relatedPerson.id}` };
  coverage.meta = { project: CENSUS_PROJECT_A, versionId: "1", author: { reference: CENSUS_SERVICE } };
  return jsonRoundTrip({ relatedPerson, coverage });
}

async function operationWriterTask(): Promise<Task> {
  const fixture = guarantorReaderFixture();
  const result = await fixture.transfer();
  return jsonRoundTrip((result.body as { task: Task }).task);
}

function withIdentity<T extends Resource>(resource: T, id: string, project = CENSUS_PROJECT_A): T {
  return jsonRoundTrip({ ...resource, id, meta: { ...resource.meta, project, versionId: "1", author: { reference: CENSUS_SERVICE } } });
}

function relatedFrom(base: RelatedPerson, id: string, patientId: string, input: Partial<RelatedPerson> = {}): RelatedPerson {
  return withIdentity({
    ...base,
    patient: { reference: `Patient/${patientId}` },
    name: [{ given: ["Synthetic"], family: id }],
    telecom: [{ system: "phone", value: "864-555-0101" }],
    address: [{ line: [`${id} Synthetic Way`], city: "Greenville", state: "SC", postalCode: "29601" }],
    ...input,
  }, id);
}

function patientFrom(base: Patient, id: string, active: boolean): Patient {
  return withIdentity({ ...base, active, name: [{ given: ["Synthetic"], family: id }] }, id);
}

function attachTask(base: Task, id: string, relatedPersonId: string, status: Task["status"], options: { corrected?: boolean; lastUpdated?: string } = {}): Task {
  const task = withIdentity({
    ...base,
    status,
    code: { coding: [{ system: GUARANTOR_OPERATION_SYSTEM, code: options.corrected ? "correct" : "attach" }] },
    input: [
      { type: { text: "kind" }, valueCode: options.corrected ? "correct" : "attach" },
      { type: { text: options.corrected ? "source" : "destination" }, valueReference: { reference: "Person/writer-person" } },
      { type: { text: "moved" }, valueReference: { reference: `RelatedPerson/${relatedPersonId}` } },
      { type: { text: "reason" }, valueString: "Synthetic writer-derived census operation" },
    ],
    ...(options.corrected ? { basedOn: [{ reference: `Task/${id}-original` }] } : { basedOn: undefined }),
  }, id);
  task.meta = { ...task.meta, lastUpdated: options.lastUpdated ?? `${CENSUS_TODAY}T12:00:00.000Z` };
  return jsonRoundTrip(task);
}

export type WriterDerivedCensusFixture = Awaited<ReturnType<typeof buildWriterDerivedCensusFixture>>;

export async function buildWriterDerivedCensusFixture() {
  const registration = await registrationWriterResources();
  const insurance = insuranceWriterResources();
  const operation = await operationWriterTask();
  const resources: Resource[] = [];
  const histories = new Map<string, RelatedPerson[]>();
  const add = <T extends Resource>(resource: T): T => { const row = jsonRoundTrip(resource); resources.push(row); return row; };

  const patients = new Map<string, Patient>();
  for (const [id, active] of [["patient-active", true], ["patient-inactive", false], ["patient-owned", true], ["patient-two", true], ["patient-failed", true], ["patient-undone", true], ["patient-dupe-a", true], ["patient-dupe-b", true], ["patient-different", true], ["patient-damaged", true], ["patient-primary", true], ["patient-cross", true]] as const) {
    patients.set(id, add(patientFrom(registration.patient, id, active)));
  }

  const roleExtensions = jsonRoundTrip(registration.relatedPerson.extension!);
  const primaryOnly = roleExtensions.filter(extension => extension.url === RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL)
    .map(extension => ({ ...extension, valueBoolean: false }));
  const rows = {
    owned: add(relatedFrom(registration.relatedPerson, "rp-owned", "patient-owned")),
    ownedTwo: add(relatedFrom(registration.relatedPerson, "rp-owned-two", "patient-two")),
    failed: add(relatedFrom(registration.relatedPerson, "rp-failed", "patient-failed")),
    preG1: add(relatedFrom(registration.relatedPerson, "rp-pre-g1", "patient-inactive", { active: false, period: { start: "2020-01-01", end: "2025-01-01" } })),
    undone: add(relatedFrom(registration.relatedPerson, "rp-undone", "patient-undone")),
    activeClaim: add(relatedFrom(registration.relatedPerson, "rp-active-claim", "patient-missing", { period: undefined })),
    inertClaim: add(relatedFrom(registration.relatedPerson, "rp-inert-claim", "patient-active", { period: undefined })),
    duplicateA: add(relatedFrom(registration.relatedPerson, "rp-duplicate-a", "patient-dupe-a", { name: [{ given: ["Taylor"], family: "Same" }], telecom: [{ system: "phone", value: "+1 (864) 555-0133" }] })),
    duplicateB: add(relatedFrom(registration.relatedPerson, "rp-duplicate-b", "patient-dupe-b", { name: [{ given: [" Taylor "], family: " SAME " }], telecom: [{ system: "phone", value: "864-555-0133" }] })),
    differentPhone: add(relatedFrom(registration.relatedPerson, "rp-different-phone", "patient-different", { name: [{ given: ["Taylor"], family: "Same" }], telecom: [{ system: "phone", value: "864-555-9999" }] })),
    damaged: add(relatedFrom(registration.relatedPerson, "rp-damaged", "patient-damaged", {
      active: false,
      birthDate: "1978-03-04",
      gender: "female",
      name: [{ given: ["History"], family: "Guardian" }],
      address: [{ line: ["9 Changed Way"], city: "Greenville" }],
    })),
    primaryOnly: add(relatedFrom(registration.relatedPerson, "rp-primary-only", "patient-primary", { extension: primaryOnly })),
    cross: add(relatedFrom(registration.relatedPerson, "rp-cross", "patient-cross")),
  };

  const claimActive = add(attachTask(operation, "task-active", rows.activeClaim.id!, "in-progress"));
  const claimInert = add(attachTask(operation, "task-inert", rows.inertClaim.id!, "completed"));
  rows.activeClaim.extension = [...rows.activeClaim.extension!, { url: GUARANTOR_CLAIM_URL, valueReference: { reference: `Task/${claimActive.id}` } }];
  rows.inertClaim.extension = [...rows.inertClaim.extension!, { url: GUARANTOR_CLAIM_URL, valueReference: { reference: `Task/${claimInert.id}` } }];
  add(attachTask(operation, "task-failed", rows.failed.id!, "failed", { lastUpdated: `${CENSUS_TODAY}T10:00:00.000Z` }));
  add(attachTask(operation, "task-undone-original", rows.undone.id!, "completed", { lastUpdated: `${CENSUS_TODAY}T09:00:00.000Z` }));
  add(attachTask(operation, "task-undone", rows.undone.id!, "completed", { corrected: true, lastUpdated: `${CENSUS_TODAY}T11:00:00.000Z` }));

  add(withIdentity({ ...registration.person, name: [{ given: ["Owner"], family: "One" }], link: [{ target: { reference: `RelatedPerson/${rows.owned.id}` } }] }, "person-owner"));
  add(withIdentity({ ...registration.person, name: [{ given: ["Owner"], family: "Two A" }], link: [{ target: { reference: `RelatedPerson/${rows.ownedTwo.id}` } }] }, "person-two-a"));
  add(withIdentity({ ...registration.person, name: [{ given: ["Owner"], family: "Two B" }], link: [{ target: { reference: `RelatedPerson/${rows.ownedTwo.id}` } }] }, "person-two-b"));
  add(withIdentity({ ...registration.person, active: true, link: [] }, "person-zero-link"));
  add(withIdentity({ ...registration.person, active: false, link: [] }, "person-inactive"));
  add(withIdentity({ ...registration.person, link: [{ target: { reference: "RelatedPerson/missing-related" } }, { target: { reference: "Patient/patient-active" } }] }, "person-broken"));
  add(withIdentity({ ...registration.person, link: [{ target: { reference: `RelatedPerson/${rows.cross.id}` } }] }, "person-foreign-owner", CENSUS_PROJECT_B));

  add(withIdentity({ ...registration.account, subject: [{ reference: "Patient/patient-owned" }], guarantor: [{ party: { reference: `RelatedPerson/${rows.owned.id}` } }] }, "account-owned"));
  add(withIdentity({ ...registration.account, subject: [{ reference: "Patient/patient-failed" }], guarantor: [{ party: { reference: `RelatedPerson/${rows.failed.id}` } }] }, "account-failed"));

  add(withIdentity({ ...insurance.relatedPerson }, "subscriber-only"));
  add(withIdentity({ ...insurance.coverage, subscriber: { reference: `RelatedPerson/${rows.damaged.id}` } }, "coverage-guardian"));
  add(withIdentity({ ...insurance.coverage, subscriber: { reference: "RelatedPerson/subscriber-only" } }, "coverage-subscriber"));
  add(withIdentity({ ...insurance.coverage, subscriber: { reference: "RelatedPerson/missing-subscriber" } }, "coverage-unreadable"));

  const oldDamaged = jsonRoundTrip({
    ...rows.damaged,
    meta: { ...rows.damaged.meta, versionId: "1", author: { reference: CENSUS_SERVICE } },
    birthDate: undefined,
    gender: undefined,
    active: true,
  });
  rows.damaged.meta = { ...rows.damaged.meta, versionId: "2", author: { reference: "Practitioner/synthetic-insurance-staff" } };
  histories.set(`RelatedPerson/${rows.damaged.id}`, [jsonRoundTrip(rows.damaged), oldDamaged]);

  return jsonRoundTrip({ resources, histories: [...histories], rows, writerShapes: {
    registrationRoleUrls: registration.relatedPerson.extension?.map(extension => extension.url),
    registrationPersonLinked: registration.person.link?.length === 1,
    subscriberHasNoRole: !insurance.relatedPerson.extension?.length,
    operationCodeSystem: operation.code?.coding?.[0]?.system,
  } });
}

export class CensusFixtureFhir {
  readonly baseUrl = "http://census-fixture.test";
  readonly requests: Array<{ method: string; target: string }> = [];
  readonly resources: Resource[];
  readonly histories: Map<string, RelatedPerson[]>;

  constructor(input: { resources: Resource[]; histories: Array<[string, RelatedPerson[]]> }) {
    this.resources = jsonRoundTrip(input.resources);
    this.histories = new Map(jsonRoundTrip(input.histories));
  }

  async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
    this.requests.push({ method: "GET", target: `${type}/${id}` });
    const row = this.resources.find(resource => resource.resourceType === type && resource.id === id);
    if (!row) throw Object.assign(new Error(`FHIR 404 ${type}/${id}`), { status: 404 });
    return jsonRoundTrip(row) as T;
  }

  readExtended<T extends Resource>(type: T["resourceType"], id: string): Promise<T> { return this.read<T>(type, id); }

  async search<T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    this.requests.push({ method: "GET", target: `${type}?${new URLSearchParams(params)}` });
    const rows = this.resources.filter(resource => resource.resourceType === type);
    return { resourceType: "Bundle", type: "searchset", entry: rows.map(resource => ({ resource: jsonRoundTrip(resource) as T })) };
  }

  async searchProject<T extends Resource>(type: T["resourceType"], project: string, params: Record<string, string> = {}): Promise<Bundle<T>> {
    const page = await this.search<T>(type, params);
    page.entry = page.entry?.filter(entry => entry.resource?.meta?.project?.replace(/^Project\//, "") === project);
    return page;
  }

  async searchUrl<T extends Resource>(url: string, type: T["resourceType"]): Promise<Bundle<T>> {
    this.requests.push({ method: "GET", target: url });
    const match = url.match(/^\/fhir\/R4\/RelatedPerson\/([^/]+)\/_history\?_count=100&_offset=100$/);
    if (type !== "RelatedPerson" || !match) throw new Error("unexpected fixture paging");
    const rows = this.histories.get(`RelatedPerson/${match[1]}`) ?? [];
    return { resourceType: "Bundle", type: "history", entry: rows.slice(100).map(resource => ({ resource: jsonRoundTrip(resource) as T })) };
  }
  async searchProjectUrl<T extends Resource>(): Promise<Bundle<T>> { throw new Error("unexpected fixture project paging"); }

  async history<T extends Resource>(type: T["resourceType"], id?: string): Promise<Bundle<T>> {
    this.requests.push({ method: "GET", target: `${type}/${id}/_history` });
    const rows = this.histories.get(`${type}/${id}`) ?? [];
    return {
      resourceType: "Bundle", type: "history", entry: rows.slice(0, 100).map(resource => ({ resource: jsonRoundTrip(resource) as T })),
      ...(rows.length > 100 ? { link: [{ relation: "next", url: `/fhir/R4/RelatedPerson/${id}/_history?_count=100&_offset=100` }] } : {}),
    };
  }

  private write(method: string, target: string): never {
    this.requests.push({ method, target });
    throw new Error("fixture transport received a write");
  }

  create(): never { return this.write("POST", "create"); }
  createWithOutcome(): never { return this.write("POST", "createWithOutcome"); }
  update(): never { return this.write("PUT", "update"); }
  patch(): never { return this.write("PATCH", "patch"); }
  executeTransaction(): never { return this.write("POST", "executeTransaction"); }
  executeTransactionAsActor(): never { return this.write("POST", "executeTransactionAsActor"); }
  delete(): never { return this.write("DELETE", "delete"); }
  deleteAttempt(): never { return this.write("DELETE", "deleteAttempt"); }
  nullifyAttempt(): never { return this.write("PATCH", "nullifyAttempt"); }
}

export function aboveCeilingFixture(): CensusFixtureFhir {
  const relatedPeople = Array.from({ length: 50_001 }, (_, index): RelatedPerson => ({
    resourceType: "RelatedPerson", id: `ceiling-${index}`, meta: { project: CENSUS_PROJECT_A },
    patient: { reference: "Patient/ceiling" }, extension: [{ url: CONSENT_AUTHORITY_EXTENSION_URL, valueBoolean: true }],
  }));
  return new CensusFixtureFhir({ resources: relatedPeople, histories: [] });
}

export function expectedRoleUrls(): string[] {
  return [CONSENT_AUTHORITY_EXTENSION_URL, RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL];
}
