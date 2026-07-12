import type { Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { OSOD_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { OSOD_EXTENSION_URLS } from "../fhir/ophthalmology/extensions.js";
import {
  appendCustomFieldComponentsToObservation,
  customFieldEntries,
  customFieldValueSchema,
  observationCustomValue,
  validateCustomFieldValues,
} from "./custom-fields.js";
import {
  captureGlaucomaFinding,
  patientScopedProvenanceTargets,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
  type CapturedGlaucomaFinding,
} from "./glaucoma-suspect.js";

type Eye = "OD" | "OS";

export interface CustomSectionFhirClient {
  create<T extends Observation | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  search<T extends Observation>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
}

export interface CustomSectionEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: CustomSectionFhirClient;
  } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

const WRITE_HEADERS = { "X-OSOD-Source": "mcp/save_section_observations" } as const;
const EYES: Eye[] = ["OD", "OS"];

const eyePayloadSchema = z.object({
  customFields: z.array(customFieldValueSchema).max(64),
  state: z.enum(["normal", "abnormal", "deferred"]).optional(),
  other: z.string().trim().max(2000).optional(),
}).strict();

const captureSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  customFields: z.array(customFieldValueSchema).max(64).optional(),
  eyes: z.object({
    OD: eyePayloadSchema.optional(),
    OS: eyePayloadSchema.optional(),
  }).strict().optional(),
  remarks: z.string().trim().max(2000).optional(),
}).strict();

const historyQuerySchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
  encounter: z.string().regex(/^Encounter\/[^/]+$/).optional(),
}).strict();

export async function handleCustomSectionCaptureRequest(
  deps: CustomSectionEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save custom section findings." } };
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const definition = resolveCustomDefinition(deps.findingDefinitions?.(), input.params, true);
  if (!definition) return { status: 404, body: { error: "Active custom section not found." } };
  const parsed = captureSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid custom section request." } };
  }
  const perEye = definition.valueSchema.perEye === true;
  const ocularHealth = definition.valueSchema.type === "ocular-health-structure";
  if (perEye !== Boolean(parsed.data.eyes) || perEye === Boolean(parsed.data.customFields)) {
    return { status: 400, body: { error: perEye ? "This section requires eyes payloads." : "This section requires a per-record customFields payload." } };
  }
  const eyeRows = EYES.flatMap((eye) => parsed.data.eyes?.[eye]
    ? [{
        eye,
        values: parsed.data.eyes[eye]!.customFields,
        state: parsed.data.eyes[eye]!.state,
        other: parsed.data.eyes[eye]!.other,
      }]
    : []);
  if (perEye && eyeRows.length === 0) {
    return { status: 400, body: { error: "At least one eye payload is required." } };
  }
  const rows = perEye
    ? eyeRows
    : [{ eye: "UNKNOWN" as const, values: parsed.data.customFields ?? [], state: undefined, other: undefined }];
  if (ocularHealth && rows.some((row) => !row.state)) {
    return { status: 400, body: { error: "Ocular-health eye payloads require an explicit normal, abnormal, or deferred state." } };
  }
  if (ocularHealth && rows.some((row) => row.state === "deferred") && definition.normalSemantics?.allowDeferred !== true) {
    return { status: 400, body: { error: "Deferred is not enabled for this ocular-health structure." } };
  }
  if (ocularHealth && rows.some((row) => row.state !== "abnormal" && row.values.length > 0)) {
    return { status: 400, body: { error: "Only an abnormal ocular-health state may carry abnormal findings." } };
  }
  if (!ocularHealth && rows.some((row) => row.state !== undefined || row.other !== undefined)) {
    return { status: 400, body: { error: "Exam state and other text are only supported for ocular-health structures." } };
  }
  if (rows.every((row) => row.values.length === 0 && !row.state && !row.other) && !parsed.data.remarks) {
    return { status: 400, body: { error: "Enter at least one custom field or note before saving." } };
  }
  for (const row of rows) {
    const validationError = validateCustomFieldValues(row.values, definition, row.eye);
    if (validationError) return { status: 400, body: { error: validationError } };
  }

  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const provenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt,
    actorReference: staff.staffReference,
    note: "Practice-created custom section capture.",
  };
  const results = [];
  for (const row of rows) {
    const captured = captureGlaucomaFinding({
      definition,
      patientReference: parsed.data.patientReference,
      encounterReference: parsed.data.encounterReference,
      laterality: row.eye,
      value: {
        type: "components",
        components: [
          ...(parsed.data.remarks
            ? [{ code: "REMARKS", display: "Remarks", value: parsed.data.remarks }]
            : []),
          ...(ocularHealth && row.state
            ? [{ code: "EXAM_STATE", display: "Exam state", value: row.state }]
            : []),
          ...(ocularHealth && row.state === "normal" && typeof definition.normalSemantics?.template === "string"
            ? [{ code: "NORMAL_TEMPLATE", display: "Normal template", value: definition.normalSemantics.template }]
            : []),
          ...(ocularHealth && row.other
            ? [{ code: "OTHER", display: "Other", value: row.other }]
            : []),
        ],
      },
      sourceType: "manual",
      performerReferences: [staff.staffReference],
      recordedAt,
      provenance,
    });
    const coded = {
      ...captured,
      observation: appendCustomFieldComponentsToObservation(
        captured.observation,
        row.values,
        definition,
        perEye ? `${row.eye}_` : "",
      ),
    };
    results.push(await persistCapture(
      staff.fhir,
      coded,
      row.eye,
      parsed.data.patientReference,
    ));
  }
  return { status: 200, body: perEye ? { eyes: Object.fromEntries(results.map((row) => [row.eye, row])) } : results[0] };
}

export async function handleCustomSectionHistoryRequest(
  deps: CustomSectionEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; query: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read custom section history." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const definition = resolveCustomDefinition(deps.findingDefinitions?.(), input.params, false);
  if (!definition) return { status: 404, body: { error: "Custom section not found." } };
  const parsed = historyQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid custom section history request." } };
  }
  const bundle = await staff.fhir.search<Observation>("Observation", {
    subject: parsed.data.patient,
    code: `${OSOD_OPHTHALMOLOGY_CODE_SYSTEM}|${definition.stableKey}`,
    ...(parsed.data.encounter ? { encounter: parsed.data.encounter } : {}),
    _sort: "-date",
    _count: "200",
  });
  const rows = (bundle.entry ?? []).flatMap((entry) => {
    const observation = entry.resource;
    if (!observation) return [];
    const eye = observationEye(observation);
    const perEye = definition.valueSchema.perEye === true;
    const prefix = perEye && (eye === "OD" || eye === "OS") ? `${eye}_` : "";
    const values = customFieldEntries(definition, true).flatMap((field) => {
      const value = observationCustomValue(observation, field, prefix);
      return value === undefined ? [] : [{
        code: field.localCode,
        label: field.display,
        value,
        ...(field.unit ? { unit: field.unit } : {}),
      }];
    });
    return [{
      recordedAt: observation.effectiveDateTime ?? observation.issued ?? observation.meta?.lastUpdated ?? "",
      ...(perEye && (eye === "OD" || eye === "OS") ? { eye } : {}),
      values,
      ...(componentString(observation, "EXAM_STATE") ? { state: componentString(observation, "EXAM_STATE") } : {}),
      ...(componentString(observation, "NORMAL_TEMPLATE") ? { normalTemplate: componentString(observation, "NORMAL_TEMPLATE") } : {}),
      ...(componentString(observation, "OTHER") ? { other: componentString(observation, "OTHER") } : {}),
      ...(componentString(observation, "REMARKS") ? { remarks: componentString(observation, "REMARKS") } : {}),
    }];
  });
  return { status: 200, body: { rows } };
}

function resolveCustomDefinition(
  definitions: ClinicalFindingDefinition[] | undefined,
  params: unknown,
  requireActive: boolean,
): ClinicalFindingDefinition | undefined {
  const stableKey = readStableKey(params);
  if (!stableKey?.startsWith("custom:") && !stableKey?.startsWith("ocular-health:")) return undefined;
  return definitions?.find((definition) =>
    definition.stableKey === stableKey &&
    definition.sectionKey === stableKey &&
    (!requireActive || definition.active)
  );
}

async function persistCapture(
  fhir: CustomSectionFhirClient,
  captured: CapturedGlaucomaFinding,
  eye: Eye | "UNKNOWN",
  patientReference: string,
) {
  const observation = await fhir.create(captured.observation, WRITE_HEADERS);
  const observationReference = `Observation/${observation.id ?? captured.observation.id}`;
  const provenance = await fhir.create({
    ...captured.provenance,
    target: patientScopedProvenanceTargets(
      observationReference,
      patientReference,
    ),
  }, WRITE_HEADERS);
  return {
    eye,
    observationReference,
    ...(provenance.id ? { provenanceReference: `Provenance/${provenance.id}` } : {}),
  };
}

function observationEye(observation: Observation): string | undefined {
  return observation.extension?.find((extension) => extension.url === OSOD_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
}

function componentString(observation: Observation, code: string): string | undefined {
  const value = observation.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === code)
  )?.valueString;
  return value?.trim() || undefined;
}

function readStableKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const stableKey = (value as Record<string, unknown>).stableKey;
  return typeof stableKey === "string" && stableKey.trim() ? stableKey.trim() : undefined;
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
