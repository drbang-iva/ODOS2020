import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Bundle,
  DocumentReference,
  Organization,
  ProjectMembership,
  Provenance,
  Resource,
  ServiceRequest,
} from "@medplum/fhirtypes";
import type { FhirSearchParams } from "../src/fhir-client.js";
import { assertBusinessActionAllowed } from "../src/authz/roles.js";
import {
  handleFaxCallbackRequest,
  handleReferralFaxRequest,
} from "../src/fax/fax-endpoint.js";
import { faxStatus } from "../src/fax/fax-record.js";
import type { FaxSendInput } from "../src/fax/westfax-adapter.js";
import {
  buildReferralServiceRequest,
  type ReferralFhirClient,
} from "../src/referral/referral-service.js";

const NOW = "2026-07-23T17:00:00.000Z";

test("document.fax-send is granted to referral-capable clinical and front-desk roles", () => {
  for (const role of ["practice-admin", "clinician", "front-desk", "aesthetics-provider"] as const) {
    assert.doesNotThrow(() => assertBusinessActionAllowed(role, "document.fax-send"));
  }
  assert.throws(
    () => assertBusinessActionAllowed("auditor", "document.fax-send"),
    /document\.fax-send/,
  );
});

test("referral fax send persists a pending DocumentReference and callback advances it to Sent", async () => {
  const fhir = new MemoryFaxFhir();
  fhir.put({
    ...buildReferralServiceRequest({
      subjectReference: "Patient/p1",
      subjectDisplay: "Alex Patient",
      requesterReference: "Practitioner/clinician-1",
      targetReference: "Organization/retina-1",
      targetDisplay: "Retina Associates",
      encounterReference: "Encounter/e1",
      includeList: {
        letter: true,
        demographics: true,
        history: false,
        clinical_summary: false,
        images: false,
        hipaa_cover_sheet: true,
        history_count: 2,
      },
      letterBody: "Please evaluate this patient.",
      authoredOn: NOW,
    }),
    id: "referral-1",
  } satisfies ServiceRequest);
  fhir.put({
    resourceType: "Organization",
    id: "retina-1",
    name: "Retina Associates",
    telecom: [{ system: "fax", value: "(864) 555-0100" }],
  } satisfies Organization);

  const adapterCalls: FaxSendInput[] = [];
  const deps = faxDeps(fhir, adapterCalls);
  const sent = await handleReferralFaxRequest(deps, {
    authHeader: "Bearer clinician",
    patientId: "p1",
    referralId: "referral-1",
    destinationNumber: "864-555-0100",
    billingCode: "referral-1",
    filename: "referral-referral-1.pdf",
    document: Buffer.from("%PDF-synthetic referral packet"),
  });

  assert.equal(sent.status, 202);
  assert.equal(adapterCalls.length, 1);
  assert.equal(adapterCalls[0]?.billingCode, "referral-1");
  assert.equal(adapterCalls[0]?.destinationNumbers[0], "864-555-0100");
  assert.match(adapterCalls[0]?.callbackUrl ?? "", /\/fax\/callback\/documentreference-1$/);
  const created = fhir.resources("DocumentReference")[0] as DocumentReference;
  assert.equal(created.context?.related?.[0]?.reference, "ServiceRequest/referral-1");
  assert.equal(created.context?.related?.[1]?.reference, "Encounter/e1");
  assert.equal(created.content[0]?.attachment.contentType, "application/pdf");
  assert.equal(faxStatus(created), "Pending");

  const callback = await handleFaxCallbackRequest(deps, {
    recordId: created.id,
    body: { Success: true, Result: "Sent" },
  });
  assert.equal(callback.status, 200);
  const updated = await fhir.read<DocumentReference>("DocumentReference", created.id!);
  assert.equal(faxStatus(updated), "Sent");
  assert.equal(
    updated.identifier?.find((identifier) => identifier.system?.includes("westfax-job-id"))?.value,
    "westfax-job-1",
  );
});

test("fax send rejects a destination that is not the consultant's Directory fax", async () => {
  const fhir = new MemoryFaxFhir();
  fhir.put(referral());
  fhir.put({
    resourceType: "Organization",
    id: "retina-1",
    name: "Retina Associates",
    telecom: [{ system: "fax", value: "8645550100" }],
  } satisfies Organization);
  const calls: FaxSendInput[] = [];

  const result = await handleReferralFaxRequest(faxDeps(fhir, calls), {
    authHeader: "Bearer clinician",
    patientId: "p1",
    referralId: "referral-1",
    destinationNumber: "8645550199",
    billingCode: "referral-1",
    filename: "referral.pdf",
    document: Buffer.from("%PDF-synthetic"),
  });

  assert.equal(result.status, 409);
  assert.equal(calls.length, 0);
  assert.equal(fhir.resources("DocumentReference").length, 0);
});

function faxDeps(fhir: MemoryFaxFhir, adapterCalls: FaxSendInput[]) {
  return {
    authenticate: async (header: string | undefined) => header === "Bearer clinician"
      ? {
          staffReference: "Practitioner/clinician-1",
          actorRole: "clinician" as const,
          roles: ["clinician" as const],
        }
      : null,
    serviceFhir: fhir,
    adapter: {
      sendFax: async (input: FaxSendInput) => {
        adapterCalls.push(input);
        return { success: true, jobId: "westfax-job-1" };
      },
    },
    callbackBaseUrl: "https://odos.practice.test",
    now: () => NOW,
  };
}

function referral(): ServiceRequest {
  return {
    ...buildReferralServiceRequest({
      subjectReference: "Patient/p1",
      subjectDisplay: "Alex Patient",
      requesterReference: "Practitioner/clinician-1",
      targetReference: "Organization/retina-1",
      targetDisplay: "Retina Associates",
      encounterReference: "Encounter/e1",
      includeList: {
        letter: true,
        demographics: false,
        history: false,
        clinical_summary: false,
        images: false,
        hipaa_cover_sheet: false,
        history_count: 1,
      },
      letterBody: "Please evaluate.",
      authoredOn: NOW,
    }),
    id: "referral-1",
  };
}

class MemoryFaxFhir implements ReferralFhirClient {
  private readonly rows = new Map<string, Resource>();
  private sequence = 0;

  put(resource: Resource): void {
    if (!resource.id) throw new Error("Seeded resource requires an id.");
    this.rows.set(`${resource.resourceType}/${resource.id}`, structuredClone({
      ...resource,
      meta: { ...resource.meta, versionId: resource.meta?.versionId ?? "1" },
    }));
  }

  resources(resourceType: Resource["resourceType"]): Resource[] {
    return [...this.rows.values()]
      .filter((resource) => resource.resourceType === resourceType)
      .map((resource) => structuredClone(resource));
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.rows.get(`${resourceType}/${id}`);
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource) as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    _params: FhirSearchParams = {},
  ): Promise<Bundle<T>> {
    if (resourceType === "ProjectMembership") {
      const membership: ProjectMembership = {
        resourceType: "ProjectMembership",
        id: "membership-1",
        project: { reference: "Project/project-1" },
        profile: { reference: "Practitioner/clinician-1" },
        access: [{
          parameter: [{ name: "patient_compartment", valueString: "Patient/p1" }],
        }],
      };
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: membership as T }],
      };
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: this.resources(resourceType).map((resource) => ({ resource: resource as T })),
    };
  }

  async create<T extends Resource>(
    resource: T,
    _extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const id = resource.id ?? `${resource.resourceType.toLowerCase()}-${++this.sequence}`;
    const stored = {
      ...structuredClone(resource),
      id,
      meta: { ...resource.meta, versionId: "1" },
    } as T;
    this.rows.set(`${resource.resourceType}/${id}`, stored);
    return structuredClone(stored);
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    _extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const current = await this.read<T>(resourceType, id);
    const stored = {
      ...structuredClone(resource),
      id,
      meta: {
        ...resource.meta,
        versionId: String(Number(current.meta?.versionId ?? "0") + 1),
      },
    } as T;
    this.rows.set(`${resourceType}/${id}`, stored);
    return structuredClone(stored);
  }

  async executeTransaction(bundle: Bundle): Promise<Bundle> {
    const serviceRequest = bundle.entry?.[0]?.resource as ServiceRequest;
    const provenance = bundle.entry?.[1]?.resource as Provenance;
    await this.update("ServiceRequest", serviceRequest.id!, serviceRequest);
    const createdProvenance = await this.create(provenance);
    return {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: [
        { response: { status: "200", location: `ServiceRequest/${serviceRequest.id}/_history/2` } },
        { response: { status: "201", location: `Provenance/${createdProvenance.id}/_history/1` } },
      ],
    };
  }
}
