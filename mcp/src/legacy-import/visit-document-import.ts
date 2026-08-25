import type {
  DocumentReference,
  Encounter,
  Patient,
} from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { searchAll } from "../fhir-search.js";
import {
  uploadBinary,
  type BinaryUploadAuth,
} from "../fhir/binary-upload.js";
import {
  MIGRATION_TAG_CODE,
  MIGRATION_TAG_SYSTEM,
} from "./access-policy.js";
import {
  assertBinaryHash,
  tagMigrationBinary,
} from "./binary-transport.js";
import {
  compactDate,
  isCompactCalendarDate,
  periodIncludesDate,
  sourceTimestamp,
} from "./ccda-import.js";
import { EHR_PATIENT_IDENTIFIER_SYSTEM } from "./patient-import.js";

export const LEGACY_VISIT_DOCUMENT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/legacy-visit-document";

export const LEGACY_VISIT_DOCUMENT_TYPES = ["Encounter", "Visit"] as const;
export type LegacyVisitDocumentType = (typeof LEGACY_VISIT_DOCUMENT_TYPES)[number];

export interface LegacyVisitDocumentSource {
  readonly pid: string;
  readonly encounterId: string;
  readonly documentType: LegacyVisitDocumentType;
  readonly fileName: string;
  readonly readBytes: () => Promise<Uint8Array>;
}

export interface LegacyVisitDocumentResult {
  readonly identifier: string;
  readonly fileName: string;
  readonly action: "created" | "already-imported";
  readonly documentReference: string;
  readonly binaryReference?: string;
  readonly encounterReference?: string;
}

export interface LegacyVisitDocumentPidResult {
  readonly pid: string;
  readonly patientMatchCount: number;
  readonly action: "imported" | "skipped-patient";
  readonly patientReference?: string;
  readonly documents: LegacyVisitDocumentResult[];
  readonly encounterNonMatches: Array<{
    fileName: string;
    date: string;
    matchCount: number;
  }>;
}

type VisitDocumentFhirClient = Pick<
  MedplumClient,
  "baseUrl" | "search" | "searchUrl" | "create" | "update"
>;

export async function importLegacyVisitDocumentsForPid(input: {
  readonly fhir: VisitDocumentFhirClient;
  readonly projectId: string;
  readonly pid: string;
  readonly sources: readonly LegacyVisitDocumentSource[];
  readonly auth: BinaryUploadAuth;
}): Promise<LegacyVisitDocumentPidResult> {
  assertPid(input.pid);
  for (const source of input.sources) assertSource(input.pid, source);

  const patients = await searchAll<Patient>(input.fhir, "Patient", {
    identifier: `${EHR_PATIENT_IDENTIFIER_SYSTEM}|${input.pid}`,
  });
  if (patients.length !== 1) {
    return {
      pid: input.pid,
      patientMatchCount: patients.length,
      action: "skipped-patient",
      documents: [],
      encounterNonMatches: [],
    };
  }

  const patient = patients[0]!;
  if (!patient.id) throw new Error(`Matched Patient for PID ${input.pid} has no id.`);
  const patientReference = `Patient/${patient.id}`;
  const encounters = (await searchAll<Encounter>(input.fhir, "Encounter", {
    patient: patientReference,
  })).filter((encounter) => encounter.subject?.reference === patientReference);
  const documents: LegacyVisitDocumentResult[] = [];
  const encounterNonMatches: LegacyVisitDocumentPidResult["encounterNonMatches"] = [];

  for (const source of input.sources) {
    const date = compactDate(sourceTimestamp(source.fileName).slice(0, 8));
    const encounterMatches = encounters.filter((encounter) =>
      periodIncludesDate(encounter, date)
    );
    let encounterReference: string | undefined;
    if (encounterMatches.length === 1) {
      const encounter = encounterMatches[0]!;
      if (!encounter.id) throw new Error(`Encounter match for ${source.fileName} has no id.`);
      encounterReference = `Encounter/${encounter.id}`;
    } else {
      encounterNonMatches.push({
        fileName: source.fileName,
        date,
        matchCount: encounterMatches.length,
      });
    }

    documents.push(await importDocument({
      ...input,
      source,
      date,
      patientReference,
      encounterReference,
    }));
  }

  return {
    pid: input.pid,
    patientMatchCount: 1,
    action: "imported",
    patientReference,
    documents,
    encounterNonMatches,
  };
}

async function importDocument(input: {
  readonly fhir: VisitDocumentFhirClient;
  readonly projectId: string;
  readonly auth: BinaryUploadAuth;
  readonly source: LegacyVisitDocumentSource;
  readonly date: string;
  readonly patientReference: string;
  readonly encounterReference?: string;
}): Promise<LegacyVisitDocumentResult> {
  const identifier = visitDocumentIdentifier(input.source);
  const matches = await searchAll<DocumentReference>(input.fhir, "DocumentReference", {
    identifier: `${LEGACY_VISIT_DOCUMENT_IDENTIFIER_SYSTEM}|${identifier}`,
  });
  if (matches.length > 1) {
    throw new Error(`Legacy visit document identifier ${identifier} matched ${matches.length} resources.`);
  }

  let documentReference = matches[0];
  if (documentReference) {
    if (documentReference.subject?.reference !== input.patientReference) {
      throw new Error(
        `Legacy visit document identifier ${identifier} belongs to ${documentReference.subject?.reference ?? "no Patient"}.`,
      );
    }
    const attachmentUrl = documentReference.content[0]?.attachment.url;
    if (documentReference.docStatus === "final" && attachmentUrl) {
      if (!documentReference.id) throw new Error(`Final DocumentReference for ${identifier} has no id.`);
      return {
        identifier,
        fileName: input.source.fileName,
        action: "already-imported",
        documentReference: `DocumentReference/${documentReference.id}`,
        binaryReference: attachmentUrl,
        ...(input.encounterReference ? { encounterReference: input.encounterReference } : {}),
      };
    }
    throw new Error(
      `DocumentReference/${documentReference.id ?? "(unknown)"} has an incomplete or unsupported import state; `
      + "operator cleanup is required before retry.",
    );
  } else {
    documentReference = await input.fhir.create<DocumentReference>(buildPreliminaryDocument({
      projectId: input.projectId,
      source: input.source,
      identifier,
      date: input.date,
      patientReference: input.patientReference,
      encounterReference: input.encounterReference,
    }), {
      "X-ODOS-Source": "scripts/import-legacy-visit-documents",
    });
  }

  if (!documentReference.id || !documentReference.meta?.versionId) {
    throw new Error("Preliminary DocumentReference requires id and meta.versionId.");
  }
  const documentReferenceValue = `DocumentReference/${documentReference.id}`;
  const bytes = await input.source.readBytes();
  const uploaded = await uploadBinary({
    bytes,
    contentType: "application/pdf",
    filename: input.source.fileName,
    securityContext: documentReferenceValue,
    auth: input.auth,
  });
  await tagMigrationBinary(uploaded.resource, input.auth);
  await assertBinaryHash(uploaded.binaryId, bytes, input.auth);

  await input.fhir.update<DocumentReference>(
    "DocumentReference",
    documentReference.id,
    {
      ...documentReference,
      docStatus: "final",
      content: [{
        ...documentReference.content[0],
        attachment: {
          ...documentReference.content[0]!.attachment,
          url: uploaded.url,
          size: bytes.byteLength,
        },
      }],
    },
    { "If-Match": `W/"${documentReference.meta.versionId}"` },
  );

  return {
    identifier,
    fileName: input.source.fileName,
    action: "created",
    documentReference: documentReferenceValue,
    binaryReference: uploaded.url,
    ...(input.encounterReference ? { encounterReference: input.encounterReference } : {}),
  };
}

function buildPreliminaryDocument(input: {
  readonly projectId: string;
  readonly source: LegacyVisitDocumentSource;
  readonly identifier: string;
  readonly date: string;
  readonly patientReference: string;
  readonly encounterReference?: string;
}): DocumentReference {
  return {
    resourceType: "DocumentReference",
    meta: {
      project: input.projectId,
      tag: [{ system: MIGRATION_TAG_SYSTEM, code: MIGRATION_TAG_CODE }],
    },
    status: "current",
    docStatus: "preliminary",
    identifier: [{
      system: LEGACY_VISIT_DOCUMENT_IDENTIFIER_SYSTEM,
      value: input.identifier,
    }],
    type: { text: `Legacy ${input.source.documentType.toLowerCase()} document` },
    subject: { reference: input.patientReference },
    date: `${input.date}T12:00:00Z`,
    description: `Eyefinity ${input.source.documentType} Final PDF`,
    content: [{
      attachment: {
        contentType: "application/pdf",
        title: input.source.fileName,
        creation: input.date,
      },
    }],
    ...(input.encounterReference
      ? { context: { encounter: [{ reference: input.encounterReference }] } }
      : {}),
  };
}

function visitDocumentIdentifier(source: LegacyVisitDocumentSource): string {
  return `${source.pid}:${source.encounterId}:${source.documentType}`;
}

function assertPid(pid: string): void {
  if (!/^\d+$/.test(pid)) throw new Error(`Legacy visit document PID must be numeric: ${pid}.`);
}

function assertSource(pid: string, source: LegacyVisitDocumentSource): void {
  if (source.pid !== pid) {
    throw new Error(`Source PID ${source.pid} does not match import PID ${pid}.`);
  }
  if (!/^\d+$/.test(source.encounterId)) {
    throw new Error(`Legacy visit document encounter ID must be numeric: ${source.encounterId}.`);
  }
  const expectedSuffix = `_${source.documentType}_Final.pdf`;
  if (!source.fileName.endsWith(expectedSuffix)) {
    throw new Error(`${source.fileName} does not match document type ${source.documentType}.`);
  }
  let compactSourceDate: string;
  try {
    compactSourceDate = sourceTimestamp(source.fileName).slice(0, 8);
  } catch {
    throw new Error(`${source.fileName} has no EMA_<YYYYMMDDT...> timestamp.`);
  }
  if (!isCompactCalendarDate(compactSourceDate)) {
    throw new Error(`${source.fileName} contains an invalid calendar date.`);
  }
}
