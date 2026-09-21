import { z } from "zod";
import type { Encounter } from "@medplum/fhirtypes";
import { staffHasBusinessAction } from "../authz/roles.js";
import type { ExamOverviewEndpointDeps } from "./exam-overview-endpoint.js";
import { examViewStateSchema, FhirEncounterExamViewStateStore } from "./exam-view-state-store.js";

export async function handleExamViewStateRequest(
  deps: Pick<ExamOverviewEndpointDeps, "authenticate" | "serviceFhir">,
  input: { authHeader: string | undefined; params: unknown; method: "GET" | "PUT"; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const params = z.object({ encounterId: z.string().regex(/^[A-Za-z0-9.-]+$/) }).safeParse(input.params);
  const state = input.method === "PUT" ? examViewStateSchema.safeParse(input.body) : undefined;
  if (!params.success || (state && !state.success)) return { status: 400, body: { error: "Invalid exam view-state request." } };
  try {
    const encounter = await staff.fhir.read<Encounter>("Encounter", params.data.encounterId);
    if (!encounter.subject?.reference?.match(/^Patient\/[^/]+$/)) return { status: 400, body: { error: "Encounter patient required." } };
    const store = new FhirEncounterExamViewStateStore(deps.serviceFhir ?? staff.fhir);
    const body = state?.success ? await store.set(params.data.encounterId, state.data) : await store.get(params.data.encounterId);
    return { status: 200, body };
  } catch (error) {
    const status = (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode;
    if (status === 401 || status === 403) return { status: 403, body: { error: "Encounter is outside the caller's patient compartment." } };
    if (status === 404 || status === 410) return { status: 404, body: { error: "Encounter was not found." } };
    return { status: 502, body: { error: "Exam view state could not be loaded or saved." } };
  }
}
