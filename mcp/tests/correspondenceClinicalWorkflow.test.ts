import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocumentReference } from "@medplum/fhirtypes";
import {
  assembleLockedLetterHtml,
} from "../src/correspondence/correspondence-service.js";
import {
  buildRenderedLetterDocumentReference,
  CONSULT_NOTE_LOINC_CODE,
} from "../src/correspondence/correspondence-document.js";
import {
  assertCorrespondenceActionAllowed,
  buildCorrespondenceAuditEvent,
  CorrespondencePolicyStore,
} from "../src/correspondence/correspondence-workflow.js";

const LETTERHEAD = {
  contactBlock: "Synthetic Eye Care",
  phone: "555-0100",
  footerText: "",
  active: true,
};

test("unsigned drafts never render a signature image; signed letters render it above typed identity", async () => {
  const unsigned = await assembleLockedLetterHtml({
    letterhead: LETTERHEAD,
    patientName: "Synthetic Patient",
    recipientName: "External Referrer",
    bodyHtml: "<p>Findings.</p>",
    signatoryName: "Dana Doctor",
    signatoryCredentials: "OD",
  });
  assert.doesNotMatch(unsigned, /alt="Provider signature"/);
  assert.match(unsigned, /signature-line/);
  assert.match(unsigned, /Dana Doctor, OD/);

  const signed = await assembleLockedLetterHtml({
    letterhead: LETTERHEAD,
    patientName: "Synthetic Patient",
    recipientName: "External Referrer",
    bodyHtml: "<p>Findings.</p>",
    signatoryName: "Dana Doctor",
    signatoryCredentials: "OD",
    signatureDataUri: "data:image/png;base64,c2ln",
  });
  assert.ok(signed.indexOf('alt="Provider signature"') < signed.indexOf("Dana Doctor, OD"));
});

test("consult reports use verified LOINC 11488-4 and link to their inbound ServiceRequest", () => {
  const record = buildRenderedLetterDocumentReference({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/consult-1",
    serviceRequestReference: "ServiceRequest/inbound-1",
    authorReference: "Practitioner/doctor-1",
    renderedAt: "2026-07-31T17:00:00.000Z",
    filename: "consult-report-inbound-1.pdf",
    pdf: Buffer.from("%PDF-1.7 synthetic"),
    sourceHtml: "<html>Synthetic consult</html>",
    letterType: "consult-report",
    docStatus: "final",
  });

  assert.equal(record.type?.coding?.[0]?.code, CONSULT_NOTE_LOINC_CODE);
  assert.equal(record.type?.coding?.[0]?.code, "11488-4");
  assert.deepEqual(record.context?.related, [{ reference: "ServiceRequest/inbound-1" }]);
  assert.equal(record.context?.encounter?.[0]?.reference, "Encounter/consult-1");
});

test("staff cannot sign or send clinical letters, but the configurable records-transfer default is staff-sendable", async () => {
  assert.throws(
    () => assertCorrespondenceActionAllowed("front-desk", "sign", "consult-report", ["records-transfer"]),
    /provider/,
  );
  assert.throws(
    () => assertCorrespondenceActionAllowed("front-desk", "send", "referral", ["records-transfer"]),
    /provider/,
  );
  assert.doesNotThrow(
    () => assertCorrespondenceActionAllowed("front-desk", "send", "records-transfer", ["records-transfer"]),
  );
  assert.doesNotThrow(
    () => assertCorrespondenceActionAllowed("clinician", "send", "consult-report", ["records-transfer"]),
  );

  const policy = await new CorrespondencePolicyStore(new EmptyBasicFhir()).read();
  assert.deepEqual(policy.staffSendableLetterTypes, ["records-transfer"]);
});

test("sign and send each produce a semantic AuditEvent tied to the document and patient", () => {
  const signed = buildCorrespondenceAuditEvent({
    action: "sign",
    actorReference: "Practitioner/doctor-1",
    actorRole: "clinician",
    patientReference: "Patient/p1",
    documentReference: "DocumentReference/d1",
    recordedAt: "2026-07-31T17:00:00.000Z",
  });
  const sent = buildCorrespondenceAuditEvent({
    action: "send",
    actorReference: "Practitioner/doctor-1",
    actorRole: "clinician",
    patientReference: "Patient/p1",
    documentReference: "DocumentReference/d1",
    recordedAt: "2026-07-31T17:01:00.000Z",
  });

  assert.equal(signed.type.code, "correspondence.sign");
  assert.equal(sent.type.code, "correspondence.send");
  assert.ok(signed.entity?.some((entity) => entity.what?.reference === "DocumentReference/d1"));
  assert.ok(sent.entity?.some((entity) => entity.what?.reference === "Patient/p1"));
});

class EmptyBasicFhir {
  async search(): Promise<{ resourceType: "Bundle"; type: "searchset"; entry: [] }> {
    return { resourceType: "Bundle", type: "searchset", entry: [] };
  }
  async searchUrl(): Promise<{ resourceType: "Bundle"; type: "searchset"; entry: [] }> {
    return this.search();
  }
  async create<T extends DocumentReference>(resource: T): Promise<T> {
    return resource;
  }
  async update<T extends DocumentReference>(
    _resourceType: T["resourceType"],
    _id: string,
    resource: T,
  ): Promise<T> {
    return resource;
  }
}
