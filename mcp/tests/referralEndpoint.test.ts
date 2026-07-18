import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type {
  Basic,
  Bundle,
  Encounter,
  Organization,
  Patient,
  ProjectMembership,
  Provenance,
  Resource,
  ServiceRequest,
} from "@medplum/fhirtypes";
import express from "express";
import type { FhirSearchParams } from "../src/fhir-client.js";
import {
  handleCreateReferralRequest,
  handleReferralArtifactRequest,
  handleReadReferralDefaultsRequest,
  handleSaveReferralDefaultsRequest,
  type ReferralEndpointDeps,
} from "../src/referral/referral-endpoint.js";
import { registerReferralRoutes } from "../src/referral/referral-routes.js";
import { SYSTEM_REFERRAL_INCLUDE_DEFAULTS } from "../src/referral/referral-defaults-store.js";
import {
  buildReferralServiceRequest,
  REFERRAL_LETTER_BODY_EXTENSION_URL,
  type ReferralFhirClient,
  type ReferralIncludeList,
} from "../src/referral/referral-service.js";

const AUTH = "Bearer clinician";
const NOW = "2026-07-18T16:00:00.000Z";
const INCLUDE_LIST: ReferralIncludeList = {
  letter: true,
  demographics: false,
  history: true,
  clinical_summary: false,
  images: false,
  hipaa_cover_sheet: false,
  history_count: 2,
};
const CREATE_BODY = {
  targetReference: "Organization/retina-1",
  encounterReference: "Encounter/current",
  includeList: INCLUDE_LIST,
  priority: "urgent",
  reasonText: "New central distortion",
};

test("referral endpoint fails closed for unauthenticated, non-chart-write, and out-of-compartment callers", async () => {
  const fhir = seededFhir();
  const forbiddenAuth = "Bearer front-desk-denied";
  const outsideCompartmentAuth = "Bearer compartment-denied";
  const unauthenticated = await handleCreateReferralRequest(deps(fhir, { authenticated: false }), {
    authHeader: undefined,
    patientId: "p1",
    body: CREATE_BODY,
  });
  const forbidden = await handleCreateReferralRequest(deps(fhir, {
    role: "front-desk",
    authToken: forbiddenAuth,
    staffReference: "Practitioner/front-desk-denied",
  }), {
    authHeader: forbiddenAuth,
    patientId: "p1",
    body: CREATE_BODY,
  });
  const outsideCompartment = await handleReferralArtifactRequest(deps(fhir, {
    authToken: outsideCompartmentAuth,
    staffReference: "Practitioner/compartment-denied",
    patientGrant: "Patient/other",
  }), {
    authHeader: outsideCompartmentAuth,
    patientId: "p1",
    referralId: "referral-1",
    action: "preview",
    body: {},
  });

  assert.equal(unauthenticated.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(outsideCompartment.status, 403);
  assert.equal(fhir.created.length, 0);
  assert.equal(fhir.readKeys.length, 0);
});

test("referral creation derives requester from the authenticated clinician", async () => {
  const fhir = seededFhir();
  const result = await handleCreateReferralRequest(deps(fhir), {
    authHeader: AUTH,
    patientId: "p1",
    body: CREATE_BODY,
  });

  assert.equal(result.status, 201);
  const serviceRequest = (result.body as { serviceRequest: ServiceRequest }).serviceRequest;
  assert.equal(serviceRequest.requester?.reference, "Practitioner/clinician-1");
  assert.equal(serviceRequest.subject.reference, "Patient/p1");
  assert.equal(serviceRequest.status, "draft");
  assert.equal(serviceRequest.priority, "urgent");
  assert.deepEqual(serviceRequest.reasonCode, [{ text: "New central distortion" }]);
  assert.equal((result.body as { serviceRequestReference: string }).serviceRequestReference, `ServiceRequest/${serviceRequest.id}`);
});

test("referral creation rejects unsupported priority and blank reason text", async () => {
  const fhir = seededFhir();
  const invalidPriority = await handleCreateReferralRequest(deps(fhir), {
    authHeader: AUTH,
    patientId: "p1",
    body: { ...CREATE_BODY, priority: "asap" },
  });
  const blankReason = await handleCreateReferralRequest(deps(fhir), {
    authHeader: AUTH,
    patientId: "p1",
    body: { ...CREATE_BODY, reasonText: "   " },
  });

  assert.equal(invalidPriority.status, 400);
  assert.equal(blankReason.status, 400);
});

test("preview is write-free while send records one clinician-attributed disclosure Provenance", async () => {
  const fhir = seededFhir();
  const endpointDeps = deps(fhir);
  const previewLetter = "Preview-only edited body";
  const sentLetter = "Clinician edited words actually sent";
  const previewInput = {
    authHeader: AUTH,
    patientId: "p1",
    referralId: "referral-1",
    action: "preview" as const,
    body: { editedLetterBody: previewLetter },
  };

  const firstPreview = await handleReferralArtifactRequest(endpointDeps, previewInput);
  const secondPreview = await handleReferralArtifactRequest(endpointDeps, previewInput);
  assert.equal(firstPreview.status, 200);
  assert.equal(secondPreview.status, 200);
  assert.equal(fhir.provenances.length, 0);
  const afterPreviews = await fhir.read<ServiceRequest>("ServiceRequest", "referral-1");
  assert.equal(afterPreviews.status, "draft");
  assert.equal(referralLetterBody(afterPreviews), "Please evaluate this patient.");

  const sent = await handleReferralArtifactRequest(endpointDeps, {
    ...previewInput,
    action: "send",
    body: { editedLetterBody: sentLetter },
  });
  assert.equal(sent.status, 200);
  assert.equal(fhir.provenances.length, 1);
  const afterSend = await fhir.read<ServiceRequest>("ServiceRequest", "referral-1");
  assert.equal(afterSend.status, "active");
  assert.equal(referralLetterBody(afterSend), sentLetter);
  assert.match((sent.body as { artifact: string }).artifact, /Clinician edited words actually sent/);
  assert.doesNotMatch((sent.body as { artifact: string }).artifact, /Preview-only edited body/);
  const provenance = fhir.provenances[0];
  assert.equal(provenance.target[0]?.reference, "ServiceRequest/referral-1");
  assert.equal(provenance.agent[0]?.who.reference, "Practitioner/clinician-1");
  assert.equal(provenance.agent[0]?.type?.coding?.[0]?.code, "transmitter");
  assert.equal(provenance.activity?.coding?.[0]?.system, "http://terminology.hl7.org/CodeSystem/v3-DataOperation");
  assert.equal(provenance.activity?.coding?.[0]?.code, "READ");
  assert.equal(provenance.activity?.coding?.[0]?.display, "Disclose referral");
  assert.deepEqual(provenance.entity?.map((entity) => entity.what.display), [
    "Referral include-list flag: letter",
    "Referral include-list flag: history",
    "Referral history_count: 2",
  ]);
  assert.equal((sent.body as { provenanceReference: string }).provenanceReference, `Provenance/${provenance.id}`);
});

test("preview rejects a referral whose subject does not match the compartment-scoped route patient", async () => {
  const fhir = seededFhir();
  fhir.put(referral("wrong-patient", "Patient/other"));

  const result = await handleReferralArtifactRequest(deps(fhir), {
    authHeader: AUTH,
    patientId: "p1",
    referralId: "wrong-patient",
    action: "preview",
    body: {},
  });

  assert.equal(result.status, 409);
  assert.equal(fhir.provenances.length, 0);
});

test("referral defaults return system values for an unsaved provider and round-trip per provider", async () => {
  const fhir = seededFhir();
  const clinicianOneDeps = deps(fhir);
  const unsaved = await handleReadReferralDefaultsRequest(clinicianOneDeps, { authHeader: AUTH });
  assert.equal(unsaved.status, 200);
  assert.deepEqual(
    (unsaved.body as { includeList: ReferralIncludeList }).includeList,
    SYSTEM_REFERRAL_INCLUDE_DEFAULTS,
  );

  const savedDefaults: ReferralIncludeList = {
    letter: true,
    demographics: false,
    history: false,
    clinical_summary: true,
    images: true,
    hipaa_cover_sheet: true,
    history_count: 7,
  };
  const saved = await handleSaveReferralDefaultsRequest(clinicianOneDeps, {
    authHeader: AUTH,
    body: { includeList: savedDefaults },
  });
  const resaved = await handleSaveReferralDefaultsRequest(clinicianOneDeps, {
    authHeader: AUTH,
    body: { includeList: savedDefaults },
  });
  const reread = await handleReadReferralDefaultsRequest(clinicianOneDeps, { authHeader: AUTH });
  const clinicianTwo = await handleReadReferralDefaultsRequest(deps(fhir, {
    staffReference: "Practitioner/clinician-2",
  }), { authHeader: AUTH });

  assert.equal(saved.status, 200);
  assert.equal(resaved.status, 200);
  assert.deepEqual((saved.body as { includeList: ReferralIncludeList }).includeList, savedDefaults);
  assert.deepEqual((reread.body as { includeList: ReferralIncludeList }).includeList, savedDefaults);
  assert.deepEqual(
    (clinicianTwo.body as { includeList: ReferralIncludeList }).includeList,
    SYSTEM_REFERRAL_INCLUDE_DEFAULTS,
  );
  const basics = fhir.resources("Basic") as Basic[];
  assert.equal(basics.length, 1);
  assert.equal(basics[0]?.code?.text, "referral-include-defaults");
  assert.equal(basics[0]?.identifier?.[0]?.value, "Practitioner/clinician-1");
});

test("referral defaults require authentication and chart.write", async () => {
  const fhir = seededFhir();
  const unauthenticated = await handleReadReferralDefaultsRequest(
    deps(fhir, { authenticated: false }),
    { authHeader: undefined },
  );
  const forbiddenAuth = "Bearer front-desk-denied";
  const forbidden = await handleSaveReferralDefaultsRequest(deps(fhir, {
    role: "front-desk",
    authToken: forbiddenAuth,
    staffReference: "Practitioner/front-desk-denied",
  }), {
    authHeader: forbiddenAuth,
    body: { includeList: INCLUDE_LIST },
  });

  assert.equal(unauthenticated.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(fhir.resources("Basic").length, 0);
});

test("registered HTTP routes expose defaults, create, preview, and distinct send actions", async () => {
  const fhir = seededFhir();
  let serviceAuthCalls = 0;
  const app = express();
  app.use(express.json());
  registerReferralRoutes(app, {
    ...deps(fhir),
    authenticateService: async () => { serviceAuthCalls += 1; },
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  const headers = { Authorization: AUTH, "Content-Type": "application/json" };

  try {
    const readDefaults = await fetch(`http://127.0.0.1:${port}/referrals/defaults`, { headers });
    const saveDefaults = await fetch(`http://127.0.0.1:${port}/referrals/defaults`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ includeList: INCLUDE_LIST }),
    });
    const created = await fetch(`http://127.0.0.1:${port}/referrals/patients/p1`, {
      method: "POST",
      headers,
      body: JSON.stringify(CREATE_BODY),
    });
    const previewed = await fetch(`http://127.0.0.1:${port}/referrals/patients/p1/referral-1/preview`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const sent = await fetch(`http://127.0.0.1:${port}/referrals/patients/p1/referral-1/send`, {
      method: "POST",
      headers,
      body: "{}",
    });

    assert.equal(readDefaults.status, 200);
    assert.equal(saveDefaults.status, 200);
    assert.equal(created.status, 201);
    assert.equal(previewed.status, 200);
    assert.equal(sent.status, 200);
    assert.equal(serviceAuthCalls, 5);
    assert.equal(fhir.provenances.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => error ? reject(error) : resolve()));
  }
});

function deps(
  fhir: MemoryReferralFhir,
  options: {
    authenticated?: boolean;
    role?: "clinician" | "front-desk";
    authToken?: string;
    staffReference?: string;
    patientGrant?: string;
  } = {},
): ReferralEndpointDeps {
  const authenticated = options.authenticated ?? true;
  const role = options.role ?? "clinician";
  const authToken = options.authToken ?? AUTH;
  const staffReference = options.staffReference ?? "Practitioner/clinician-1";
  const patientGrant = options.patientGrant ?? "Patient/p1";
  return {
    authenticate: async (header) => authenticated && header === authToken
      ? { staffReference, actorRole: role, fhir }
      : null,
    serviceFhir: {
      search: async <T extends Resource>(
        resourceType: T["resourceType"],
        params: FhirSearchParams = {},
      ): Promise<Bundle<T>> => {
        if (resourceType !== "ProjectMembership") return fhir.search<T>(resourceType, params);
        const membership: ProjectMembership = {
          resourceType: "ProjectMembership",
          id: "membership-1",
          project: { reference: "Project/project-1" },
          profile: { reference: staffReference },
          access: [{
            parameter: [{ name: "patient_compartment", valueString: patientGrant }],
          }],
        };
        return { resourceType: "Bundle", type: "searchset", entry: [{ resource: membership as T }] };
      },
      create: <T extends Resource>(resource: T, headers?: Record<string, string>) =>
        fhir.create(resource, headers),
      update: <T extends Resource>(
        resourceType: T["resourceType"],
        id: string,
        resource: T,
        headers?: Record<string, string>,
      ) => fhir.update(resourceType, id, resource, headers),
    },
    now: () => NOW,
  };
}

class MemoryReferralFhir implements ReferralFhirClient {
  private readonly rows = new Map<string, Resource>();
  private sequence = 0;
  readonly created: Resource[] = [];
  readonly provenances: Provenance[] = [];
  readonly readKeys: string[] = [];

  put(resource: Resource): void {
    if (!resource.id) throw new Error("Seeded resources require an id.");
    this.rows.set(`${resource.resourceType}/${resource.id}`, structuredClone(resource));
  }

  resources(resourceType: Resource["resourceType"]): Resource[] {
    return [...this.rows.values()]
      .filter((resource) => resource.resourceType === resourceType)
      .map((resource) => structuredClone(resource));
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    this.readKeys.push(`${resourceType}/${id}`);
    const resource = this.rows.get(`${resourceType}/${id}`);
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource) as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: FhirSearchParams = {},
  ): Promise<Bundle<T>> {
    const query = searchRecord(params);
    const resources = [...this.rows.values()]
      .filter((resource) => resource.resourceType === resourceType)
      .filter((resource) => !query.code || resourceHasCode(resource, query.code))
      .filter((resource) => !query.identifier || resourceHasIdentifier(resource, query.identifier))
      .map((resource) => ({ resource: structuredClone(resource) as T }));
    return { resourceType: "Bundle", type: "searchset", entry: resources };
  }

  async create<T extends Resource>(
    resource: T,
    _extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const id = resource.id ?? `${resource.resourceType.toLowerCase()}-${++this.sequence}`;
    const stored = structuredClone({ ...resource, id }) as T;
    this.rows.set(`${resource.resourceType}/${id}`, stored);
    this.created.push(stored);
    if (stored.resourceType === "Provenance") this.provenances.push(stored as Provenance);
    return structuredClone(stored);
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    _extraHeaders?: Record<string, string>,
  ): Promise<T> {
    assert.equal(resource.resourceType, resourceType);
    assert.equal(resource.id, id);
    if (!this.rows.has(`${resourceType}/${id}`)) throw new Error(`Missing ${resourceType}/${id}`);
    const stored = structuredClone(resource);
    this.rows.set(`${resourceType}/${id}`, stored);
    return structuredClone(stored);
  }
}

function seededFhir(): MemoryReferralFhir {
  const fhir = new MemoryReferralFhir();
  fhir.put({
    resourceType: "Patient",
    id: "p1",
    name: [{ text: "Alex Patient" }],
  } satisfies Patient);
  fhir.put({
    resourceType: "Encounter",
    id: "current",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/p1" },
  } satisfies Encounter);
  fhir.put({
    resourceType: "Organization",
    id: "retina-1",
    name: "Retina Associates",
  } satisfies Organization);
  fhir.put(referral("referral-1", "Patient/p1"));
  return fhir;
}

function referral(id: string, subjectReference: string): ServiceRequest {
  return {
    ...buildReferralServiceRequest({
      subjectReference,
      subjectDisplay: "Alex Patient",
      requesterReference: "Practitioner/clinician-1",
      targetReference: "Organization/retina-1",
      targetDisplay: "Retina Associates",
      encounterReference: "Encounter/current",
      includeList: INCLUDE_LIST,
      letterBody: "Please evaluate this patient.",
      authoredOn: NOW,
    }),
    id,
  };
}

function referralLetterBody(serviceRequest: ServiceRequest): string | undefined {
  return serviceRequest.extension?.find(
    (extension) => extension.url === REFERRAL_LETTER_BODY_EXTENSION_URL,
  )?.valueString;
}

function searchRecord(params: FhirSearchParams): Record<string, string> {
  if (params instanceof URLSearchParams) return Object.fromEntries(params);
  if (Array.isArray(params)) return Object.fromEntries(params);
  return params;
}

function resourceHasCode(resource: Resource, token: string): boolean {
  if (resource.resourceType !== "Basic") return false;
  const [system, code] = token.split("|");
  return resource.code?.coding?.some((coding) =>
    coding.system === system && coding.code === code) ?? false;
}

function resourceHasIdentifier(resource: Resource, token: string): boolean {
  if (resource.resourceType !== "Basic") return false;
  const [system, value] = token.split("|");
  return resource.identifier?.some((identifier) =>
    identifier.system === system && identifier.value === value) ?? false;
}
