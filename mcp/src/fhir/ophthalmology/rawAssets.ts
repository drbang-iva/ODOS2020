import type { DiagnosticReportInput, RawAssetInput } from "./types.js";
import { osodConcept, reference, sourceSha256Extension } from "./extensions.js";

export function buildDocumentReference(
  input: RawAssetInput,
): import("./types.js").DocumentReference {
  if (!input.contentType.trim()) {
    throw new Error("DocumentReference contentType is required.");
  }
  if (input.sha1Base64 && input.sha1Base64.length < 20) {
    throw new Error("Attachment.hash must be the FHIR SHA-1 base64 value, not an OSOD SHA-256 digest.");
  }

  return {
    resourceType: "DocumentReference",
    status: "current",
    type: osodConcept(input.typeCode ?? "OPHTHALMIC_RAW_ASSET", "Ophthalmic raw asset"),
    category: [osodConcept(input.categoryCode ?? "OPHTHALMIC_SOURCE_DOCUMENT", "Ophthalmic source document")],
    subject: reference(input.patientReference),
    date: new Date().toISOString(),
    ...(input.authorReferences?.length
      ? { author: input.authorReferences.map((r) => reference(r)) }
      : {}),
    ...(input.custodianReference ? { custodian: reference(input.custodianReference) } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.sha256 ? { extension: [sourceSha256Extension(input.sha256)] } : {}),
    content: [
      {
        attachment: {
          contentType: input.contentType,
          ...(input.url ? { url: input.url } : {}),
          ...(input.data ? { data: input.data } : {}),
          ...(input.title ?? input.originalFilename
            ? { title: input.title ?? input.originalFilename }
            : {}),
          ...(input.creation ? { creation: input.creation } : {}),
          ...(input.size !== undefined ? { size: input.size } : {}),
          ...(input.sha1Base64 ? { hash: input.sha1Base64 } : {}),
        },
      },
    ],
    ...(input.encounterReference
      ? { context: { encounter: [reference(input.encounterReference)] } }
      : {}),
  };
}

export function buildDiagnosticReport(
  input: DiagnosticReportInput,
): import("./types.js").DiagnosticReport {
  return {
    resourceType: "DiagnosticReport",
    status: "final",
    code: osodConcept(input.code, input.display),
    subject: reference(input.patientReference),
    effectiveDateTime: input.effectiveDateTime,
    result: input.resultReferences.map((r) => reference(r)),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    ...(input.performerReferences?.length
      ? { performer: input.performerReferences.map((r) => reference(r)) }
      : {}),
    ...(input.imagingStudyReferences?.length
      ? { imagingStudy: input.imagingStudyReferences.map((r) => reference(r)) }
      : {}),
    ...(input.mediaReferences?.length
      ? {
          media: input.mediaReferences.map((r) => ({
            link: reference(r),
          })),
        }
      : {}),
    ...(input.presentedForms ? { presentedForm: input.presentedForms } : {}),
    ...(input.conclusion ? { conclusion: input.conclusion } : {}),
    ...(input.conclusionCode ? { conclusionCode: input.conclusionCode } : {}),
  };
}
