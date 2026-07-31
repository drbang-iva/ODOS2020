import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Bundle,
  DocumentReference,
  Encounter,
  Resource,
  ServiceRequest,
} from "@medplum/fhirtypes";
import {
  buildReferralServiceRequest,
  referralDirectionOf,
  type ReferralIncludeList,
} from "../src/referral/referral-service.js";
import {
  buildInboundReferralServiceRequest,
  InboundReferralService,
  ReferralReplyWorklist,
} from "../src/referral/reciprocal-referral.js";

const INCLUDE_LIST: ReferralIncludeList = {
  letter: true,
  demographics: true,
  history: true,
  clinical_summary: true,
  images: false,
  hipaa_cover_sheet: false,
  history_count: 2,
};

test("inbound and outbound ServiceRequest direction is explicit and never inferred from references", () => {
  const outbound = buildReferralServiceRequest({
    subjectReference: "Patient/p1",
    subjectDisplay: "Synthetic Patient",
    requesterReference: "Practitioner/internal-doctor",
    targetReference: "Practitioner/external-doctor",
    targetDisplay: "External Doctor",
    encounterReference: "Encounter/e1",
    includeList: INCLUDE_LIST,
    letterBody: "Synthetic referral",
    authoredOn: "2026-07-31T12:00:00.000Z",
  });
  const inbound = buildInboundReferralServiceRequest({
    subjectReference: "Patient/p1",
    subjectDisplay: "Synthetic Patient",
    referrerReference: "Practitioner/external-doctor",
    referrerDisplay: "External Doctor",
    performerReference: "Practitioner/internal-doctor",
    performerDisplay: "Internal Doctor",
    captureSource: "front-desk",
    authoredOn: "2026-07-31T12:00:00.000Z",
    reasonText: "Consult requested",
  });

  assert.equal(referralDirectionOf(outbound), "outbound");
  assert.equal(referralDirectionOf(inbound), "inbound");
  assert.equal(inbound.requester?.reference, "Practitioner/external-doctor");
  assert.equal(inbound.performer?.[0]?.reference, "Practitioner/internal-doctor");
  assert.equal(inbound.status, "active");
  assert.equal(inbound.intent, "order");
});

test("inbound referral capture supports directory references and a free-text fallback at all three entry points", async () => {
  const fhir = new ReciprocalFhir();
  const service = new InboundReferralService(fhir, () => "2026-07-31T12:00:00.000Z");
  for (const captureSource of ["front-desk", "fax", "chart"] as const) {
    const created = await service.create({
      subjectReference: "Patient/p1",
      subjectDisplay: "Synthetic Patient",
      referrerDisplay: `${captureSource} referrer`,
      performerReference: "Practitioner/internal-doctor",
      performerDisplay: "Internal Doctor",
      captureSource,
      reasonText: "Consult requested",
    });
    assert.equal(created.requester?.reference, undefined);
    assert.equal(created.requester?.display, `${captureSource} referrer`);
  }
});

test("replies owed returns only signed-consult cases with no linked consult report", async () => {
  const fhir = new ReciprocalFhir();
  fhir.put(inbound("owed", "p-owed"));
  fhir.put(inbound("replied", "p-replied"));
  fhir.put(inbound("not-seen", "p-not-seen"));
  fhir.put(finishedEncounter("seen-owed", "p-owed", "owed"));
  fhir.put(finishedEncounter("seen-replied", "p-replied", "replied"));
  fhir.put({
    resourceType: "DocumentReference",
    id: "report-replied",
    status: "current",
    docStatus: "final",
    type: { coding: [{ system: "http://loinc.org", code: "11488-4" }] },
    subject: { reference: "Patient/p-replied" },
    content: [{ attachment: { contentType: "application/pdf", data: "JVBERi0=" } }],
    context: { related: [{ reference: "ServiceRequest/replied" }] },
  } satisfies DocumentReference);

  const rows = await new ReferralReplyWorklist(fhir).list();

  assert.deepEqual(rows.map((row) => row.serviceRequestReference), ["ServiceRequest/owed"]);
  assert.equal(rows[0]?.patientReference, "Patient/p-owed");
  assert.equal(rows[0]?.status, "open");
});

function inbound(id: string, patientId: string): ServiceRequest {
  return {
    ...buildInboundReferralServiceRequest({
      subjectReference: `Patient/${patientId}`,
      subjectDisplay: `Synthetic ${patientId}`,
      referrerDisplay: "External Referrer",
      performerReference: "Practitioner/internal-doctor",
      performerDisplay: "Internal Doctor",
      captureSource: "front-desk",
      authoredOn: "2026-07-30T12:00:00.000Z",
      reasonText: "Consult requested",
    }),
    id,
  };
}

function finishedEncounter(id: string, patientId: string, referralId: string): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: `Patient/${patientId}` },
    basedOn: [{ reference: `ServiceRequest/${referralId}` }],
    period: { end: "2026-07-31T16:00:00.000Z" },
  };
}

class ReciprocalFhir {
  readonly resources: Resource[] = [];

  put(resource: Resource): void {
    this.resources.push(resource);
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    const created = { ...resource, id: resource.id ?? `created-${this.resources.length + 1}` };
    this.resources.push(created);
    return created;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    const matching = this.resources.filter((resource): resource is T => {
      if (resource.resourceType !== resourceType) return false;
      if (resource.resourceType === "ServiceRequest") {
        return referralDirectionOf(resource as ServiceRequest) === "inbound";
      }
      if (resource.resourceType === "Encounter") {
        const encounter = resource as Encounter;
        return encounter.subject?.reference === `Patient/${params.patient}`;
      }
      if (resource.resourceType === "DocumentReference") {
        const document = resource as DocumentReference;
        return document.context?.related?.some((reference) => reference.reference === params.related)
          && document.type?.coding?.some((coding) => coding.code === "11488-4");
      }
      return true;
    });
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: matching.map((resource) => ({ resource })),
    };
  }
}
