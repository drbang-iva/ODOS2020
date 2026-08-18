import type { Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import type { Express } from "express";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { patientScopedProvenanceTargets } from "./glaucoma-suspect.js";

export const BLOOD_PRESSURE_PANEL_CODE = "85354-9";
export const CAROTENOID_SCORE_CODE = "biophotonic-skin-carotenoid-score";
const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_section_observations" } as const;

export interface PretestVitalsFhirClient {
  create<T extends Observation | Provenance>(resource: T, headers?: Record<string, string>): Promise<T>;
  search<T extends Observation>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
}

export interface PretestVitalsEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: PretestVitalsFhirClient;
  } | null>;
  now?: () => string;
}

export function registerPretestVitalsRoutes(
  app: Express,
  authenticateService: () => Promise<unknown>,
  routeDeps: (authHeader: string | undefined, action: "chart.read" | "chart.write") => Promise<PretestVitalsEndpointDeps>,
): void {
  app.get("/clinical-graph/pretest-vitals/history", async (req, res) => {
    try {
      await authenticateService();
      const authHeader = req.header("authorization");
      const result = await handlePretestVitalsHistoryRequest(await routeDeps(authHeader, "chart.read"), { authHeader, query: req.query });
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("odos-mcp: pretest vitals history failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "Pretest vitals history route failed" });
    }
  });
  app.post("/clinical-graph/pretest-vitals/blood-pressure", async (req, res) => {
    try {
      await authenticateService();
      const authHeader = req.header("authorization");
      const result = await handleBloodPressureCaptureRequest(await routeDeps(authHeader, "chart.write"), { authHeader, body: req.body });
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("odos-mcp: blood pressure capture failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "Blood pressure route failed" });
    }
  });
  app.post("/clinical-graph/pretest-vitals/carotenoid", async (req, res) => {
    try {
      await authenticateService();
      const authHeader = req.header("authorization");
      const result = await handleCarotenoidCaptureRequest(await routeDeps(authHeader, "chart.write"), { authHeader, body: req.body });
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("odos-mcp: carotenoid score capture failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "Skin carotenoid score route failed" });
    }
  });
}

interface EndpointResult { status: number; body: unknown }

const shared = {
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  recordedAt: z.string().datetime().optional(),
};

const bloodPressureSchema = z.object({
  ...shared,
  systolic: z.number().int().min(30).max(300),
  diastolic: z.number().int().min(20).max(200),
  cuffSite: z.string().trim().min(1).max(120),
  position: z.enum(["sitting", "standing"]),
}).strict();

const carotenoidSchema = z.object({
  ...shared,
  score: z.number().int().min(10_000),
}).strict();

const historySchema = z.object({ patient: z.string().regex(/^Patient\/[^/]+$/) }).strict();

export async function handleBloodPressureCaptureRequest(
  deps: PretestVitalsEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<EndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save blood pressure." } };
  if (!staffMay(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = bloodPressureSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid blood pressure request." } };
  const recordedAt = parsed.data.recordedAt ?? deps.now?.() ?? new Date().toISOString();
  const observation: Observation = {
    resourceType: "Observation",
    meta: { profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure"] },
    status: "preliminary",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }] }],
    code: { coding: [{ system: LOINC, code: BLOOD_PRESSURE_PANEL_CODE, display: "Blood pressure panel with all children optional" }], text: "Blood pressure" },
    subject: { reference: parsed.data.patientReference },
    encounter: { reference: parsed.data.encounterReference },
    effectiveDateTime: recordedAt,
    performer: [{ reference: staff.staffReference }],
    bodySite: { text: parsed.data.cuffSite },
    component: [
      pressureComponent("8480-6", "Systolic blood pressure", parsed.data.systolic),
      pressureComponent("8462-4", "Diastolic blood pressure", parsed.data.diastolic),
      {
        code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: "patient-position", display: "Patient position" }] },
        valueCodeableConcept: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: parsed.data.position, display: capitalize(parsed.data.position) }] },
      },
    ],
  };
  return persistObservation(staff.fhir, observation, parsed.data.patientReference, staff.staffReference, recordedAt);
}

export async function handleCarotenoidCaptureRequest(
  deps: PretestVitalsEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<EndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save skin carotenoid score." } };
  if (!staffMay(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = carotenoidSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid skin carotenoid score request." } };
  const recordedAt = parsed.data.recordedAt ?? deps.now?.() ?? new Date().toISOString();
  const observation: Observation = {
    resourceType: "Observation",
    status: "preliminary",
    code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: CAROTENOID_SCORE_CODE, display: "BioPhotonic skin carotenoid score" }] },
    subject: { reference: parsed.data.patientReference },
    encounter: { reference: parsed.data.encounterReference },
    effectiveDateTime: recordedAt,
    performer: [{ reference: staff.staffReference }],
    device: { display: "Nu Skin Pharmanex S3" },
    valueInteger: parsed.data.score,
  };
  return persistObservation(staff.fhir, observation, parsed.data.patientReference, staff.staffReference, recordedAt);
}

export async function handlePretestVitalsHistoryRequest(
  deps: PretestVitalsEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<EndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read pretest vitals history." } };
  if (!staffMay(staff.actorRole, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = historySchema.safeParse(input.query);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid history request." } };
  const [bpBundle, carotenoidBundle] = await Promise.all([
    staff.fhir.search<Observation>("Observation", { subject: parsed.data.patient, code: `${LOINC}|${BLOOD_PRESSURE_PANEL_CODE}`, _count: "200" }),
    staff.fhir.search<Observation>("Observation", { subject: parsed.data.patient, code: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${CAROTENOID_SCORE_CODE}`, _count: "200" }),
  ]);
  const bloodPressure = resources(bpBundle).filter((row) => hasCode(row, LOINC, BLOOD_PRESSURE_PANEL_CODE)).map((row) => ({
    observationReference: `Observation/${row.id}`,
    encounterReference: row.encounter?.reference,
    recordedAt: row.effectiveDateTime ?? "",
    systolic: componentNumber(row, "8480-6"),
    diastolic: componentNumber(row, "8462-4"),
    cuffSite: row.bodySite?.text ?? "",
    position: row.component?.find((part) => part.code.coding?.some((coding) => coding.code === "patient-position"))?.valueCodeableConcept?.coding?.[0]?.code ?? "",
  })).sort(byRecordedAt);
  const carotenoid = resources(carotenoidBundle).filter((row) => hasCode(row, ODOS_OPHTHALMOLOGY_CODE_SYSTEM, CAROTENOID_SCORE_CODE)).map((row) => ({
    observationReference: `Observation/${row.id}`,
    encounterReference: row.encounter?.reference,
    recordedAt: row.effectiveDateTime ?? "",
    score: row.valueInteger,
    device: row.device?.display ?? "",
  })).sort(byRecordedAt);
  return { status: 200, body: { bloodPressure, carotenoid } };
}

function pressureComponent(code: string, display: string, value: number): NonNullable<Observation["component"]>[number] {
  return { code: { coding: [{ system: LOINC, code, display }] }, valueQuantity: { value, unit: "mmHg", system: UCUM, code: "mm[Hg]" } };
}

async function persistObservation(
  fhir: PretestVitalsFhirClient,
  observation: Observation,
  patientReference: string,
  staffReference: string,
  recordedAt: string,
): Promise<EndpointResult> {
  const saved = await fhir.create(observation, WRITE_HEADERS);
  if (!saved.id) throw new Error("Observation create response did not include an id.");
  const provenance: Provenance = {
    resourceType: "Provenance",
    target: patientScopedProvenanceTargets(`Observation/${saved.id}`, patientReference),
    recorded: recordedAt,
    agent: [{ who: { reference: staffReference } }],
    activity: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation", code: "CREATE" }] },
  };
  const savedProvenance = await fhir.create(provenance, WRITE_HEADERS);
  return { status: 200, body: { observationReference: `Observation/${saved.id}`, provenanceReference: savedProvenance.id ? `Provenance/${savedProvenance.id}` : undefined } };
}

function resources(bundle: Bundle<Observation>): Observation[] {
  return bundle.entry?.flatMap((entry) => entry.resource ? [entry.resource] : []) ?? [];
}

function hasCode(observation: Observation, system: string, code: string): boolean {
  return observation.code.coding?.some((coding) => coding.system === system && coding.code === code) === true;
}

function componentNumber(observation: Observation, code: string): number | undefined {
  return observation.component?.find((part) => part.code.coding?.some((coding) => coding.system === LOINC && coding.code === code))?.valueQuantity?.value;
}

function byRecordedAt(a: { recordedAt: string }, b: { recordedAt: string }): number { return a.recordedAt.localeCompare(b.recordedAt); }
function capitalize(value: string): string { return value[0]?.toUpperCase() + value.slice(1); }
function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try { assertBusinessActionAllowed(role, action); return true; } catch { return false; }
}
