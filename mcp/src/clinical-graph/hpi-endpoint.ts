import { randomUUID } from "node:crypto";
import type { Encounter, Observation, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { odosConcept, reference } from "../fhir/ophthalmology/extensions.js";
import { buildHpiFindingDefinition, HPI_ROS_OPTIONS, HPI_STABLE_KEY } from "./hpi-definition.js";
import {
  captureGlaucomaFinding,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
  type FindingValue,
} from "./glaucoma-suspect.js";

export interface HpiFhirClient {
  read<T extends Encounter>(resourceType: T["resourceType"], id: string): Promise<T>;
  create<T extends Observation | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  update<T extends Encounter>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
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
const HPI_FIELD_DISPLAYS = {
  location: "Location",
  quality: "Quality",
  severity: "Severity",
  duration: "Duration",
  timing: "Timing",
  context: "Context",
  modifyingFactors: "Modifying factors",
  associatedSignsSymptoms: "Associated signs / symptoms",
} as const;

const hpiElementSchema = z.string().trim().max(2000).optional();
const rosFlagSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  display: z.string().trim().min(1).max(120),
  category: z.enum(["eye", "general"]),
  status: z.enum(["positive", "negative"]),
}).strict();
const hpiRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  chiefComplaint: z.string().trim().min(1).max(2000),
  hpi: z.object({
    location: hpiElementSchema,
    quality: hpiElementSchema,
    severity: hpiElementSchema,
    duration: hpiElementSchema,
    timing: hpiElementSchema,
    context: hpiElementSchema,
    modifyingFactors: hpiElementSchema,
    associatedSignsSymptoms: hpiElementSchema,
  }).strict(),
  reviewOfSystems: z.array(rosFlagSchema).max(64),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const flag of value.reviewOfSystems) {
    if (seen.has(flag.code)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Review-of-systems flag ${flag.code} is duplicated.` });
    }
    seen.add(flag.code);
    const seeded = HPI_ROS_OPTIONS.find((option) => option.code === flag.code);
    if (seeded && seeded.category !== flag.category) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Review-of-systems flag ${flag.code} has the wrong category.` });
    }
    if (!seeded && flag.category !== "general") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Custom review-of-systems flags must be general-medical flags." });
    }
  }
});

export async function handleHpiDefinitionRequest(
  deps: Pick<HpiEndpointDeps, "authenticate" | "findingDefinitions">,
  input: { authHeader: string | undefined },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read HPI definition." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const definition = resolveHpiDefinition(deps.findingDefinitions?.());
  return {
    status: 200,
    body: {
      definition: {
        id: definition.id,
        stableKey: definition.stableKey,
        display: definition.display,
        fields: definition.valueSchema.fields,
        terminologyStatus: definition.valueSchema.terminologyStatus,
      },
    },
  };
}

export async function handleHpiCaptureRequest(
  deps: HpiEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save HPI findings." } };
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsed = hpiRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid HPI request." } };
  }

  const definition = resolveHpiDefinition(deps.findingDefinitions?.());
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const provenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt,
    actorReference: staff.staffReference,
    note: "MANDATE-14-DEFERRED: HPI and ROS remain ODOS-local; no external terminology code is asserted.",
  };
  const findingId = `finding-${HPI_STABLE_KEY}-${randomUUID()}`;
  const captured = captureGlaucomaFinding({
    definition,
    patientReference: parsed.data.patientReference,
    encounterReference: parsed.data.encounterReference,
    laterality: "UNKNOWN",
    value: hpiFindingValue(parsed.data),
    sourceType: "manual",
    performerReferences: [staff.staffReference],
    recordedAt,
    provenance,
    findingInstanceId: findingId,
    observationId: findingId,
  });
  const observation = await staff.fhir.create<Observation>(captured.observation, WRITE_HEADERS);
  const observationReference = resourceReference("Observation", observation.id, captured.observation.id);

  const encounterId = parsed.data.encounterReference.slice("Encounter/".length);
  const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  await staff.fhir.update(
    "Encounter",
    encounterId,
    stampChiefComplaint(encounter, parsed.data.chiefComplaint),
    WRITE_HEADERS,
  );

  const createdProvenance = await staff.fhir.create<Provenance>({
    ...captured.provenance,
    activity: odosConcept("CREATE", "Capture chief complaint, HPI, and review of systems"),
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
      ...(createdProvenance.id ? { provenanceReference: `Provenance/${createdProvenance.id}` } : {}),
    },
  };
}

export function stampChiefComplaint(encounter: Encounter, chiefComplaint: string): Encounter {
  let replaced = false;
  const reasonCode = (encounter.reasonCode ?? []).map((reason) => {
    if (!replaced && !(reason.coding?.length)) {
      replaced = true;
      return { text: chiefComplaint };
    }
    return reason;
  });
  if (!replaced) reasonCode.push({ text: chiefComplaint });
  return { ...encounter, reasonCode };
}

function resolveHpiDefinition(
  suppliedDefinitions: ClinicalFindingDefinition[] | undefined,
): ClinicalFindingDefinition {
  const definitions = suppliedDefinitions ?? [buildHpiFindingDefinition({
    source: "manual",
    recordedAt: new Date(0).toISOString(),
    actorReference: "Practitioner/odos-system",
  })];
  const definition = definitions.find((candidate) => candidate.stableKey === HPI_STABLE_KEY);
  if (!definition) throw new Error("HPI finding definition seed is missing.");
  return definition;
}

function hpiFindingValue(
  input: z.infer<typeof hpiRequestSchema>,
): Extract<FindingValue, { type: "components" }> {
  const components: Extract<FindingValue, { type: "components" }>["components"] = [
    { code: "CHIEF_COMPLAINT", display: "Chief complaint", value: input.chiefComplaint },
  ];
  for (const [key, display] of Object.entries(HPI_FIELD_DISPLAYS)) {
    const value = input.hpi[key as keyof typeof HPI_FIELD_DISPLAYS];
    if (value) components.push({ code: `HPI_${snakeCase(key)}`, display, value });
  }
  const defaults = new Map<string, { display: string }>(
    HPI_ROS_OPTIONS.map((option) => [option.code, option]),
  );
  for (const flag of input.reviewOfSystems) {
    const option = defaults.get(flag.code);
    components.push({
      code: `ROS_${snakeCase(flag.code)}`,
      display: option?.display ?? flag.display,
      value: flag.status,
    });
  }
  return { type: "components", components };
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

function resourceReference(resourceType: "Observation", id: string | undefined, fallbackId: string | undefined): string {
  const resolvedId = id ?? fallbackId;
  if (!resolvedId) throw new Error(`${resourceType} create response did not include an id.`);
  return `${resourceType}/${resolvedId}`;
}
