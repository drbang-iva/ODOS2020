import type { Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { captureGlaucomaFinding, patientScopedProvenanceTargets, type ClinicalFindingDefinition, type ClinicalGraphProvenance } from "./glaucoma-suspect.js";
import { isLiveObservation } from "./observation-liveness.js";
import { withDocumentationElements } from "./documentation-elements.js";
import { COVER_TEST_KEY } from "./entrance-definition.js";

export interface CoverTestFhirClient {
  create<T extends Observation | Provenance>(resource: T, headers?: Record<string, string>): Promise<T>;
  search<T extends Observation>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
}
export interface CoverTestEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{ staffReference: string; actorRole: PracticeRoleId; fhir: CoverTestFhirClient } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_section_observations" } as const;
const slotSchema = z.enum(["distance-cc", "distance-sc", "near-cc", "near-sc"]);
const rowSchema = z.discriminatedUnion("state", [
  z.object({ slot: slotSchema, state: z.literal("ortho"), note: z.string().trim().max(2000).optional() }).strict(),
  z.object({
    slot: slotSchema,
    state: z.literal("deviation"),
    deviationType: z.enum(["phoria", "tropia"]),
    direction: z.enum(["eso", "exo", "hyper", "hypo"]),
    magnitude: z.number().min(0).max(60),
    laterality: z.enum(["OD", "OS", "OU", "alternating"]),
    comitancy: z.enum(["comitant", "incomitant"]),
    note: z.string().trim().max(2000).optional(),
  }).strict(),
]);
const captureSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  rows: z.array(rowSchema).min(1).max(4),
}).strict().superRefine((value, context) => {
  if (new Set(value.rows.map((row) => row.slot)).size !== value.rows.length) context.addIssue({ code: "custom", message: "Cover-test row slots must be unique." });
});
const historySchema = z.object({ patient: z.string().regex(/^Patient\/[^/]+$/), encounter: z.string().regex(/^Encounter\/[^/]+$/).optional() }).strict();

export async function handleCoverTestCaptureRequest(deps: CoverTestEndpointDeps, input: { authHeader: string | undefined; body: unknown }) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save cover test." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = captureSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid cover-test request." } };
  const definition = deps.findingDefinitions?.().find((row) => row.stableKey === COVER_TEST_KEY && row.active);
  if (!definition) return { status: 404, body: { error: "Active cover-test definition not found." } };
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const state = parsed.data.rows.every((row) => row.state === "ortho") ? "normal" : "abnormal";
  const components = parsed.data.rows.flatMap((row) => {
    const prefix = row.slot.toUpperCase().replaceAll("-", "_");
    return [
      { code: `${prefix}_STATE`, display: `${row.slot} state`, value: row.state },
      ...(row.state === "deviation" ? [
        { code: `${prefix}_TYPE`, display: `${row.slot} type`, value: row.deviationType },
        { code: `${prefix}_DIRECTION`, display: `${row.slot} direction`, value: row.direction },
        { code: `${prefix}_MAGNITUDE`, display: `${row.slot} magnitude`, value: row.magnitude, unit: "PD" },
        { code: `${prefix}_LATERALITY`, display: `${row.slot} laterality`, value: row.laterality },
        { code: `${prefix}_COMITANCY`, display: `${row.slot} comitancy`, value: row.comitancy },
      ] : []),
      ...(row.note ? [{ code: `${prefix}_NOTE`, display: `${row.slot} note`, value: row.note }] : []),
    ];
  });
  const provenance: ClinicalGraphProvenance = { source: "manual", recordedAt, actorReference: staff.staffReference, note: "Cover-test capture." };
  const captured = captureGlaucomaFinding({
    definition,
    patientReference: parsed.data.patientReference,
    encounterReference: parsed.data.encounterReference,
    laterality: "OU",
    value: { type: "components", components },
    interpretation: state,
    sourceType: "manual",
    performerReferences: [staff.staffReference],
    recordedAt,
    provenance,
  });
  const observation = await staff.fhir.create({
    ...withDocumentationElements(captured.observation, definition, state),
    note: [{ text: parsed.data.rows.map((row) => row.state === "ortho" ? `${row.slot}: ortho${row.note ? ` — ${row.note}` : ""}` : `${row.slot}: ${row.deviationType} ${row.direction} ${row.magnitude}Δ ${row.laterality} ${row.comitancy}${row.note ? ` — ${row.note}` : ""}`).join("; ") }],
  }, WRITE_HEADERS);
  const observationReference = `Observation/${observation.id ?? captured.observation.id}`;
  await staff.fhir.create({ ...captured.provenance, target: patientScopedProvenanceTargets(observationReference, parsed.data.patientReference) }, WRITE_HEADERS);
  return { status: 200, body: { observationReference } };
}

export async function handleCoverTestHistoryRequest(deps: CoverTestEndpointDeps, input: { authHeader: string | undefined; query: unknown }) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read cover-test history." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = historySchema.safeParse(input.query);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid cover-test history request." } };
  const bundle = await staff.fhir.search<Observation>("Observation", {
    subject: parsed.data.patient,
    ...(parsed.data.encounter ? { encounter: parsed.data.encounter } : {}),
    code: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${COVER_TEST_KEY}`,
    _sort: "-date",
    _count: "200",
  });
  return { status: 200, body: { rows: (bundle.entry ?? []).flatMap((entry) => entry.resource && isLiveObservation(entry.resource) ? [{
    ...(entry.resource.id ? { observationReference: `Observation/${entry.resource.id}` } : {}),
    recordedAt: entry.resource.effectiveDateTime ?? "",
    summary: entry.resource.note?.[0]?.text ?? "",
  }] : []) } };
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try { assertBusinessActionAllowed(role, action); return true; } catch { return false; }
}
