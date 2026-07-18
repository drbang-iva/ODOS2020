import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type {
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
  type ReferralEndpointDeps,
} from "../src/referral/referral-endpoint.js";
import { registerReferralRoutes } from "../src/referral/referral-routes.js";
import {
  buildReferralServiceRequest,
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
  assert.equal((result.body as { serviceRequestReference: string }).serviceRequestReference, `ServiceRequest/${serviceRequest.id}`);
});

test("preview is write-free while send records one clinician-attributed disclosure Provenance", async () => {
  const fhir = seededFhir();
  const endpointDeps = deps(fhir);
  const previewInput = {
    authHeader: AUTH,
    patientId: "p1",
    referralId: "referral-1",
    action: "preview" as const,
    body: {},
  };

  const firstPreview = await handleReferralArtifactRequest(endpointDeps, previewInput);
  const secondPreview = await handleReferralArtifactRequest(endpointDeps, previewInput);
  assert.equal(firstPreview.status, 200);
  assert.equal(secondPreview.status, 200);
  assert.equal(fhir.provenances.length, 0);

  const sent = await handleReferralArtifactRequest(endpointDeps, {
    ...previewInput,
    action: "send",
  });
  assert.equal(sent.status, 200);
  assert.equal(fhir.provenances.length, 1);
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

test("registered HTTP routes expose create, preview, and distinct send actions", async () => {
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

    assert.equal(created.status, 201);
    assert.equal(previewed.status, 200);
    assert.equal(sent.status, 200);
    assert.equal(serviceAuthCalls, 3);
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
      search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => {
        assert.equal(resourceType, "ProjectMembership");
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

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    this.readKeys.push(`${resourceType}/${id}`);
    const resource = this.rows.get(`${resourceType}/${id}`);
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource) as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    _params: FhirSearchParams = {},
  ): Promise<Bundle<T>> {
    const resources = [...this.rows.values()]
      .filter((resource) => resource.resourceType === resourceType)
      .map((resource) => ({ resource: structuredClone(resource) as T }));
    return { resourceType: "Bundle", type: "searchset", entry: resources };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    const id = resource.id ?? `${resource.resourceType.toLowerCase()}-${++this.sequence}`;
    const stored = structuredClone({ ...resource, id }) as T;
    this.rows.set(`${resource.resourceType}/${id}`, stored);
    this.created.push(stored);
    if (stored.resourceType === "Provenance") this.provenances.push(stored as Provenance);
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
