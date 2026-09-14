import type { Condition, Encounter } from "@medplum/fhirtypes";
import { z } from "zod";
import { staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { isConfirmedEncounterDiagnosis } from "../fhir/condition.js";
import { doctorNewness, readPriorDiagnoses, suggestDiagnosisNewness, type DiagnosisHistoryClient } from "./diagnosis-newness.js";
import type { DiagnosisNewnessRow, DiagnosisNewnessStore } from "./diagnosis-newness-types.js";
import type { DiagnosisVisitStatusStore } from "./diagnosis-visit-status-store.js";

export interface DiagnosisNewnessEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: DiagnosisHistoryClient;
  } | null>;
  store: DiagnosisNewnessStore & DiagnosisVisitStatusStore;
  now?: () => string;
}

const encounterParams = z.object({ encounterId: z.string().regex(/^[A-Za-z0-9.-]+$/) }).strict();
const updateParams = encounterParams.extend({ conditionId: z.string().regex(/^[A-Za-z0-9.-]+$/) }).strict();
const choiceSchema = z.object({ value: z.enum(["new", "established"]) }).strict();

export async function handleDiagnosisNewnessUpdateRequest(
  deps: DiagnosisNewnessEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const params = updateParams.safeParse(input.params);
  const body = choiceSchema.safeParse(input.body);
  if (!params.success || !body.success) return { status: 400, body: { error: "A valid encounter, diagnosis and New / Established choice are required." } };
  let encounter: Encounter;
  try {
    encounter = await staff.fhir.read<Encounter>("Encounter", params.data.encounterId);
  } catch {
    return { status: 404, body: { error: "Encounter not found." } };
  }
  if (encounter.status === "finished") return { status: 409, body: { error: "New / Established cannot change after the encounter is signed." } };
  const condition = await staff.fhir.read<Condition>("Condition", params.data.conditionId);
  const conditionReference = `Condition/${params.data.conditionId}`;
  if (!isConfirmedEncounterDiagnosis(condition) || condition.encounter?.reference !== `Encounter/${encounter.id}` ||
    condition.subject.reference !== encounter.subject?.reference ||
    !encounter.diagnosis?.some((diagnosis) => diagnosis.condition.reference === conditionReference)) {
    return { status: 409, body: { error: "The Condition must be a confirmed diagnosis on this patient's encounter." } };
  }
  const override = await deps.store.upsertNewnessOverride({
    encounterId: params.data.encounterId, conditionReference, value: body.data.value,
    setBy: staff.staffReference, at: deps.now?.() ?? new Date().toISOString(),
  });
  return { status: 200, body: { newness: { conditionReference, value: override.value, source: "doctor" } } };
}


export async function handleDiagnosisNewnessReadRequest(
  deps: DiagnosisNewnessEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const params = encounterParams.safeParse(input.params);
  if (!params.success) return { status: 400, body: { error: "A valid encounter id is required." } };
  let encounter: Encounter;
  try {
    encounter = await staff.fhir.read<Encounter>("Encounter", params.data.encounterId);
  } catch {
    return { status: 404, body: { error: "Encounter not found." } };
  }
  try {
    const [overrides, legacy] = await Promise.all([
      deps.store.listNewnessOverrides(params.data.encounterId),
      deps.store.listByEncounter(params.data.encounterId),
    ]);
    const rows: DiagnosisNewnessRow[] = [];
    const needsSuggestion: Condition[] = [];
    for (const diagnosis of encounter.diagnosis ?? []) {
      const reference = diagnosis.condition.reference;
      const match = reference?.match(/^Condition\/([A-Za-z0-9.-]+)$/);
      if (!match) continue;
      const condition = await staff.fhir.read<Condition>("Condition", match[1]!);
      if (condition.subject.reference !== encounter.subject?.reference || condition.encounter?.reference !== `Encounter/${encounter.id}`) {
        throw new Error("Diagnosis does not belong to this patient's encounter.");
      }
      if (!isConfirmedEncounterDiagnosis(condition)) continue;
      const choice = doctorNewness(reference!, overrides.find((row) => row.conditionReference === reference), legacy.find((row) => row.conditionReference === reference));
      if (choice) rows.push(choice);
      else needsSuggestion.push(condition);
    }
    if (needsSuggestion.length) {
      let history;
      try {
        history = await readPriorDiagnoses(staff.fhir, encounter, deps.store);
      } catch {
        history = undefined;
      }
      for (const condition of needsSuggestion) {
        try {
          if (!history) throw new Error("History unavailable");
          rows.push(suggestDiagnosisNewness(condition, history));
        } catch {
          rows.push({ conditionReference: `Condition/${condition.id}`, source: "unavailable" });
        }
      }
    }
    return { status: 200, body: { rows } };
  } catch {
    return { status: 503, body: { error: "New / Established could not be determined from complete patient history and saved choices. Retry or record a doctor's choice." } };
  }
}
