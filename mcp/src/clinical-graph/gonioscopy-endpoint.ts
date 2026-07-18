import type { Bundle, Observation } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import {
  buildGonioQuadrantObservation,
  GONIO_EYES,
  GONIO_PIGMENTATION,
  GONIO_QUADRANTS,
  GONIO_STRUCTURES,
  parseGonioQuadrantObservation,
  type GonioQuadrantRecord,
} from "./gonioscopy.js";

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_section_observations" } as const;
const quadrantSchema = z.enum(GONIO_QUADRANTS);
const structureSchema = z.enum(GONIO_STRUCTURES);
const eyeSchema = z.enum(GONIO_EYES);
const recordSchema = z.object({
  eye: eyeSchema,
  quadrant: quadrantSchema,
  value: structureSchema,
  entryMode: z.enum(["propagated-uniform", "quadrant-specific"]),
}).strict();
const requestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  records: z.array(recordSchema),
  pigmentation: z.object({ OD: z.enum(GONIO_PIGMENTATION).optional(), OS: z.enum(GONIO_PIGMENTATION).optional() }).strict().optional(),
  note: z.string().optional(),
}).strict();

interface GonioFhir {
  search<T extends Observation>(type: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  create<T extends Observation>(resource: T, headers?: Record<string, string>): Promise<T>;
}
interface Staff { staffReference: string; actorRole: PracticeRoleId; fhir: GonioFhir }
export interface GonioscopyEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<Staff | null>;
  now?: () => string;
}

export async function handleGonioscopyReadRequest(
  deps: GonioscopyEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read gonioscopy." } };
  if (!may(staff.actorRole, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const query = z.object({ encounterReference: z.string().regex(/^Encounter\/[^/]+$/) }).safeParse(input.query);
  if (!query.success) return { status: 400, body: { error: "encounterReference is required." } };
  const bundle = await staff.fhir.search<Observation>("Observation", {
    encounter: query.data.encounterReference,
    code: "https://odos2020.com/fhir/CodeSystem/odos|gonio_angle_structures",
    _count: "100",
    _sort: "-date",
  });
  const records = latestRecords((bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []));
  return { status: 200, body: { records } };
}

export async function handleGonioscopyCaptureRequest(
  deps: GonioscopyEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save gonioscopy." } };
  if (!may(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = requestSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid gonioscopy request." } };
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const records = [];
  for (const record of parsed.data.records) {
    const saved = await staff.fhir.create(buildGonioQuadrantObservation({
      encounterReference: parsed.data.encounterReference,
      patientReference: parsed.data.patientReference,
      actorReference: staff.staffReference,
      recordedAt,
      record: { ...record, source: "clinician-entered" },
    }), WRITE_HEADERS);
    records.push(parseGonioQuadrantObservation(saved));
  }
  // Pigmentation and the section note are deliberately separate records from the 8 angle quadrants.
  for (const [eye, value] of Object.entries(parsed.data.pigmentation ?? {})) {
    await staff.fhir.create(simpleObservation("gonio_tm_pigmentation", value!, parsed.data, staff.staffReference, recordedAt, eye), WRITE_HEADERS);
  }
  if (parsed.data.note?.trim()) {
    await staff.fhir.create(simpleObservation("gonio_note", parsed.data.note.trim(), parsed.data, staff.staffReference, recordedAt), WRITE_HEADERS);
  }
  return { status: 200, body: { records: records.filter(Boolean) } };
}

export function latestRecords(observations: Observation[]) {
  const result = new Map<string, ReturnType<typeof parseGonioQuadrantObservation>>();
  for (const observation of observations.sort((a, b) =>
    String(b.effectiveDateTime ?? b.issued ?? "").localeCompare(String(a.effectiveDateTime ?? a.issued ?? "")))) {
    const record = parseGonioQuadrantObservation(observation);
    if (record) {
      const key = `${record.eye}:${record.quadrant}`;
      if (!result.has(key)) result.set(key, record);
    }
  }
  return [...result.values()].filter((row): row is GonioQuadrantRecord => Boolean(row));
}

function simpleObservation(
  code: string,
  value: string,
  request: { patientReference: string; encounterReference: string },
  actor: string,
  at: string,
  eye?: string,
): Observation {
  return {
    resourceType: "Observation", status: "final",
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/odos", code }] },
    subject: { reference: request.patientReference }, encounter: { reference: request.encounterReference },
    effectiveDateTime: at, issued: at, performer: [{ reference: actor }],
    ...(eye ? { bodySite: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/laterality", code: eye }] } } : {}),
    valueString: value,
  };
}
function may(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try { assertBusinessActionAllowed(role, action); return true; } catch { return false; }
}
