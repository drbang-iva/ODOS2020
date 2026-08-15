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
export const LEGACY_CCDA_FDB_ALLERGEN_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/fdb-allergen";

const SOURCE_CODE_SYSTEMS = [
  "SNOMED-CT",
  "ICD-10-CM",
  "ICD-9-CM",
  "LOINC",
  "RxNorm",
  "CPT-4",
  "FDB",
] as const;

const FHIR_CODE_SYSTEMS: Record<(typeof SOURCE_CODE_SYSTEMS)[number], string> = {
  "SNOMED-CT": "http://snomed.info/sct",
  "ICD-10-CM": "http://hl7.org/fhir/sid/icd-10-cm",
  "ICD-9-CM": "http://terminology.hl7.org/CodeSystem/icd9cm",
  LOINC: "http://loinc.org",
  RxNorm: "http://www.nlm.nih.gov/research/umls/rxnorm",
  "CPT-4": "http://www.ama-assn.org/go/cpt",
  // Source C-CDA labels these vendor allergen codes with OID 2.16.840.1.113883.3.3710.200.401;
  // ODOS owns this URI because that value set has no registered canonical CodeSystem URI.
  FDB: LEGACY_CCDA_FDB_ALLERGEN_SYSTEM,
};

const EYEFINITY_IMPORT_TIME_ZONE = "America/New_York";
const IMPORTED_SECTION_KEYS = ["Problems", "Allergies", "Procedures", "Medications"] as const;

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
  codes: z.array(parsedCodeSchema),
  text: z.string().trim().nullish().transform((value) => value || undefined),
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
    for (const sectionKey of IMPORTED_SECTION_KEYS) {
      const entries = document.sections[sectionKey] ?? [];
      for (const [entryIndex, entry] of entries.entries()) {
        if (entry.codes.length === 0 && !entry.text) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "sections", sectionKey, entryIndex],
            message: "C-CDA entry must include at least one code or narrative text.",
          });
        }
      }
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

interface DistinctProblem {
  entry: ParsedEntry;
  identityEntry: ParsedEntry;
  source: SourceDocument;
  firstRecordedDate: string;
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
  for (const problem of distinctProblems(sources)) {
    const coding = codeableConcept(problem.entry.codes, problem.entry.text);
    const identifier = problemIdentifier(input.ehrPatientId, problem);
    const condition = buildProblemListCondition({
      patientReference,
      encounterReference: problem.source.encounterReference,
      code: coding,
      verificationStatus: problem.entry.codes.length > 0 ? "confirmed" : "unconfirmed",
      recordedDate: problem.firstRecordedDate,
      identifiers: [identifier],
    });
    await writeResource(
      input,
      condition,
      identifier,
      problem.source,
      resources,
      createdReferences,
    );
  }

  for (const source of sources) {
    for (const entry of source.document.sections.Allergies ?? []) {
      const identifier = itemIdentifier(
        input.ehrPatientId,
        source.timestamp,
        "Allergies",
        entry,
      );
      const allergy = buildAllergyIntolerance({
        patientReference,
        code: codeableConcept(entry.codes, entry.text),
        verificationStatus: entry.codes.length > 0 ? "confirmed" : "unconfirmed",
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
        entry,
      );
      const procedure = buildProcedure({
        patientReference,
        status: "completed",
        code: codeableConcept(entry.codes, entry.text),
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
      medication.text,
    );
    const statement = buildMedicationStatement({
      patientReference,
      identifiers: [identifier],
      medication: codeableConcept(medication.codes, medication.text),
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
      target: [...createdReferences, patientReference].map((reference) => ({ reference })),
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

function distinctProblems(sources: readonly SourceDocument[]): DistinctProblem[] {
  const groups: Array<Array<{ entry: ParsedEntry; source: SourceDocument }>> = [];
  const occurrences = sources
    .flatMap((source) =>
      (source.document.sections.Problems ?? []).map((entry) => ({ entry, source }))
    )
    .sort((left, right) => left.source.timestamp.localeCompare(right.source.timestamp));

  for (const occurrence of occurrences) {
    const matchingIndexes = groups.flatMap((group, index) =>
      group.every((member) => sameProblem(member.entry, occurrence.entry)) ? [index] : []
    );
    if (matchingIndexes.length !== 1) {
      groups.push([occurrence]);
      continue;
    }
    groups[matchingIndexes[0]!]!.push(occurrence);
  }

  return groups.map((group) => {
    const byRichness = [...group].sort(compareProblemRichness);
    const representative = byRichness[0]!;
    const codesByIdentity = new Map<string, ParsedCode>();
    for (const occurrence of byRichness) {
      for (const code of occurrence.entry.codes) {
        const key = codeIdentity(code);
        const existing = codesByIdentity.get(key);
        if (!existing) {
          codesByIdentity.set(key, { ...code });
        } else if (!existing.display && code.display) {
          codesByIdentity.set(key, { ...existing, display: code.display });
        }
      }
    }
    const codes = [...codesByIdentity.values()];
    const text = representative.entry.text
      ?? representative.entry.codes.find((code) => code.display)?.display
      ?? codes.find((code) => code.display)?.display
      ?? byRichness.find((occurrence) => occurrence.entry.text)?.entry.text
      ?? codes[0]?.code;
    const identityOccurrence = [...group].sort(compareProblemIdentity)[0]!;
    const newestOccurrence = [...group].sort((left, right) =>
      right.source.timestamp.localeCompare(left.source.timestamp)
    )[0]!;

    return {
      entry: {
        date: representative.entry.date,
        codes,
        ...(text ? { text } : {}),
      },
      identityEntry: identityOccurrence.entry,
      source: newestOccurrence.source,
      firstRecordedDate: group[0]!.source.date,
    };
  });
}

function sameProblem(left: ParsedEntry, right: ParsedEntry): boolean {
  if (!left.date || left.date !== right.date) return false;
  const leftCodes = new Set(left.codes.map(codeIdentity));
  const rightCodes = new Set(right.codes.map(codeIdentity));
  if (leftCodes.size === 0 || rightCodes.size === 0) {
    return leftCodes.size === 0
      && rightCodes.size === 0
      && Boolean(left.text)
      && Boolean(right.text)
      && normalizeText(left.text!) === normalizeText(right.text!);
  }
  return isSubset(leftCodes, rightCodes) || isSubset(rightCodes, leftCodes);
}

function isSubset(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].every((value) => right.has(value));
}

function compareProblemRichness(
  left: { entry: ParsedEntry; source: SourceDocument },
  right: { entry: ParsedEntry; source: SourceDocument },
): number {
  const codeCount = uniqueCodeCount(right.entry) - uniqueCodeCount(left.entry);
  if (codeCount !== 0) return codeCount;
  const displayCount = right.entry.codes.filter((code) => code.display).length
    - left.entry.codes.filter((code) => code.display).length;
  if (displayCount !== 0) return displayCount;
  if (Boolean(left.entry.text) !== Boolean(right.entry.text)) return left.entry.text ? -1 : 1;
  return right.source.timestamp.localeCompare(left.source.timestamp);
}

function compareProblemIdentity(
  left: { entry: ParsedEntry; source: SourceDocument },
  right: { entry: ParsedEntry; source: SourceDocument },
): number {
  const codeCount = uniqueCodeCount(left.entry) - uniqueCodeCount(right.entry);
  if (codeCount !== 0) return codeCount;
  const codes = canonicalCodePairs(left.entry.codes)
    .localeCompare(canonicalCodePairs(right.entry.codes));
  if (codes !== 0) return codes;
  return left.source.timestamp.localeCompare(right.source.timestamp);
}

function uniqueCodeCount(entry: ParsedEntry): number {
  return new Set(entry.codes.map(codeIdentity)).size;
}

function codeIdentity(code: ParsedCode): string {
  return `${code.system}\u001f${code.code}`;
}

function canonicalCodePairs(codes: readonly ParsedCode[]): string {
  return [...new Set(codes.map(codeIdentity))].sort().join("\u001e");
}

function distinctMedications(sources: readonly SourceDocument[]): Array<{
  codes: ParsedCode[];
  preferredCode?: ParsedCode;
  text?: string;
  source: SourceDocument;
  earliestDate?: string;
}> {
  const grouped = new Map<string, Array<{
    entry: ParsedEntry;
    preferredCode?: ParsedCode;
    source: SourceDocument;
  }>>();
  for (const source of sources) {
    for (const entry of source.document.sections.Medications ?? []) {
      const preferredCode = medicationPreferredCode(entry.codes);
      let key: string;
      if (preferredCode) {
        key = `${preferredCode.system}\u001f${preferredCode.code}`;
      } else {
        if (!entry.text) throw new Error("Text-only medication entry has no narrative text.");
        key = `text\u001f${normalizeText(entry.text)}`;
      }
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
    const codesByIdentity = new Map<string, ParsedCode>();
    for (const occurrence of sorted) {
      for (const code of occurrence.entry.codes) {
        const key = `${code.system}\u001f${code.code}`;
        const existing = codesByIdentity.get(key);
        if (!existing) {
          codesByIdentity.set(key, { ...code });
        } else if (!existing.display && code.display) {
          codesByIdentity.set(key, { ...existing, display: code.display });
        }
      }
    }
    const dates = occurrences
      .map((occurrence) => occurrence.entry.date)
      .filter((date): date is string => Boolean(date))
      .sort();
    const text = sorted.find((occurrence) => occurrence.entry.text)?.entry.text;
    return {
      codes: [...codesByIdentity.values()],
      preferredCode: first.preferredCode,
      ...(text ? { text } : {}),
      source: first.source,
      ...(dates[0] ? { earliestDate: compactDate(dates[0]) } : {}),
    };
  });
}

function medicationPreferredCode(codes: readonly ParsedCode[]): ParsedCode | undefined {
  return codes.find((code) => code.system === "RxNorm") ?? codes[0];
}

function codeableConcept(codes: readonly ParsedCode[], text?: string): CodeableConcept {
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
  return {
    ...(coding.length > 0 ? { coding } : {}),
    ...(text ? { text } : {}),
  };
}

function itemIdentifier(
  ehrPatientId: string,
  documentTimestamp: string,
  section: string,
  entry: ParsedEntry,
): Identifier {
  const canonicalCodes = entry.codes
    .map(({ system, code }) => [system, code] as const)
    .sort(([leftSystem, leftCode], [rightSystem, rightCode]) => {
      if (leftSystem !== rightSystem) return leftSystem < rightSystem ? -1 : 1;
      if (leftCode !== rightCode) return leftCode < rightCode ? -1 : 1;
      return 0;
    })
    .filter((code, index, codes) =>
      index === 0
      || code[0] !== codes[index - 1]![0]
      || code[1] !== codes[index - 1]![1]
    );
  const identityParts: unknown[] = [
    ehrPatientId,
    documentTimestamp,
    section,
    entry.date,
    canonicalCodes,
  ];
  if (entry.codes.length === 0) {
    if (!entry.text) throw new Error("Text-only C-CDA entry has no narrative text.");
    identityParts.push(normalizeText(entry.text));
  }
  const value = createHash("sha256")
    .update(JSON.stringify(identityParts))
    .digest("hex");
  return { system: LEGACY_CCDA_ITEM_IDENTIFIER_SYSTEM, value };
}

function problemIdentifier(
  ehrPatientId: string,
  problem: DistinctProblem,
): Identifier {
  const identityParts: unknown[] = [
    ehrPatientId,
    "Problems",
    problem.identityEntry.date,
    canonicalCodePairs(problem.identityEntry.codes),
  ];
  if (problem.identityEntry.codes.length === 0) {
    if (!problem.identityEntry.text) {
      throw new Error("Text-only problem entry has no narrative text.");
    }
    identityParts.push(normalizeText(problem.identityEntry.text));
  }
  if (!problem.identityEntry.date) identityParts.push(problem.source.timestamp);
  const value = createHash("sha256")
    .update(JSON.stringify(identityParts))
    .digest("hex");
  return { system: LEGACY_CCDA_ITEM_IDENTIFIER_SYSTEM, value };
}

function medicationIdentifier(
  ehrPatientId: string,
  code: ParsedCode | undefined,
  text: string | undefined,
): Identifier {
  let identity: string;
  if (code) {
    identity = `${code.system}|${code.code}`;
  } else {
    if (!text) throw new Error("Text-only medication group has no narrative text.");
    identity = `text|${normalizeText(text)}`;
  }
  const value = createHash("sha256")
    .update(`${ehrPatientId}|Medications|${identity}`)
    .digest("hex");
  return { system: LEGACY_CCDA_ITEM_IDENTIFIER_SYSTEM, value };
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function sourceTimestamp(file: string): string {
  const timestamp = /EMA_(\d{8}T\d+)/.exec(file)?.[1];
  if (!timestamp) throw new Error(`C-CDA filename has no EMA timestamp: ${file}.`);
  return timestamp;
}

export function compactDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export function isCompactCalendarDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function periodIncludesDate(encounter: Encounter, date: string): boolean {
  const start = localCalendarDate(encounter.period?.start);
  const end = localCalendarDate(encounter.period?.end) ?? start;
  return Boolean(start && end && start <= date && end >= date);
}

function localCalendarDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
    const date = value.slice(0, 10);
    return isCompactCalendarDate(date.replaceAll("-", "")) ? date : undefined;
  }
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
