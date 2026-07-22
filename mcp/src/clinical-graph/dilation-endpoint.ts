import type {
  Bundle,
  MedicationAdministration,
  Observation,
  Provenance,
  Reference,
} from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { lateralityConcept, odosConcept, reference } from "../fhir/ophthalmology/extensions.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { withDocumentationElements } from "./documentation-elements.js";
import { DILATION_KEY } from "./entrance-definition.js";
import {
  captureGlaucomaFinding,
  patientScopedProvenanceTargets,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
} from "./glaucoma-suspect.js";

export interface DilationFhirClient {
  create<T extends MedicationAdministration | Observation | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  search<T extends MedicationAdministration | Observation>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  read<T extends MedicationAdministration>(resourceType: T["resourceType"], id: string): Promise<T>;
}

export interface DilationEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: DilationFhirClient;
  } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_section_observations" } as const;

const agentSchema = z.object({
  agent: z.string().trim().min(1).max(100),
  drops: z.number().int().min(1).max(10),
  eyes: z.enum(["OD", "OS", "OU"]),
  time: z.string().datetime(),
}).strict();

const captureSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  agents: z.array(agentSchema).max(8).default([]),
  dfePerformed: z.boolean().default(false),
  declined: z.object({
    reason: z.string().trim().min(1).max(1000),
    counseledRisksNote: z.string().trim().min(1).max(2000),
  }).strict().optional(),
}).strict();

const historySchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
  encounter: z.string().regex(/^Encounter\/[^/]+$/).optional(),
}).strict();

export async function handleDilationCaptureRequest(
  deps: DilationEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save dilation." } };
  if (!staffMay(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = captureSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid dilation request." } };
  const definition = resolveDilationDefinition(deps.findingDefinitions?.());
  if (!definition?.active) return { status: 404, body: { error: "Active dilation definition not found." } };
  if (parsed.data.declined && (parsed.data.dfePerformed || parsed.data.agents.length > 0)) {
    return { status: 400, body: { error: "Declined dilation cannot include administered agents or a performed DFE." } };
  }
  if (!parsed.data.declined && !parsed.data.dfePerformed && parsed.data.agents.length === 0) {
    return { status: 400, body: { error: "Record an administered agent, performed DFE, or declined dilation." } };
  }
  const agentOptions = new Map(readOptions(definition, "agent").map((option) => [option.code, option.display]));
  const unknown = parsed.data.agents.find((agent) => !agentOptions.has(agent.agent));
  if (unknown) return { status: 400, body: { error: `Unknown dilation agent: ${unknown.agent}.` } };

  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const administrationReferences: string[] = [];
  for (const agent of parsed.data.agents) {
    const administration = await staff.fhir.create<MedicationAdministration>({
      resourceType: "MedicationAdministration",
      status: "completed",
      medicationCodeableConcept: odosConcept(agent.agent, agentOptions.get(agent.agent)),
      subject: reference(parsed.data.patientReference),
      context: reference(parsed.data.encounterReference),
      effectiveDateTime: agent.time,
      performer: [{ actor: reference(staff.staffReference) }],
      dosage: {
        text: `${agent.drops} ${agent.drops === 1 ? "drop" : "drops"} ${agent.eyes}`,
        site: lateralityConcept(agent.eyes),
        dose: { value: agent.drops, unit: agent.drops === 1 ? "drop" : "drops" },
      },
    }, WRITE_HEADERS);
    const administrationReference = `MedicationAdministration/${administration.id ?? "unknown"}`;
    administrationReferences.push(administrationReference);
    await staff.fhir.create(buildProvenance({
      targetReferences: [administrationReference, parsed.data.patientReference],
      recorded: recordedAt,
      occurredDateTime: agent.time,
      activityCode: "CREATE",
      activityDisplay: "Record dilation administration",
      agents: [{ typeCode: "performer", whoReference: staff.staffReference }],
    }), WRITE_HEADERS);
  }

  const noteText = parsed.data.declined
    ? `Dilation declined: ${parsed.data.declined.reason} Counseled risks: ${parsed.data.declined.counseledRisksNote}`
    : parsed.data.dfePerformed ? "Dilated fundus examination performed." : "Dilation agents administered; DFE not documented.";
  const provenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt,
    actorReference: staff.staffReference,
    sourceReferences: administrationReferences,
    note: "Dilation and DFE documentation.",
  };
  const captured = captureGlaucomaFinding({
    definition,
    patientReference: parsed.data.patientReference,
    encounterReference: parsed.data.encounterReference,
    laterality: "OU",
    value: {
      type: "components",
      components: [
        { code: "DFE_PERFORMED", display: "DFE performed", value: parsed.data.dfePerformed },
        { code: "DILATION_DECLINED", display: "Dilation declined", value: Boolean(parsed.data.declined) },
        ...(parsed.data.declined ? [
          { code: "DECLINE_REASON", display: "Decline reason", value: parsed.data.declined.reason },
          { code: "COUNSELED_RISKS", display: "Counseled risks", value: parsed.data.declined.counseledRisksNote },
        ] : []),
      ],
    },
    sourceType: "manual",
    performerReferences: [staff.staffReference],
    sourceReferences: administrationReferences,
    recordedAt,
    provenance,
  });
  const documented = parsed.data.dfePerformed ? "normal" : parsed.data.declined ? "deferred" : "absent";
  const observation = await staff.fhir.create<Observation>({
    ...withDocumentationElements(captured.observation, definition, documented),
    partOf: administrationReferences.map((resourceReference): Reference<MedicationAdministration> => ({
      reference: resourceReference,
    })),
    note: [{ text: noteText }],
  }, WRITE_HEADERS);
  const observationReference = `Observation/${observation.id ?? captured.observation.id}`;
  const savedProvenance = await staff.fhir.create<Provenance>({
    ...captured.provenance,
    target: patientScopedProvenanceTargets(observationReference, parsed.data.patientReference),
  }, WRITE_HEADERS);
  return {
    status: 200,
    body: {
      administrationReferences,
      observationReference,
      ...(savedProvenance.id ? { provenanceReference: `Provenance/${savedProvenance.id}` } : {}),
      noteText,
    },
  };
}

export async function handleDilationHistoryRequest(
  deps: DilationEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read dilation history." } };
  if (!staffMay(staff.actorRole, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = historySchema.safeParse(input.query);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid dilation history request." } };
  const observations = await staff.fhir.search<Observation>("Observation", {
    subject: parsed.data.patient,
    ...(parsed.data.encounter ? { encounter: parsed.data.encounter } : {}),
    code: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${DILATION_KEY}`,
    _sort: "-date",
    _count: "200",
  });
  const administrationReferences = [...new Set((observations.entry ?? []).flatMap((entry) =>
    (entry.resource?.partOf ?? []).flatMap((source) =>
      source.reference?.startsWith("MedicationAdministration/") ? [source.reference] : []
    )
  ))];
  const administrations = await Promise.all(administrationReferences.map((resourceReference) =>
    staff.fhir.read<MedicationAdministration>("MedicationAdministration", resourceReference.slice("MedicationAdministration/".length))
  ));
  return {
    status: 200,
    body: {
      notes: (observations.entry ?? []).flatMap((entry) => entry.resource?.note?.[0]?.text
        ? [{ recordedAt: entry.resource.effectiveDateTime ?? "", text: entry.resource.note[0].text }]
        : []),
      administrations: administrations.map((resource) => ({
          recordedAt: resource.effectiveDateTime ?? "",
          agent: resource.medicationCodeableConcept?.text ?? resource.medicationCodeableConcept?.coding?.[0]?.display ?? "Dilation agent",
          drops: resource.dosage?.dose?.value,
          eyes: resource.dosage?.site?.coding?.[0]?.code,
          administeredBy: resource.performer?.[0]?.actor.reference,
      })),
    },
  };
}

function resolveDilationDefinition(definitions: ClinicalFindingDefinition[] | undefined) {
  return definitions?.find((definition) => definition.stableKey === DILATION_KEY);
}

function readOptions(definition: ClinicalFindingDefinition, field: string) {
  const fields = asRecord(definition.valueSchema.fields);
  const options = asRecord(fields[field]).options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    const row = asRecord(option);
    return typeof row.code === "string" && typeof row.display === "string" && row.active !== false
      ? [{ code: row.code, display: row.display }]
      : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
