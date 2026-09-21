import { z } from "zod";
import type { Basic } from "@medplum/fhirtypes";
import { searchAll } from "../fhir-search.js";
import type { ExamOverviewFhirClient } from "./exam-overview-endpoint.js";

const VIEW_SYSTEM = "urn:odos:encounter-exam-view-state";
const VIEW_EXTENSION = "urn:odos:encounter-exam-view-state:value";
export const examViewStateSchema = z.object({
  collapsed: z.array(z.string().min(1).max(128)).max(256),
  shelved: z.array(z.string().min(1).max(128)).max(256),
}).strict().transform(value => ({ collapsed: [...new Set(value.collapsed)], shelved: [...new Set(value.shelved)] }));
type ExamViewState = z.infer<typeof examViewStateSchema>;

export class FhirEncounterExamViewStateStore {
  constructor(private readonly fhir: ExamOverviewFhirClient) {}

  private async stored(encounterId: string): Promise<Basic | undefined> {
    const rows = await searchAll<Basic>(this.fhir, "Basic", { identifier: `${VIEW_SYSTEM}|${encounterId}`, _count: "2" });
    if (rows.length > 1) throw new Error("Multiple exam view-state records exist for this encounter.");
    const resource = rows[0];
    if (resource && (resource.subject?.reference !== `Encounter/${encounterId}` ||
      !resource.code.coding?.some(code => code.system === VIEW_SYSTEM && code.code === "exam-view-state"))) {
      throw new Error("Exam view-state record does not belong to this encounter.");
    }
    return resource;
  }

  async get(encounterId: string): Promise<ExamViewState> {
    const resource = await this.stored(encounterId);
    return resource ? parseState(resource) : { collapsed: [], shelved: [] };
  }

  async set(encounterId: string, value: ExamViewState): Promise<ExamViewState> {
    const state = examViewStateSchema.parse(value);
    const existing = await this.stored(encounterId);
    const resource: Basic = {
      resourceType: "Basic",
      ...(existing?.id ? { id: existing.id } : {}),
      identifier: [{ system: VIEW_SYSTEM, value: encounterId }],
      code: { coding: [{ system: VIEW_SYSTEM, code: "exam-view-state" }] },
      subject: { reference: `Encounter/${encounterId}` },
      extension: [{ url: VIEW_EXTENSION, valueString: JSON.stringify(state) }],
    };
    if (existing?.id) return parseState(await this.fhir.update("Basic", existing.id, resource));
    const persisted = await this.fhir.create(resource, {
      "If-None-Exist": new URLSearchParams({ identifier: `${VIEW_SYSTEM}|${encounterId}` }).toString(),
    });
    if (JSON.stringify(parseState(persisted)) === JSON.stringify(state)) return state;
    // A concurrent creator won the identity; this preference still uses last-write-wins.
    return parseState(await this.fhir.update("Basic", persisted.id!, { ...resource, id: persisted.id }));
  }
}

function parseState(resource: Basic): ExamViewState {
  return examViewStateSchema.parse(JSON.parse(resource.extension?.find(row => row.url === VIEW_EXTENSION)?.valueString ?? "null"));
}
