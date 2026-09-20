import type { Basic, Practitioner, Reference } from "@medplum/fhirtypes";
import { searchAll } from "../fhir-search.js";
import type { ExamOverviewFhirClient } from "./exam-overview-endpoint.js";

const SCOPE_SYSTEM = "urn:odos:encounter-exam-scope";
const SCOPE_EXTENSION = "urn:odos:encounter-exam-scope:value";

export type ExamScope = "comprehensive" | "office-visit";
export interface EncounterExamScope {
  examScope: string;
  versionId?: string;
  setBy?: Reference;
  setAt?: string;
}

export class FhirEncounterExamScopeStore {
  constructor(private readonly fhir: ExamOverviewFhirClient) {}

  private async stored(encounterId: string): Promise<Basic | undefined> {
    const rows = await searchAll<Basic>(this.fhir, "Basic", {
      identifier: `${SCOPE_SYSTEM}|${encounterId}`,
      _count: "2",
    });
    if (rows.length > 1) throw new Error("Multiple exam scope records exist for this encounter.");
    const resource = rows[0];
    if (resource && (resource.subject?.reference !== `Encounter/${encounterId}` ||
      !resource.code.coding?.some(code => code.system === SCOPE_SYSTEM && code.code === "exam-scope"))) {
      throw new Error("Exam scope record does not belong to this encounter.");
    }
    return resource;
  }

  async get(encounterId: string): Promise<EncounterExamScope> {
    const resource = await this.stored(encounterId);
    return resource ? parseScope(resource) : { examScope: "comprehensive" };
  }

  async set(encounterId: string, examScope: ExamScope, setBy: Reference<Practitioner>, expectedVersion: string | null): Promise<EncounterExamScope> {
    const existing = await this.stored(encounterId);
    if (existing) parseScope(existing);
    if ((existing?.meta?.versionId ?? null) !== expectedVersion) throw concurrentEdit();
    const setAt = new Date().toISOString();
    const resource: Basic = {
      resourceType: "Basic",
      ...(existing?.id ? { id: existing.id, meta: existing.meta } : {}),
      identifier: [{ system: SCOPE_SYSTEM, value: encounterId }],
      code: { coding: [{ system: SCOPE_SYSTEM, code: "exam-scope" }] },
      subject: { reference: `Encounter/${encounterId}` },
      author: setBy,
      created: setAt.slice(0, 10),
      extension: [{ url: SCOPE_EXTENSION, valueString: JSON.stringify({ examScope, setAt }) }],
    };
    const persisted = existing?.id
      ? await this.fhir.update("Basic", existing.id, resource, { "If-Match": `W/"${expectedVersion}"` })
      : await this.fhir.create(resource, { "If-None-Exist": `identifier=${encodeURIComponent(`${SCOPE_SYSTEM}|${encounterId}`)}` });
    const result = parseScope(persisted);
    // A concurrent conditional create returns the winner, not necessarily our selection.
    if (result.examScope !== examScope || result.setAt !== setAt || result.setBy?.reference !== setBy.reference) throw concurrentEdit();
    return result;
  }
}

function parseScope(resource: Basic): EncounterExamScope {
  const extensions = resource.extension?.filter(row => row.url === SCOPE_EXTENSION) ?? [];
  if (extensions.length !== 1 || !extensions[0].valueString || !resource.id || !resource.meta?.versionId) {
    throw new Error("Exam scope record is incomplete.");
  }
  const value: unknown = JSON.parse(extensions[0].valueString);
  if (typeof value !== "object" || value === null || !("examScope" in value) ||
    typeof value.examScope !== "string" || !("setAt" in value) || typeof value.setAt !== "string" ||
    !Number.isFinite(Date.parse(value.setAt)) || !resource.author?.reference?.match(/^Practitioner\/[^/]+$/)) {
    throw new Error("Exam scope record is invalid.");
  }
  return { examScope: value.examScope, versionId: resource.meta.versionId, setBy: resource.author, setAt: value.setAt };
}

function concurrentEdit(): Error {
  return Object.assign(new Error("Exam scope changed concurrently — reload and retry."), { status: 409 });
}
