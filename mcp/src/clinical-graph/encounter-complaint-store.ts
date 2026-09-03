import type { Basic, Bundle } from "@medplum/fhirtypes";
import type { EncounterComplaint } from "./complaint-model.js";

const BASE = "https://odos2020.com/fhir";
export const ENCOUNTER_COMPLAINT_CODE = "odos-encounter-complaint";
export const ENCOUNTER_COMPLAINT_CODE_SYSTEM = `${BASE}/CodeSystem/odos-encounter-complaint`;
export const ENCOUNTER_COMPLAINT_IDENTIFIER_SYSTEM = `${BASE}/NamingSystem/encounter-complaint-id`;
export const ENCOUNTER_COMPLAINT_EXTENSION_URL = `${BASE}/StructureDefinition/odos-encounter-complaint-json`;
export const ENCOUNTER_COMPLAINT_WRITE_HEADERS = { "X-ODOS-Source": "encounter-complaints" } as const;

export interface EncounterComplaintFhirClient {
  search<T extends Basic>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  searchUrl?<T extends Basic>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic>(resourceType: T["resourceType"], id: string, resource: T, extraHeaders?: Record<string, string>): Promise<T>;
}

export class FhirEncounterComplaintStore {
  constructor(private readonly fhir: EncounterComplaintFhirClient) {}

  async listByEncounter(encounterId: string): Promise<EncounterComplaint[]> {
    return (await this.readRows())
      .map((row) => row.complaint)
      .filter((complaint) => complaint.encounterId === encounterId && complaint.status === "active")
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<EncounterComplaint | undefined> {
    return (await this.readRows()).find((row) => row.complaint.id === id)?.complaint;
  }

  async save(complaint: EncounterComplaint): Promise<EncounterComplaint> {
    const validated = assertEncounterComplaint(complaint);
    let existing = (await this.readRows()).find((row) => row.complaint.id === validated.id)?.resource;
    if (!existing?.id) {
      existing = (await this.readRows()).find((row) => row.complaint.id === validated.id)?.resource;
    }
    const resource = buildEncounterComplaintResource(validated, existing);
    const persisted = existing?.id
      ? await this.fhir.update("Basic", existing.id, resource, {
          ...ENCOUNTER_COMPLAINT_WRITE_HEADERS,
          ...(existing.meta?.versionId ? { "If-Match": `W/"${existing.meta.versionId}"` } : {}),
        })
      : await this.fhir.create(resource, {
          ...ENCOUNTER_COMPLAINT_WRITE_HEADERS,
          "If-None-Exist": `identifier=${ENCOUNTER_COMPLAINT_IDENTIFIER_SYSTEM}|${validated.id}`,
        });
    return parseEncounterComplaintResource(persisted);
  }

  private async readRows(): Promise<Array<{ resource: Basic; complaint: EncounterComplaint }>> {
    const resources: Basic[] = [];
    const visited = new Set<string>();
    let bundle = await this.fhir.search<Basic>("Basic", {
      code: `${ENCOUNTER_COMPLAINT_CODE_SYSTEM}|${ENCOUNTER_COMPLAINT_CODE}`,
      _count: "500",
    });
    while (true) {
      resources.push(...(bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []));
      const next = bundle.link?.find((link) => link.relation === "next")?.url;
      if (!next) break;
      if (!this.fhir.searchUrl) throw new Error("Encounter-complaint search requires pagination support.");
      if (visited.has(next)) throw new Error("Encounter-complaint search returned a repeated next link.");
      visited.add(next);
      bundle = await this.fhir.searchUrl<Basic>(next, "Basic");
    }
    const rows = resources.flatMap((resource) => {
      try {
        return [{ resource, complaint: parseEncounterComplaintResource(resource) }];
      } catch (error) {
        console.error(`Encounter-complaint Basic/${resource.id ?? "unknown"} skipped: ${errorMessage(error)}`);
        return [];
      }
    });
    return resolveStoredDuplicates(rows);
  }
}

export function buildEncounterComplaintResource(complaint: EncounterComplaint, existing?: Basic): Basic {
  const validated = assertEncounterComplaint(complaint);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: ENCOUNTER_COMPLAINT_IDENTIFIER_SYSTEM, value: validated.id }],
    code: { coding: [{
      system: ENCOUNTER_COMPLAINT_CODE_SYSTEM,
      code: ENCOUNTER_COMPLAINT_CODE,
      display: "ODOS encounter complaint",
    }] },
    subject: { reference: `Patient/${validated.patientId}` },
    extension: [{ url: ENCOUNTER_COMPLAINT_EXTENSION_URL, valueString: JSON.stringify(validated) }],
  };
}

export function parseEncounterComplaintResource(resource: Basic): EncounterComplaint {
  if (!resource.code?.coding?.some((coding) =>
    coding.system === ENCOUNTER_COMPLAINT_CODE_SYSTEM && coding.code === ENCOUNTER_COMPLAINT_CODE
  )) throw new Error("Basic resource is not an ODOS encounter complaint.");
  const raw = resource.extension?.find((extension) => extension.url === ENCOUNTER_COMPLAINT_EXTENSION_URL)?.valueString;
  if (!raw) throw new Error("Encounter-complaint Basic is missing its JSON extension.");
  const complaint = assertEncounterComplaint(JSON.parse(raw));
  const identifier = resource.identifier?.find((row) => row.system === ENCOUNTER_COMPLAINT_IDENTIFIER_SYSTEM)?.value;
  if (identifier !== complaint.id) throw new Error("Encounter-complaint identifier does not match id.");
  if (resource.subject?.reference !== `Patient/${complaint.patientId}`) {
    throw new Error("Encounter-complaint subject does not match patientId.");
  }
  return complaint;
}

export function assertEncounterComplaint(value: unknown): EncounterComplaint {
  if (!isRecord(value)) throw new Error("Encounter complaint must be an object.");
  for (const field of ["id", "encounterId", "patientId"] as const) requiredId(value[field], field);
  if (!Number.isInteger(value.ordinal) || Number(value.ordinal) < 1) throw new Error("Encounter complaint ordinal must be a positive integer.");
  if (value.templateKey !== undefined && !validCode(value.templateKey)) throw new Error("Encounter complaint templateKey is invalid.");
  if (value.complaintKey !== undefined && !validCode(value.complaintKey)) throw new Error("Encounter complaint complaintKey is invalid.");
  if (value.complaintKey === undefined && (typeof value.freeTextLabel !== "string" || !value.freeTextLabel.trim())) {
    throw new Error("Other complaints require a freeTextLabel.");
  }
  for (const field of ["conditions", "qualities", "treatmentsTried", "resolvedDx"] as const) assertUniqueStrings(value[field], field);
  if (!['OD', 'OS', 'OU', 'not-applicable'].includes(String(value.eyeLocation))) throw new Error("Encounter complaint eyeLocation is invalid.");
  if (value.eyeComparison !== undefined && !['left-worse', 'equal', 'right-worse', 'other'].includes(String(value.eyeComparison))) {
    throw new Error("Encounter complaint eyeComparison is invalid.");
  }
  if (value.eyeLocation !== "OU" && value.eyeComparison !== undefined) throw new Error("Eye comparison is only valid for both eyes.");
  if (value.eyeComparison === "other" && (typeof value.eyeComparisonOtherText !== "string" || !value.eyeComparisonOtherText.trim())) {
    throw new Error("Other eye comparison requires text.");
  }
  if (value.severity !== undefined && !['mild', 'moderate', 'severe'].includes(String(value.severity))) {
    throw new Error("Encounter complaint severity is invalid.");
  }
  if (value.duration !== undefined) {
    if (!isRecord(value.duration) || !Number.isInteger(value.duration.value) || Number(value.duration.value) < 1 ||
      !['days', 'weeks', 'months', 'years'].includes(String(value.duration.unit))) {
      throw new Error("Encounter complaint duration is invalid.");
    }
  }
  if (typeof value.additionalHistory !== "string" || value.additionalHistory.length > 4000) {
    throw new Error("Encounter complaint additionalHistory is invalid.");
  }
  for (const field of ["freeTextLabel", "eyeComparisonOtherText", "referringPhysicianName"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || String(value[field]).length > 4000)) {
      throw new Error(`Encounter complaint ${field} is invalid.`);
    }
  }
  if (value.referringPhysicianRef !== undefined && !/^Practitioner\/[A-Za-z0-9.-]+$/.test(String(value.referringPhysicianRef))) {
    throw new Error("Encounter complaint referringPhysicianRef is invalid.");
  }
  if (!isRecord(value.narrative) || !['automated', 'override'].includes(String(value.narrative.mode))) {
    throw new Error("Encounter complaint narrative is invalid.");
  }
  if (value.narrative.mode === "override" && (typeof value.narrative.overrideText !== "string" || !value.narrative.overrideText.trim())) {
    throw new Error("Overridden complaint narrative requires overrideText.");
  }
  if (!['active', 'removed'].includes(String(value.status))) throw new Error("Encounter complaint status is invalid.");
  if (!isRecord(value.provenance) || !Array.isArray(value.provenanceHistory) || !value.provenanceHistory.every(isRecord)) {
    throw new Error("Encounter complaint provenance is invalid.");
  }
  return value as unknown as EncounterComplaint;
}

function resolveStoredDuplicates(rows: Array<{ resource: Basic; complaint: EncounterComplaint }>) {
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.complaint.id, [...(grouped.get(row.complaint.id) ?? []), row]);
  return [...grouped.values()].map((group) => group.reduce((winner, candidate) =>
    compareRows(candidate, winner) > 0 ? candidate : winner
  ));
}

function compareRows(left: { resource: Basic }, right: { resource: Basic }): number {
  return (left.resource.meta?.lastUpdated ?? "").localeCompare(right.resource.meta?.lastUpdated ?? "") ||
    (left.resource.id ?? "").localeCompare(right.resource.id ?? "");
}

function assertUniqueStrings(value: unknown, field: string): void {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) {
    throw new Error(`Encounter complaint ${field} must be a string array.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`Encounter complaint ${field} contains duplicates.`);
}

function requiredId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9.-]+$/.test(value)) throw new Error(`Encounter complaint ${field} is invalid.`);
}

function validCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,99}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
