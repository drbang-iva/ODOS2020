import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, DocumentReference, Resource, ServiceRequest } from "@medplum/fhirtypes";
import {
  CORRESPONDENCE_DRAFT_EXTENSION_URL,
  loadCorrespondenceDeskBlock,
} from "../src/desk/correspondence-block.js";
import {
  buildInboundReferralServiceRequest,
} from "../src/referral/reciprocal-referral.js";
import {
  FAX_ERROR_EXTENSION_URL,
  FAX_STATUS_EXTENSION_URL,
} from "../src/fax/fax-record.js";
import {
  INBOUND_FAX_IDENTIFIER_SYSTEM,
  INBOUND_FAX_PAGE_COUNT_EXTENSION_URL,
  INBOUND_FAX_SENDER_EXTENSION_URL,
  INBOUND_FAX_SUGGESTED_PATIENT_EXTENSION_URL,
  INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL,
} from "../src/fax/inbound-fax.js";

test("Desk Correspondence block exposes drafts, replies, failures, and actionable inbound fax triage", async () => {
  const fhir = new DeskCorrespondenceFhir();
  fhir.put({
    resourceType: "DocumentReference",
    id: "draft-1",
    status: "current",
    docStatus: "preliminary",
    subject: { reference: "Patient/p-draft", display: "Synthetic Draft" },
    date: "2026-07-31T13:00:00.000Z",
    content: [{ attachment: { contentType: "text/html", data: "PHN5bnRoZXRpYz4=" } }],
    extension: [{ url: CORRESPONDENCE_DRAFT_EXTENSION_URL, valueBoolean: true }],
  } satisfies DocumentReference);
  fhir.put({
    resourceType: "DocumentReference",
    id: "fax-inbound",
    identifier: [{ system: INBOUND_FAX_IDENTIFIER_SYSTEM, value: "westfax-1" }],
    status: "current",
    docStatus: "final",
    type: { text: "Inbound fax" },
    date: "2026-07-31T14:30:00.000Z",
    content: [{
      attachment: {
        contentType: "application/pdf",
        data: Buffer.from("%PDF-synthetic-inbound").toString("base64"),
        title: "inbound.pdf",
      },
    }],
    extension: [
      { url: INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL, valueCode: "received" },
      { url: INBOUND_FAX_SENDER_EXTENSION_URL, valueString: "8645550199" },
      { url: INBOUND_FAX_PAGE_COUNT_EXTENSION_URL, valueInteger: 2 },
      {
        url: INBOUND_FAX_SUGGESTED_PATIENT_EXTENSION_URL,
        valueReference: { reference: "Patient/suggested", display: "Suggested Patient" },
      },
    ],
  } satisfies DocumentReference);
  fhir.put({
    ...buildInboundReferralServiceRequest({
      subjectReference: "Patient/p-owed",
      subjectDisplay: "Synthetic Owed",
      referrerDisplay: "External Referrer",
      performerReference: "Practitioner/doctor-1",
      performerDisplay: "Doctor One",
      captureSource: "front-desk",
      authoredOn: "2026-07-30T13:00:00.000Z",
      reasonText: "Consult",
    }),
    id: "owed-1",
  } satisfies ServiceRequest);
  fhir.put({
    resourceType: "DocumentReference",
    id: "fax-failed",
    status: "current",
    subject: { reference: "Patient/p-fax", display: "Synthetic Fax" },
    date: "2026-07-31T14:00:00.000Z",
    content: [{ attachment: { contentType: "application/pdf", title: "synthetic.pdf" } }],
    extension: [
      { url: FAX_STATUS_EXTENSION_URL, valueString: "Failed" },
      { url: FAX_ERROR_EXTENSION_URL, valueString: "Synthetic transport failure" },
    ],
  } satisfies DocumentReference);
  fhir.replyRows = [{
    serviceRequestReference: "ServiceRequest/owed-1",
    patientReference: "Patient/p-owed",
    patientDisplay: "Synthetic Owed",
    referrerDisplay: "External Referrer",
    authoredOn: "2026-07-30T13:00:00.000Z",
    encounterReference: "Encounter/e-owed",
    status: "open",
  }];

  const block = await loadCorrespondenceDeskBlock(fhir, {
    now: "2026-07-31T15:00:00.000Z",
    loadRepliesOwed: async () => fhir.replyRows,
  });

  assert.equal(block.draftsAwaitingSignature.value, 1);
  assert.equal(block.repliesOwed.value, 1);
  assert.equal(block.sendFailures.value, 1);
  assert.equal(block.inboundFaxes.value, 1);
  assert.deepEqual(block.items.map((item) => Object.keys(item)), [
    ["kind", "title", "patientReference", "severity", "ageMinutes", "action", "owner", "status"],
    ["kind", "title", "patientReference", "severity", "ageMinutes", "action", "owner", "status"],
    ["kind", "title", "patientReference", "severity", "ageMinutes", "action", "owner", "status"],
    [
      "kind",
      "title",
      "patientReference",
      "severity",
      "ageMinutes",
      "action",
      "owner",
      "status",
      "faxId",
      "receivedAt",
      "senderNumber",
      "pageCount",
      "documentUrl",
      "triageStatus",
      "suggestedPatient",
    ],
  ]);
  const inbound = block.items[3];
  assert.equal(inbound?.kind, "inbound-fax");
  assert.equal(inbound?.patientReference, "Patient/unknown");
  assert.equal(inbound?.suggestedPatient?.reference, "Patient/suggested");
  assert.equal(inbound?.documentUrl, "/fax/inbound/fax-inbound/document");
});

class DeskCorrespondenceFhir {
  readonly resources: Resource[] = [];
  replyRows: Array<{
    serviceRequestReference: string;
    patientReference: string;
    patientDisplay?: string;
    referrerDisplay: string;
    authoredOn?: string;
    encounterReference: string;
    status: "open";
  }> = [];

  put(resource: Resource): void {
    this.resources.push(resource);
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    const resources = this.resources.filter((resource): resource is T => {
      if (resource.resourceType !== resourceType) return false;
      if (resourceType !== "DocumentReference") return true;
      const document = resource as DocumentReference;
      if (params.status && document.status !== params.status) return false;
      return true;
    });
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resources.map((resource) => ({ resource })),
    };
  }
}
