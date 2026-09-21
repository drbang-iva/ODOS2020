import { randomUUID } from "node:crypto";
import type { Basic } from "@medplum/fhirtypes";
import { z } from "zod";
import { searchAll } from "../fhir-search.js";
import type { ExamOverviewFhirClient } from "./exam-overview-endpoint.js";

const SYSTEM = "urn:odos:encounter-follow-up-decisions";
const EXTENSION = `${SYSTEM}:value`;
const actorSchema = z.object({ reference: z.string().regex(/^Practitioner\/[^/]+$/), display: z.string().optional() });
const valueSchema = z.object({
  decisions: z.record(z.object({ decision: z.literal("not-today"), by: actorSchema, at: z.string().datetime() })),
  writeToken: z.string().min(1),
});
export type FollowUpDecisions = z.infer<typeof valueSchema>["decisions"];
export interface FollowUpDecisionCommand { orderable: string; focus?: string; decision: "not-today" | "put-back" }
export const followUpDecisionKey = (row: { orderable: string; focus?: string }): string => `${row.orderable}|${row.focus ?? ""}`;

export class FhirFollowUpDecisionStore {
  constructor(private readonly fhir: ExamOverviewFhirClient) {}

  private async stored(encounterId: string) {
    const rows = await searchAll<Basic>(this.fhir, "Basic", { identifier: `${SYSTEM}|${encounterId}`, _count: "2" });
    if (rows.length > 1) throw new Error("Multiple follow-up decision records exist for this encounter.");
    const resource = rows[0];
    if (!resource) return { resource, decisions: {} as FollowUpDecisions };
    if (!resource.id || !resource.meta?.versionId || resource.subject?.reference !== `Encounter/${encounterId}` ||
      !resource.code.coding?.some(coding => coding.system === SYSTEM && coding.code === "follow-up-decisions")) {
      throw new Error("Follow-up decision record is invalid.");
    }
    return { resource, decisions: parseValue(resource).decisions };
  }

  async get(encounterId: string): Promise<FollowUpDecisions> {
    return (await this.stored(encounterId)).decisions;
  }

  async apply(encounterId: string, command: FollowUpDecisionCommand, actor: z.infer<typeof actorSchema>): Promise<FollowUpDecisions> {
    const by = actorSchema.parse(actor);
    const key = followUpDecisionKey(command);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { resource: existing, decisions } = await this.stored(encounterId);
      if (command.decision === "not-today" ? decisions[key] !== undefined : decisions[key] === undefined) return decisions;
      if (command.decision === "not-today") decisions[key] = { decision: "not-today", by, at: new Date().toISOString() };
      else delete decisions[key];
      const writeToken = randomUUID();
      const resource: Basic = {
        resourceType: "Basic",
        ...(existing ? { id: existing.id, meta: existing.meta } : {}),
        identifier: [{ system: SYSTEM, value: encounterId }],
        code: { coding: [{ system: SYSTEM, code: "follow-up-decisions" }] },
        subject: { reference: `Encounter/${encounterId}` },
        extension: [{ url: EXTENSION, valueString: JSON.stringify({ decisions, writeToken }) }],
      };
      try {
        const persisted = existing
          ? await this.fhir.update("Basic", existing.id!, resource, { "If-Match": `W/"${existing.meta!.versionId}"` })
          : await this.fhir.create(resource, { "If-None-Exist": `identifier=${encodeURIComponent(`${SYSTEM}|${encounterId}`)}` });
        const confirmed = parseValue(persisted);
        if (confirmed.writeToken === writeToken) return confirmed.decisions;
      } catch (error) {
        const status = (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode;
        if (status !== 409 && status !== 412) throw error;
      }
    }
    throw Object.assign(new Error("The follow-up decisions changed concurrently. Reload and retry."), { status: 409, code: "concurrent-edit" });
  }
}

function parseValue(resource: Basic) {
  const extensions = resource.extension?.filter(extension => extension.url === EXTENSION) ?? [];
  if (extensions.length !== 1 || !extensions[0].valueString) throw new Error("Follow-up decision record is incomplete.");
  return valueSchema.parse(JSON.parse(extensions[0].valueString));
}
