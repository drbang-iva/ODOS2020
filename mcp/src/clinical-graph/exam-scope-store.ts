import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FollowUpProfileRecord } from "./follow-up-profile-store.js";
import type { Basic, Practitioner, Reference } from "@medplum/fhirtypes";
import { searchAll } from "../fhir-search.js";
import type { ExamOverviewFhirClient } from "./exam-overview-endpoint.js";

const SCOPE_SYSTEM = "urn:odos:encounter-exam-scope";
const SCOPE_EXTENSION = "urn:odos:encounter-exam-scope:value";

export type ExamScope = "comprehensive" | "office-visit";
const shapeSchema = z.object({
  profilesApplied: z.array(z.object({ profileKey: z.string().min(1), version: z.number().int().positive(), versionId: z.string().min(1).nullable() })),
  sectionsOpen: z.array(z.string().min(1)),
  shapedAt: z.string().datetime(),
});
type ExamShape = z.infer<typeof shapeSchema>;

export interface EncounterExamScope extends Partial<ExamShape> {
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

  async shapeIfAbsent(encounterId: string, setBy: Reference<Practitioner>, resolve: () => Promise<FollowUpProfileRecord[]>): Promise<EncounterExamScope> {
    const existing = await this.stored(encounterId);
    if (existing) return parseScope(existing);
    const profiles = await resolve();
    const shape: ExamShape = {
      profilesApplied: profiles.map(({ profileKey, version, versionId }) => ({ profileKey, version, versionId })),
      sectionsOpen: [...new Set(profiles.flatMap(profile => profile.sectionsOpen.map(section => section.key)))],
      shapedAt: new Date().toISOString(),
    };
    return this.write(encounterId, "comprehensive", setBy, null, undefined, shape);
  }

  async set(encounterId: string, examScope: ExamScope, setBy: Reference<Practitioner>, expectedVersion: string | null): Promise<EncounterExamScope> {
    const existing = await this.stored(encounterId);
    if (existing) parseScope(existing);
    if ((existing?.meta?.versionId ?? null) !== expectedVersion) throw concurrentEdit();
    const parsed = existing ? parseScope(existing) : undefined;
    const shape = parsed?.shapedAt ? shapeSchema.parse(parsed) : undefined;
    return this.write(encounterId, examScope, setBy, expectedVersion, existing, shape);
  }

  private async write(encounterId: string, examScope: ExamScope, setBy: Reference<Practitioner>, expectedVersion: string | null, existing?: Basic, shape?: ExamShape): Promise<EncounterExamScope> {
    const setAt = new Date().toISOString();
    const writeToken = randomUUID();
    const resource: Basic = {
      resourceType: "Basic",
      ...(existing?.id ? { id: existing.id, meta: existing.meta } : {}),
      identifier: [{ system: SCOPE_SYSTEM, value: encounterId }],
      code: { coding: [{ system: SCOPE_SYSTEM, code: "exam-scope" }] },
      subject: { reference: `Encounter/${encounterId}` },
      author: setBy,
      created: setAt.slice(0, 10),
      extension: [{ url: SCOPE_EXTENSION, valueString: JSON.stringify({ examScope, setAt, ...shape, writeToken }) }],
    };
    const persisted = existing?.id
      ? await this.fhir.update("Basic", existing.id, resource, { "If-Match": `W/"${expectedVersion}"` })
      : await this.fhir.create(resource, { "If-None-Exist": `identifier=${encodeURIComponent(`${SCOPE_SYSTEM}|${encounterId}`)}` });
    const result = parseScope(persisted);
    const persistedValue = JSON.parse(persisted.extension!.find(row => row.url === SCOPE_EXTENSION)!.valueString!);
    if (persistedValue.writeToken !== writeToken) throw concurrentEdit();
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
  const shape = ["profilesApplied", "sectionsOpen", "shapedAt"].some(key => key in value) ? shapeSchema.parse(value) : undefined;
  return { ...shape, examScope: value.examScope, versionId: resource.meta.versionId, setBy: resource.author, setAt: value.setAt };
}

function concurrentEdit(): Error {
  return Object.assign(new Error("Exam scope changed concurrently — reload and retry."), { status: 409 });
}
