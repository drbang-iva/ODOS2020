import type { Bundle, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import type { Express } from "express";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { searchAll } from "../fhir-search.js";
import { patientScopedProvenanceTargets } from "./glaucoma-suspect.js";

export const BLOOD_PRESSURE_PANEL_CODE = "85354-9";
export const BODY_HEIGHT_CODE = "8302-2";
export const BODY_WEIGHT_CODE = "29463-7";
export const CAROTENOID_SCORE_CODE = "biophotonic-skin-carotenoid-score";
const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_section_observations" } as const;

export interface PretestVitalsFhirClient {
  create<T extends Observation | Provenance>(resource: T, headers?: Record<string, string>): Promise<T>;
  executeTransaction(bundle: Bundle, headers?: Record<string, string>): Promise<Bundle>;
  search<T extends Resource>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
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
  app.post("/clinical-graph/pretest-vitals/body-measurements", async (req, res) => {
    try {
      await authenticateService();
      const authHeader = req.header("authorization");
      const result = await handleBodyMeasurementsCaptureRequest(await routeDeps(authHeader, "chart.write"), { authHeader, body: req.body });
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("odos-mcp: body measurements capture failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "Body measurements route failed" });
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
  score: z.number().int().min(10_000).max(90_000),
}).strict();

const bodyMeasurementsSchema = z.object({
  ...shared,
  height: z.object({ value: z.number().positive(), unit: z.enum(["in", "cm"]) }).strict(),
  weight: z.object({ value: z.number().positive(), unit: z.enum(["lb", "kg"]) }).strict(),
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

export async function handleBodyMeasurementsCaptureRequest(
  deps: PretestVitalsEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<EndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save height and weight." } };
  if (!staffMay(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = bodyMeasurementsSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid height and weight request." } };
  const recordedAt = parsed.data.recordedAt ?? deps.now?.() ?? new Date().toISOString();
  const height = bodyMeasurementObservation({
    profile: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-body-height",
    code: BODY_HEIGHT_CODE,
    display: "Body height",
    value: parsed.data.height.unit === "cm" ? parsed.data.height.value / 2.54 : parsed.data.height.value,
    unit: "in",
    unitCode: "[in_i]",
    patientReference: parsed.data.patientReference,
    encounterReference: parsed.data.encounterReference,
    staffReference: staff.staffReference,
    recordedAt,
  });
  const weight = bodyMeasurementObservation({
    profile: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-body-weight",
    code: BODY_WEIGHT_CODE,
    display: "Body weight",
    value: parsed.data.weight.unit === "kg" ? parsed.data.weight.value / 0.45359237 : parsed.data.weight.value,
    unit: "lb",
    unitCode: "[lb_av]",
    patientReference: parsed.data.patientReference,
    encounterReference: parsed.data.encounterReference,
    staffReference: staff.staffReference,
    recordedAt,
  });
  const heightFullUrl = "urn:uuid:body-height";
  const weightFullUrl = "urn:uuid:body-weight";
  const transaction = await staff.fhir.executeTransaction({
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      { fullUrl: heightFullUrl, resource: height, request: { method: "POST", url: "Observation" } },
      {
        fullUrl: "urn:uuid:body-height-provenance",
        resource: observationProvenance(heightFullUrl, parsed.data.patientReference, staff.staffReference, recordedAt),
        request: { method: "POST", url: "Provenance" },
      },
      { fullUrl: weightFullUrl, resource: weight, request: { method: "POST", url: "Observation" } },
      {
        fullUrl: "urn:uuid:body-weight-provenance",
        resource: observationProvenance(weightFullUrl, parsed.data.patientReference, staff.staffReference, recordedAt),
        request: { method: "POST", url: "Provenance" },
      },
    ],
  }, { ...WRITE_HEADERS, Prefer: "return=representation" });
  return {
    status: 200,
    body: {
      height: {
        observationReference: transactionCreatedReference(transaction, 0, "Observation"),
        provenanceReference: transactionCreatedReference(transaction, 1, "Provenance"),
      },
      weight: {
        observationReference: transactionCreatedReference(transaction, 2, "Observation"),
        provenanceReference: transactionCreatedReference(transaction, 3, "Provenance"),
      },
    },
  };
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
  const [bpRows, carotenoidRows, heightRows, weightRows] = await Promise.all([
    searchAll<Observation>(staff.fhir, "Observation", { subject: parsed.data.patient, code: `${LOINC}|${BLOOD_PRESSURE_PANEL_CODE}`, _count: "200" }),
    searchAll<Observation>(staff.fhir, "Observation", { subject: parsed.data.patient, code: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${CAROTENOID_SCORE_CODE}`, _count: "200" }),
    searchAll<Observation>(staff.fhir, "Observation", { subject: parsed.data.patient, code: `${LOINC}|${BODY_HEIGHT_CODE}`, "status:not": "entered-in-error", _sort: "-date", _count: "1" }),
    searchAll<Observation>(staff.fhir, "Observation", { subject: parsed.data.patient, code: `${LOINC}|${BODY_WEIGHT_CODE}`, "status:not": "entered-in-error", _sort: "-date", _count: "1" }),
  ]);
  const bloodPressure = bpRows.filter((row) => hasCode(row, LOINC, BLOOD_PRESSURE_PANEL_CODE)).map((row) => ({
    observationReference: `Observation/${row.id}`,
    encounterReference: row.encounter?.reference,
    recordedAt: row.effectiveDateTime ?? "",
    systolic: componentNumber(row, "8480-6"),
    diastolic: componentNumber(row, "8462-4"),
    cuffSite: row.bodySite?.text ?? "",
    position: row.component?.find((part) => part.code.coding?.some((coding) => coding.code === "patient-position"))?.valueCodeableConcept?.coding?.[0]?.code ?? "",
  })).sort(byRecordedAt);
  const carotenoid = carotenoidRows.filter((row) => hasCode(row, ODOS_OPHTHALMOLOGY_CODE_SYSTEM, CAROTENOID_SCORE_CODE)).map((row) => ({
    observationReference: `Observation/${row.id}`,
    encounterReference: row.encounter?.reference,
    recordedAt: row.effectiveDateTime ?? "",
    score: row.valueInteger,
    device: row.device?.display ?? "",
  })).sort(byRecordedAt);
  const height = latestBodyMeasurement(heightRows, BODY_HEIGHT_CODE);
  const weight = latestBodyMeasurement(weightRows, BODY_WEIGHT_CODE);
  return { status: 200, body: { bloodPressure, carotenoid, height, weight } };
}

function bodyMeasurementObservation(input: {
  profile: string;
  code: string;
  display: string;
  value: number;
  unit: "in" | "lb";
  unitCode: "[in_i]" | "[lb_av]";
  patientReference: string;
  encounterReference: string;
  staffReference: string;
  recordedAt: string;
}): Observation {
  return {
    resourceType: "Observation",
    meta: { profile: [input.profile] },
    status: "preliminary",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }] }],
    code: { coding: [{ system: LOINC, code: input.code, display: input.display }], text: input.display },
    subject: { reference: input.patientReference },
    encounter: { reference: input.encounterReference },
    effectiveDateTime: input.recordedAt,
    performer: [{ reference: input.staffReference }],
    valueQuantity: { value: input.value, unit: input.unit, system: UCUM, code: input.unitCode },
  };
}

function latestBodyMeasurement(rows: Observation[], code: string): {
  observationReference: string;
  encounterReference: string | undefined;
  recordedAt: string;
  value: number | undefined;
  unit: string | undefined;
  code: string | undefined;
} | null {
  const row = rows
    .filter((candidate) => candidate.status !== "entered-in-error" && hasCode(candidate, LOINC, code))
    .sort((a, b) => (a.effectiveDateTime ?? "").localeCompare(b.effectiveDateTime ?? ""))
    .at(-1);
  if (!row) return null;
  return {
    observationReference: `Observation/${row.id}`,
    encounterReference: row.encounter?.reference,
    recordedAt: row.effectiveDateTime ?? "",
    value: row.valueQuantity?.value,
    unit: row.valueQuantity?.unit,
    code: row.valueQuantity?.code,
  };
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
  const provenance = observationProvenance(`Observation/${saved.id}`, patientReference, staffReference, recordedAt);
  const savedProvenance = await fhir.create(provenance, WRITE_HEADERS);
  return { status: 200, body: { observationReference: `Observation/${saved.id}`, provenanceReference: savedProvenance.id ? `Provenance/${savedProvenance.id}` : undefined } };
}

function observationProvenance(
  observationReference: string,
  patientReference: string,
  staffReference: string,
  recordedAt: string,
): Provenance {
  return {
    resourceType: "Provenance",
    target: patientScopedProvenanceTargets(observationReference, patientReference),
    recorded: recordedAt,
    agent: [{ who: { reference: staffReference } }],
    activity: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation", code: "CREATE" }] },
  };
}

function transactionCreatedReference(bundle: Bundle, index: number, resourceType: "Observation" | "Provenance"): string {
  if (bundle.resourceType !== "Bundle" || bundle.type !== "transaction-response") {
    throw new Error("Body measurements FHIR transaction did not return a transaction-response Bundle.");
  }
  const entry = bundle.entry?.[index];
  if (!entry?.response?.status?.startsWith("2")) {
    throw new Error(`Body measurements FHIR transaction entry ${index + 1} did not succeed.`);
  }
  if (entry.resource?.resourceType === resourceType && entry.resource.id) return `${resourceType}/${entry.resource.id}`;
  const location = entry.response.location;
  if (location?.startsWith(`${resourceType}/`)) {
    const id = location.slice(resourceType.length + 1).split("/")[0];
    if (id) return `${resourceType}/${id}`;
  }
  throw new Error(`Body measurements FHIR transaction entry ${index + 1} did not identify the created ${resourceType}.`);
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
