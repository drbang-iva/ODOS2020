import { createHash } from "node:crypto";
import type {
  AllergyIntolerance,
  CodeableConcept,
  Condition,
  Encounter,
  Identifier,
  MedicationStatement,
  Patient,
  Procedure,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import { z } from "zod";
import type { MedplumClient } from "../fhir-client.js";
import { searchAll } from "../fhir-search.js";
import { buildAllergyIntolerance } from "../fhir/allergyIntolerance.js";
import { buildProblemListCondition } from "../fhir/condition.js";
import { buildMedicationStatement } from "../fhir/medicationStatement.js";
import { buildProcedure } from "../fhir/procedure.js";
import { EHR_PATIENT_IDENTIFIER_SYSTEM } from "./patient-import.js";

export const LEGACY_CCDA_ITEM_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/legacy-ccda-item";
export const LEGACY_CCDA_TAG_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/import-source";
export const LEGACY_CCDA_TAG_CODE = "legacy-ccda-import";
export const LEGACY_CCDA_ACTIVITY_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/legacy-import-activity";

const SOURCE_CODE_SYSTEMS = [
  "SNOMED-CT",
  "ICD-10-CM",
  "ICD-9-CM",
  "LOINC",
  "RxNorm",
  "CPT-4",
] as const;

const FHIR_CODE_SYSTEMS: Record<(typeof SOURCE_CODE_SYSTEMS)[number], string> = {
  "SNOMED-CT": "http://snomed.info/sct",
  "ICD-10-CM": "http://hl7.org/fhir/sid/icd-10-cm",
  "ICD-9-CM": "http://terminology.hl7.org/CodeSystem/icd9cm",
  LOINC: "http://loinc.org",
  RxNorm: "http://www.nlm.nih.gov/research/umls/rxnorm",
  "CPT-4": "http://www.ama-assn.org/go/cpt",
};

const EYEFINITY_IMPORT_TIME_ZONE = "America/New_York";

const parsedCodeSchema = z.object({
  system: z.enum(SOURCE_CODE_SYSTEMS),
  code: z.string().trim().min(1),
  display: z.string().trim().min(1).nullable(),
});

const entryBaseSchema = z.object({
  date: z.string()
    .regex(/^\d{8}$/)
    .refine(isCompactCalendarDate, "Invalid calendar date.")
    .nullish()
    .transform((value) => value ?? null),
  codes: z.array(parsedCodeSchema).min(1),
});

const sectionsSchema = z.object({
  Problems: z.array(entryBaseSchema.extend({ kind: z.literal("observation") })).optional(),
  Medications: z.array(
    entryBaseSchema.extend({ kind: z.literal("substanceAdministration") }),
  ).optional(),
  Procedures: z.array(entryBaseSchema.extend({ kind: z.literal("procedure") })).optional(),
  Allergies: z.array(entryBaseSchema.extend({ kind: z.literal("observation") })).optional(),
  "Past Illness": z.array(entryBaseSchema.extend({ kind: z.string() })).optional(),
  "Plan of Treatment": z.array(entryBaseSchema.extend({ kind: z.string() })).optional(),
  Encounters: z.array(entryBaseSchema.extend({ kind: z.string() })).optional(),
}).passthrough();

export const legacyCcdaDocumentsSchema = z.array(z.object({
  file: z.string().trim().min(1),
  sections: sectionsSchema,
}).passthrough()).min(1).superRefine((documents, context) => {
  const seen = new Set<string>();
  for (const [index, document] of documents.entries()) {
    if (seen.has(document.file)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "file"],
        message: `Duplicate source filename ${document.file}.`,
      });
    }
    seen.add(document.file);
    if (!/EMA_(\d{8}T\d+)/.test(document.file)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "file"],
        message: "C-CDA filename must contain an EMA_<YYYYMMDDT...> timestamp.",
      });
    } else if (!isCompactCalendarDate(sourceTimestamp(document.file).slice(0, 8))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "file"],
        message: "C-CDA filename contains an invalid calendar date.",
      });
    }
  }
});

export type LegacyCcdaDocument = z.infer<typeof legacyCcdaDocumentsSchema>[number];
type ParsedCode = z.infer<typeof parsedCodeSchema>;
type ParsedEntry = z.infer<typeof entryBaseSchema>;

export const LEGACY_CCDA_RESOURCE_TYPES = [
  "Condition",
  "AllergyIntolerance",
  "MedicationStatement",
  "Procedure",
] as const;
export type LegacyCcdaResourceType = (typeof LEGACY_CCDA_RESOURCE_TYPES)[number];

export interface LegacyCcdaResourceCounts {
  created: number;
  skipped: number;
  encounterLinked: number;
  encounterUnlinked: number;
}

export interface LegacyCcdaImportResult {
  patientReference: string;
  resources: Record<LegacyCcdaResourceType, LegacyCcdaResourceCounts>;
  encounterNonMatches: Array<{
    file: string;
    date: string;
    matchCount: number;
  }>;
  provenanceReference?: string;
}

type LegacyCcdaFhirClient = Pick<
  MedplumClient,
  "search" | "searchUrl" | "create"
>;

interface SourceDocument {
  document: LegacyCcdaDocument;
  timestamp: string;
  date: string;
  encounterReference?: string;
}

type ImportableResource =
  | Condition
  | AllergyIntolerance
  | MedicationStatement
  | Procedure;

export async function importLegacyCcda(input: {
  fhir: LegacyCcdaFhirClient;
  projectId: string;
  ehrPatientId: string;
  documents: unknown;
  now?: Date;
}): Promise<LegacyCcdaImportResult> {
  const documents = legacyCcdaDocumentsSchema.parse(input.documents);
  const patient = await resolvePatient(input.fhir, input.ehrPatientId);
  const patientReference = `Patient/${patient.id}`;
  const resources = resourceCounts();
  const encounterNonMatches: LegacyCcdaImportResult["encounterNonMatches"] = [];
  const sources: SourceDocument[] = [];
  const encounters = (await searchAll<Encounter>(input.fhir, "Encounter", {
    patient: patientReference,
  })).filter((encounter) => encounter.subject?.reference === patientReference);

  for (const document of documents) {
    const timestamp = sourceTimestamp(document.file);
    const date = compactDate(timestamp.slice(0, 8));
    const encounterMatches = encounters.filter((encounter) => periodIncludesDate(encounter, date));
    let encounterReference: string | undefined;
    if (encounterMatches.length === 1) {
      const encounter = encounterMatches[0]!;
      if (!encounter.id) throw new Error(`Encounter match for ${document.file} has no id.`);
      encounterReference = `Encounter/${encounter.id}`;
    } else {
      encounterNonMatches.push({ file: document.file, date, matchCount: encounterMatches.length });
    }
    sources.push({ document, timestamp, date, encounterReference });
  }

  const createdReferences: string[] = [];
  for (const source of sources) {
    for (const entry of source.document.sections.Problems ?? []) {
      const coding = codeableConcept(entry.codes);
      const identifier = itemIdentifier(
        input.ehrPatientId,
        source.timestamp,
        "Problems",
        entry.codes[0]!,
      );
      const condition = buildProblemListCondition({
        patientReference,
        encounterReference: source.encounterReference,
        code: coding,
        verificationStatus: "confirmed",
        recordedDate: source.date,
        identifiers: [identifier],
      });
      await writeResource(input, condition, identifier, source, resources, createdReferences);
    }

    for (const entry of source.document.sections.Allergies ?? []) {
      const identifier = itemIdentifier(
        input.ehrPatientId,
        source.timestamp,
        "Allergies",
        entry.codes[0]!,
      );
      const allergy = buildAllergyIntolerance({
        patientReference,
        code: codeableConcept(entry.codes),
        verificationStatus: "confirmed",
        recordedDate: source.date,
        encounterReference: source.encounterReference,
      });
      allergy.identifier = [identifier];
      await writeResource(input, allergy, identifier, source, resources, createdReferences);
    }

    for (const entry of source.document.sections.Procedures ?? []) {
      const identifier = itemIdentifier(
        input.ehrPatientId,
        source.timestamp,
        "Procedures",
        entry.codes[0]!,
      );
      const procedure = buildProcedure({
        patientReference,
        status: "completed",
        code: codeableConcept(entry.codes),
        encounterReference: source.encounterReference,
        performedDateTime: entry.date ? compactDate(entry.date) : source.date,
      });
      procedure.identifier = [identifier];
      await writeResource(input, procedure, identifier, source, resources, createdReferences);
    }
  }

  for (const medication of distinctMedications(sources)) {
    const identifier = medicationIdentifier(
      input.ehrPatientId,
      medication.preferredCode,
    );
    const statement = buildMedicationStatement({
      patientReference,
      identifiers: [identifier],
      medication: codeableConcept(medication.codes),
      status: "unknown",
      encounterReference: medication.source.encounterReference,
      effectiveDateTime: medication.earliestDate,
      dateAsserted: medication.source.date,
    });
    await writeResource(
      input,
      statement,
      identifier,
      medication.source,
      resources,
      createdReferences,
    );
  }

  let provenanceReference: string | undefined;
  if (createdReferences.length > 0) {
    const provenance: Provenance = {
      resourceType: "Provenance",
      meta: { project: input.projectId },
      target: createdReferences.map((reference) => ({ reference })),
      recorded: (input.now ?? new Date()).toISOString(),
      activity: {
        coding: [{
          system: LEGACY_CCDA_ACTIVITY_SYSTEM,
          code: LEGACY_CCDA_TAG_CODE,
          display: "Legacy C-CDA import",
        }],
        text: "Legacy C-CDA import",
      },
      agent: [{ who: { display: "ODOS legacy C-CDA importer" } }],
      entity: documents.map((document) => ({
        role: "source",
        what: { display: document.file },
      })),
    };
    const created = await input.fhir.create<Provenance>(provenance, {
      "X-ODOS-Source": "scripts/import-legacy-ccda",
    });
    if (!created.id) throw new Error("Provenance create returned no id.");
    provenanceReference = `Provenance/${created.id}`;
  }

  return {
    patientReference,
    resources,
    encounterNonMatches,
    provenanceReference,
  };
}

async function resolvePatient(
  fhir: LegacyCcdaFhirClient,
  ehrPatientId: string,
): Promise<Patient> {
  const matches = await searchAll<Patient>(fhir, "Patient", {
    identifier: `${EHR_PATIENT_IDENTIFIER_SYSTEM}|${ehrPatientId}`,
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Patient for EHR identifier ${ehrPatientId}; found ${matches.length}.`,
    );
  }
  if (!matches[0]!.id) throw new Error("Matched Patient has no id.");
  return matches[0]!;
}

async function writeResource(
  input: {
    fhir: LegacyCcdaFhirClient;
    projectId: string;
  },
  resource: ImportableResource,
  identifier: Identifier,
  source: SourceDocument,
  counts: Record<LegacyCcdaResourceType, LegacyCcdaResourceCounts>,
  createdReferences: string[],
): Promise<void> {
  const matches = await searchAll<Resource>(input.fhir, resource.resourceType, {
    identifier: `${identifier.system}|${identifier.value}`,
  });
  if (matches.length > 1) {
    throw new Error(
      `${resource.resourceType} identifier ${identifier.value} matched ${matches.length} resources.`,
    );
  }
  const type = resource.resourceType as LegacyCcdaResourceType;
  if (matches.length === 1) {
    const existing = matches[0] as ImportableResource;
    counts[type].skipped += 1;
    counts[type][hasEncounterLink(existing) ? "encounterLinked" : "encounterUnlinked"] += 1;
    return;
  }
  const linked = Boolean(source.encounterReference);

  resource.meta = {
    ...resource.meta,
    project: input.projectId,
    tag: [
      ...(resource.meta?.tag ?? []).filter(
        (tag) => tag.system !== LEGACY_CCDA_TAG_SYSTEM || tag.code !== LEGACY_CCDA_TAG_CODE,
      ),
      {
        system: LEGACY_CCDA_TAG_SYSTEM,
        code: LEGACY_CCDA_TAG_CODE,
        display: "Legacy C-CDA import",
      },
    ],
  };
  const created = await input.fhir.create<ImportableResource>(resource, {
    "X-ODOS-Source": "scripts/import-legacy-ccda",
  });
  if (!created.id) throw new Error(`${resource.resourceType} create returned no id.`);
  counts[type].created += 1;
  counts[type][linked ? "encounterLinked" : "encounterUnlinked"] += 1;
  createdReferences.push(`${resource.resourceType}/${created.id}`);
}

function hasEncounterLink(resource: ImportableResource): boolean {
  if (resource.resourceType === "MedicationStatement") {
    return resource.context?.reference?.startsWith("Encounter/") ?? false;
  }
  return Boolean(resource.encounter?.reference);
}

function distinctMedications(sources: readonly SourceDocument[]): Array<{
  codes: ParsedCode[];
  preferredCode: ParsedCode;
  source: SourceDocument;
  earliestDate?: string;
}> {
  const grouped = new Map<string, Array<{
    entry: ParsedEntry;
    preferredCode: ParsedCode;
    source: SourceDocument;
  }>>();
  for (const source of sources) {
    for (const entry of source.document.sections.Medications ?? []) {
      const preferredCode = medicationPreferredCode(entry.codes);
      const key = `${preferredCode.system}\u001f${preferredCode.code}`;
      const occurrences = grouped.get(key) ?? [];
      occurrences.push({ entry, preferredCode, source });
      grouped.set(key, occurrences);
    }
  }

  return [...grouped.values()].map((occurrences) => {
    const sorted = [...occurrences].sort((left, right) =>
      left.source.timestamp.localeCompare(right.source.timestamp)
    );
    const first = sorted[0]!;
    const dates = occurrences
      .map((occurrence) => occurrence.entry.date)
      .filter((date): date is string => Boolean(date))
      .sort();
    return {
      codes: first.entry.codes.map((code) => ({
        ...code,
        display: occurrences
          .flatMap((occurrence) => occurrence.entry.codes)
          .find((candidate) =>
            candidate.system === code.system
            && candidate.code === code.code
            && candidate.display
          )?.display ?? null,
      })),
      preferredCode: first.preferredCode,
      source: first.source,
      ...(dates[0] ? { earliestDate: compactDate(dates[0]) } : {}),
    };
  });
}

function medicationPreferredCode(codes: readonly ParsedCode[]): ParsedCode {
  return codes.find((code) => code.system === "RxNorm") ?? codes[0]!;
}

function codeableConcept(codes: readonly ParsedCode[]): CodeableConcept {
  const seen = new Set<string>();
  const coding = codes.flatMap((source) => {
    const key = `${source.system}\u001f${source.code}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      system: FHIR_CODE_SYSTEMS[source.system],
      code: source.code,
      ...(source.display ? { display: source.display } : {}),
    }];
  });
  return { coding };
}

function itemIdentifier(
  ehrPatientId: string,
  documentTimestamp: string,
  section: string,
  code: ParsedCode,
): Identifier {
  const value = createHash("sha256")
    .update(`${ehrPatientId}|${documentTimestamp}|${section}|${code.system}|${code.code}`)
    .digest("hex");
  return { system: LEGACY_CCDA_ITEM_IDENTIFIER_SYSTEM, value };
}

function medicationIdentifier(ehrPatientId: string, code: ParsedCode): Identifier {
  const value = createHash("sha256")
    .update(`${ehrPatientId}|Medications|${code.system}|${code.code}`)
    .digest("hex");
  return { system: LEGACY_CCDA_ITEM_IDENTIFIER_SYSTEM, value };
}

function sourceTimestamp(file: string): string {
  const timestamp = /EMA_(\d{8}T\d+)/.exec(file)?.[1];
  if (!timestamp) throw new Error(`C-CDA filename has no EMA timestamp: ${file}.`);
  return timestamp;
}

function compactDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function isCompactCalendarDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function periodIncludesDate(encounter: Encounter, date: string): boolean {
  const start = localCalendarDate(encounter.period?.start);
  const end = localCalendarDate(encounter.period?.end) ?? start;
  return Boolean(start && end && start <= date && end >= date);
}

function localCalendarDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EYEFINITY_IMPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : undefined;
}

function resourceCounts(): Record<LegacyCcdaResourceType, LegacyCcdaResourceCounts> {
  return Object.fromEntries(LEGACY_CCDA_RESOURCE_TYPES.map((resourceType) => [
    resourceType,
    { created: 0, skipped: 0, encounterLinked: 0, encounterUnlinked: 0 },
  ])) as Record<LegacyCcdaResourceType, LegacyCcdaResourceCounts>;
}
