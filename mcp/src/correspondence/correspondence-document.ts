import type { DocumentReference } from "@medplum/fhirtypes";

export const REFERRAL_NOTE_LOINC_CODE = "57133-1";
export const REFERRAL_NOTE_LOINC_DISPLAY = "Referral note";
export const CONSULT_NOTE_LOINC_CODE = "11488-4";
export const CONSULT_NOTE_LOINC_DISPLAY = "Consult note";
export const CORRESPONDENCE_PDF_A_FORMAT_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/correspondence-format";
export const CORRESPONDENCE_DRAFT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/correspondence-draft";

export function buildRenderedLetterDocumentReference(input: {
  patientReference: string;
  patientDisplay?: string;
  encounterReference?: string;
  serviceRequestReference: string;
  authorReference: string;
  renderedAt: string;
  filename: string;
  pdf: Buffer;
  sourceHtml: string;
  letterType?: "referral" | "consult-report";
  docStatus?: "preliminary" | "final";
  authenticatorReference?: string;
}): DocumentReference {
  assertReference(input.patientReference, "Patient");
  assertReference(input.serviceRequestReference, "ServiceRequest");
  assertAuthorReference(input.authorReference);
  if (input.encounterReference) assertReference(input.encounterReference, "Encounter");
  if (input.authenticatorReference) assertAuthorReference(input.authenticatorReference);
  if (!input.pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("Rendered correspondence must be a PDF.");
  }
  const consultReport = input.letterType === "consult-report";
  const docStatus = input.docStatus ?? "final";
  const code = consultReport ? CONSULT_NOTE_LOINC_CODE : REFERRAL_NOTE_LOINC_CODE;
  const display = consultReport ? CONSULT_NOTE_LOINC_DISPLAY : REFERRAL_NOTE_LOINC_DISPLAY;
  return {
    resourceType: "DocumentReference",
    status: "current",
    docStatus,
    ...(docStatus === "preliminary"
      ? { extension: [{ url: CORRESPONDENCE_DRAFT_EXTENSION_URL, valueBoolean: true }] }
      : {}),
    type: {
      coding: [{
        system: "http://loinc.org",
        code,
        display,
      }],
      text: display,
    },
    subject: {
      reference: input.patientReference,
      ...(input.patientDisplay ? { display: input.patientDisplay } : {}),
    },
    date: input.renderedAt,
    author: [{ reference: input.authorReference }],
    ...(input.authenticatorReference
      ? { authenticator: { reference: input.authenticatorReference } }
      : {}),
    description: consultReport
      ? "Rendered consult report correspondence"
      : "Rendered referral correspondence",
    content: [
      {
        attachment: {
          contentType: "application/pdf",
          data: input.pdf.toString("base64"),
          title: input.filename,
          size: input.pdf.byteLength,
          creation: input.renderedAt,
        },
        format: {
          system: CORRESPONDENCE_PDF_A_FORMAT_SYSTEM,
          code: "pdf-a-3u",
          display: "PDF/A-3u",
        },
      },
      {
        attachment: {
          contentType: "text/html",
          data: Buffer.from(input.sourceHtml).toString("base64"),
          title: input.filename.replace(/\.pdf$/i, ".html"),
          size: Buffer.byteLength(input.sourceHtml),
          creation: input.renderedAt,
        },
      },
    ],
    context: {
      ...(input.encounterReference
        ? { encounter: [{ reference: input.encounterReference }] }
        : {}),
      related: [{ reference: input.serviceRequestReference }],
    },
  };
}

function assertReference(reference: string, resourceType: string): void {
  if (!new RegExp(`^${resourceType}/[A-Za-z0-9.-]{1,64}$`).test(reference)) {
    throw new Error(`A valid ${resourceType} reference is required.`);
  }
}

function assertAuthorReference(reference: string): void {
  if (!/^(Practitioner|PractitionerRole|Organization)\/[A-Za-z0-9.-]{1,64}$/.test(reference)) {
    throw new Error("A valid correspondence author reference is required.");
  }
}
