import { randomUUID } from "node:crypto";
import type { Basic, Encounter, Observation, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { odosConcept, reference } from "../fhir/ophthalmology/extensions.js";
import { FhirComplaintDefinitionStore } from "./complaint-definition-store.js";
import { renderComplaintNarrative } from "./complaint-model.js";
import { FhirEncounterComplaintStore } from "./encounter-complaint-store.js";
import { buildHpiFindingDefinition, HPI_STABLE_KEY } from "./hpi-definition.js";
import {
  captureGlaucomaFinding,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
  type FindingValue,
} from "./glaucoma-suspect.js";

export interface HpiFhirClient {
  read<T extends Encounter>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Basic>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<import("@medplum/fhirtypes").Bundle<T>>;
  searchUrl?<T extends Basic>(url: string, resourceType: T["resourceType"]): Promise<import("@medplum/fhirtypes").Bundle<T>>;
  create<T extends Basic | Observation | Provenance>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic | Encounter>(resourceType: T["resourceType"], id: string, resource: T, extraHeaders?: Record<string, string>): Promise<T>;
}

export interface HpiEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: HpiFhirClient;
  } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_hpi_ros" } as const;
const rosFlagSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  display: z.string().trim().min(1).max(120),
  category: z.enum(["eye", "general"]),
  status: z.enum(["positive", "negative"]),
}).strict();
const hpiRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[A-Za-z0-9.-]+$/),
  encounterReference: z.string().regex(/^Encounter\/[A-Za-z0-9.-]+$/),
  reviewOfSystems: z.array(rosFlagSchema).max(128),
  reviewAttestations: z.array(z.enum(["eye", "general"])).max(2).default([]),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const flag of value.reviewOfSystems) {
    if (seen.has(flag.code)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Review-of-systems flag ${flag.code} is duplicated.` });
    seen.add(flag.code);
  }
  if (new Set(value.reviewAttestations).size !== value.reviewAttestations.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Review attestations cannot contain duplicates." });
  }
});

export async function handleHpiDefinitionRequest(
  deps: Pick<HpiEndpointDeps, "authenticate" | "findingDefinitions">,
  input: { authHeader: string | undefined },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read HPI definition." } };
  if (!staffMay(staff.actorRole, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const definition = resolveHpiDefinition(deps.findingDefinitions?.());
  return {
    status: 200,
    body: { definition: {
      id: definition.id,
      stableKey: definition.stableKey,
      display: definition.display,
      fields: definition.valueSchema.fields,
      terminologyStatus: definition.valueSchema.terminologyStatus,
    } },
  };
}

export async function handleHpiCaptureRequest(
  deps: HpiEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save history." } };
  if (!staffMay(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = hpiRequestSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid history request." } };

  const encounterId = parsed.data.encounterReference.slice("Encounter/".length);
  const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  if (encounter.subject?.reference !== parsed.data.patientReference) {
    return { status: 400, body: { error: "History patient does not match the encounter subject." } };
  }
  if (encounter.status === "finished" || encounter.status === "cancelled" || encounter.status === "entered-in-error") {
    return { status: 409, body: { error: "Signed or closed encounters cannot be edited." } };
  }
  const definition = resolveHpiDefinition(deps.findingDefinitions?.());
  const rosError = validateRos(parsed.data.reviewOfSystems, definition);
  if (rosError) return { status: 400, body: { error: rosError } };

  const definitions = await new FhirComplaintDefinitionStore(staff.fhir).list();
  const complaints = (await new FhirEncounterComplaintStore(staff.fhir).listByEncounter(encounterId))
    .filter((complaint) => complaint.status === "active")
    .sort((left, right) => left.ordinal - right.ordinal);
  if (!complaints.length) return { status: 400, body: { error: "At least one presenting complaint is required before saving history." } };

  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const provenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt,
    actorReference: staff.staffReference,
    note: [
      "MANDATE-14-DEFERRED: complaint, HPI, and ROS concepts remain ODOS-local; no external terminology code is asserted.",
      ...parsed.data.reviewAttestations.map((group) => `${group} review-of-systems remaining items attested negative.`),
    ].join(" "),
  };
  const findingId = `finding-${HPI_STABLE_KEY}-${randomUUID()}`;
  const captured = captureGlaucomaFinding({
    definition,
    patientReference: parsed.data.patientReference,
    encounterReference: parsed.data.encounterReference,
    laterality: "UNKNOWN",
    value: historyFindingValue(complaints, definitions, parsed.data.reviewOfSystems),
    sourceType: "manual",
    performerReferences: [staff.staffReference],
    recordedAt,
    provenance,
    findingInstanceId: findingId,
    observationId: findingId,
  });
  const observation = await staff.fhir.create<Observation>(captured.observation, WRITE_HEADERS);
  const observationReference = resourceReference(observation.id, captured.observation.id);
  const createdProvenance = await staff.fhir.create<Provenance>({
    ...captured.provenance,
    activity: odosConcept("CREATE", [
      "Capture presenting complaints, history narrative, and review of systems",
      ...parsed.data.reviewAttestations.map((group) => `${group} remaining items reviewed negative`),
    ].join("; ")),
    target: [
      reference(observationReference),
      reference(parsed.data.encounterReference),
      reference(parsed.data.patientReference),
    ],
  }, WRITE_HEADERS);
  return {
    status: 200,
    body: {
      observationReference,
      encounterReference: parsed.data.encounterReference,
      narratives: complaints.map((complaint) => renderComplaintNarrative(
        complaint,
        definitions.find((candidate) => candidate.stableKey === complaint.complaintKey),
      )),
      ...(createdProvenance.id ? { provenanceReference: `Provenance/${createdProvenance.id}` } : {}),
    },
  };
}

function historyFindingValue(
  complaints: Awaited<ReturnType<FhirEncounterComplaintStore["listByEncounter"]>>,
  definitions: Awaited<ReturnType<FhirComplaintDefinitionStore["list"]>>,
  reviewOfSystems: z.infer<typeof rosFlagSchema>[],
): Extract<FindingValue, { type: "components" }> {
  const components: Extract<FindingValue, { type: "components" }>["components"] = complaints.map((complaint) => ({
    code: `HISTORY_COMPLAINT_${complaint.ordinal}`,
    display: complaint.ordinal === 1 ? "Primary complaint history" : `Complaint ${complaint.ordinal} history`,
    value: renderComplaintNarrative(complaint, definitions.find((candidate) => candidate.stableKey === complaint.complaintKey)),
  }));
  for (const flag of reviewOfSystems) {
    components.push({ code: `ROS_${snakeCase(flag.code)}`, display: flag.display, value: flag.status });
  }
  return { type: "components", components };
}

function validateRos(flags: z.infer<typeof rosFlagSchema>[], definition: ClinicalFindingDefinition): string | undefined {
  const field = asRecord(asRecord(definition.valueSchema.fields).reviewOfSystems);
  const options = Array.isArray(field.options) ? field.options.map(asRecord) : [];
  const byCode = new Map(options.flatMap((option) =>
    typeof option.code === "string" && typeof option.category === "string"
      ? [[option.code, option] as const]
      : []
  ));
  for (const flag of flags) {
    const option = byCode.get(flag.code);
    if (!option) {
      if (flag.code.startsWith("custom-") && flag.category === "general") continue;
      return `Review-of-systems flag ${flag.code} is unknown or inactive.`;
    }
    if (option.active === false) return `Review-of-systems flag ${flag.code} is unknown or inactive.`;
    if (option.category !== flag.category) return `Review-of-systems flag ${flag.code} has the wrong category.`;
  }
  return undefined;
}

function resolveHpiDefinition(suppliedDefinitions: ClinicalFindingDefinition[] | undefined): ClinicalFindingDefinition {
  const definitions = suppliedDefinitions ?? [buildHpiFindingDefinition({
    source: "manual",
    recordedAt: new Date(0).toISOString(),
    actorReference: "Practitioner/odos-system",
  })];
  const definition = definitions.find((candidate) => candidate.stableKey === HPI_STABLE_KEY);
  if (!definition) throw new Error("HPI finding definition seed is missing.");
  return definition;
}

function snakeCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1_$2").replaceAll("-", "_").toUpperCase();
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function resourceReference(id: string | undefined, fallbackId: string | undefined): string {
  const resolvedId = id ?? fallbackId;
  if (!resolvedId) throw new Error("Observation create response did not include an id.");
  return `Observation/${resolvedId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
