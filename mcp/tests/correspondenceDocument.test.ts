import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRenderedLetterDocumentReference,
} from "../src/correspondence/correspondence-document.js";

test("rendered referral record carries PDF/A and source HTML as two installed-R4 attachments", () => {
  const pdf = Buffer.from("%PDF-1.7 synthetic");
  const html = "<!doctype html><html><body>Synthetic patient letter</body></html>";
  const record = buildRenderedLetterDocumentReference({
    patientReference: "Patient/p1",
    patientDisplay: "Synthetic Patient",
    encounterReference: "Encounter/e1",
    serviceRequestReference: "ServiceRequest/r1",
    authorReference: "Practitioner/doctor-1",
    renderedAt: "2026-07-30T16:00:00.000Z",
    filename: "referral-r1.pdf",
    pdf,
    sourceHtml: html,
  });

  assert.equal(record.type?.coding?.[0]?.system, "http://loinc.org");
  assert.equal(record.type?.coding?.[0]?.code, "57133-1");
  assert.equal(record.content.length, 2);
  assert.deepEqual(
    record.content.map((entry) => entry.attachment.contentType),
    ["application/pdf", "text/html"],
  );
  assert.equal(
    Buffer.from(record.content[0]!.attachment.data!, "base64").toString(),
    pdf.toString(),
  );
  assert.equal(
    Buffer.from(record.content[1]!.attachment.data!, "base64").toString(),
    html,
  );
  assert.deepEqual(
    record.context?.related?.map((reference) => reference.reference),
    ["ServiceRequest/r1"],
  );
});
