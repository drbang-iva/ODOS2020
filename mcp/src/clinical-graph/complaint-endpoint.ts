import { randomUUID } from "node:crypto";
import type { Basic, Bundle, Encounter } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { FhirComplaintDefinitionStore } from "./complaint-definition-store.js";
import {
  buildComplaintDefinitionSeeds,
  complaintReasonText,
  effectiveComplaintOptions,
  GENERIC_COMPLAINT_CONDITIONS,
  GENERIC_COMPLAINT_QUALITIES,
  GENERIC_COMPLAINT_TREATMENTS,
  renderComplaintNarrative,
  type ComplaintDefinition,
  type EncounterComplaint,
} from "./complaint-model.js";
import { FhirEncounterComplaintStore } from "./encounter-complaint-store.js";
import type { ClinicalGraphProvenance } from "./glaucoma-suspect.js";

const WRITE_HEADERS = { "X-ODOS-Source": "encounter-complaints" } as const;
const CONCURRENT_EDIT_MESSAGE =
  "This record was changed by someone else since you opened it. Reload and reapply your change.";

export interface ComplaintEndpointFhirClient {
  search<T extends Basic>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  searchUrl?<T extends Basic>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  read<T extends Encounter>(resourceType: T["resourceType"], id: string): Promise<T>;
  update<T extends Basic | Encounter>(resourceType: T["resourceType"], id: string, resource: T, extraHeaders?: Record<string, string>): Promise<T>;
}

export interface ComplaintEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: ComplaintEndpointFhirClient;
  } | null>;
  now?: () => string;
  id?: () => string;
}

const codeSchema = z.string().regex(/^[a-z][a-z0-9-]{0,99}$/);
const complaintFieldsSchema = z.object({
  complaintKey: codeSchema.optional(),
  freeTextLabel: z.string().trim().min(1).max(4000).optional(),
  conditions: z.array(codeSchema).max(64).default([]),
  eyeLocation: z.enum(["OD", "OS", "OU", "not-applicable"]),
  eyeComparison: z.enum(["left-worse", "equal", "right-worse", "other"]).optional(),
  eyeComparisonOtherText: z.string().trim().min(1).max(500).optional(),
  qualities: z.array(codeSchema).max(64).default([]),
  severity: z.enum(["mild", "moderate", "severe"]).optional(),
  duration: z.object({
    value: z.number().int().min(1).max(10000),
    unit: z.enum(["days", "weeks", "months", "years"]),
  }).strict().optional(),
  treatmentsTried: z.array(codeSchema).max(64).default([]),
  referringPhysicianRef: z.string().regex(/^Practitioner\/[A-Za-z0-9.-]+$/).optional(),
  referringPhysicianName: z.string().trim().min(1).max(500).optional(),
  additionalHistory: z.string().trim().max(4000).default(""),
  narrative: z.object({
    mode: z.enum(["automated", "override"]),
    overrideText: z.string().trim().min(1).max(8000).optional(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (!value.complaintKey && !value.freeTextLabel) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Other complaints require a free-text label." });
  }
  if (value.complaintKey && value.freeTextLabel) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Catalog complaints cannot also use a free-text label." });
  }
  if (value.eyeLocation !== "OU" && value.eyeComparison) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Eye comparison is only valid for both eyes." });
  }
  if (value.eyeComparison === "other" && !value.eyeComparisonOtherText) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Other eye comparison requires text." });
  }
  if (value.narrative.mode === "override" && !value.narrative.overrideText) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Narrative override requires text." });
  }
  for (const field of [value.conditions, value.qualities, value.treatmentsTried]) {
    if (new Set(field).size !== field.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Complaint option selections cannot contain duplicates." });
    }
  }
});

const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    patientReference: z.string().regex(/^Patient\/[A-Za-z0-9.-]+$/),
    complaint: complaintFieldsSchema,
  }).strict(),
  z.object({
    action: z.literal("update"),
    complaintId: z.string().regex(/^[A-Za-z0-9.-]+$/),
    complaint: complaintFieldsSchema,
  }).strict(),
  z.object({
    action: z.literal("reorder"),
    complaintIds: z.array(z.string().regex(/^[A-Za-z0-9.-]+$/)).min(1).max(64),
  }).strict(),
  z.object({
    action: z.literal("remove"),
    complaintId: z.string().regex(/^[A-Za-z0-9.-]+$/),
  }).strict(),
]);

const definitionMutationSchema = z.object({
  action: z.literal("add-option"),
  list: z.enum(["conditionOptions", "qualityOptions", "treatmentOptions"]),
  option: z.object({ code: codeSchema, display: z.string().trim().min(1).max(120) }).strict(),
}).strict();

export async function handleComplaintDefinitionCatalogRequest(
  deps: ComplaintEndpointDeps,
  input: { authHeader: string | undefined },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read complaint definitions." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const definitions = await new FhirComplaintDefinitionStore(staff.fhir).list();
  return {
    status: 200,
    body: {
      definitions: definitions.filter((definition) => definition.status === "active"),
      genericOptions: {
        conditions: GENERIC_COMPLAINT_CONDITIONS,
        qualities: GENERIC_COMPLAINT_QUALITIES,
        treatments: GENERIC_COMPLAINT_TREATMENTS,
      },
    },
  };
}

export async function handleComplaintDefinitionMutationRequest(
  deps: ComplaintEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to manage complaint definitions." } };
  if (!staffHasBusinessAction(staff, "finding-definitions.write")) {
    return { status: 403, body: { error: "finding-definitions.write role required" } };
  }
  const stableKey = readId(input.params, "stableKey");
  const parsed = definitionMutationSchema.safeParse(input.body);
  if (!stableKey || !parsed.success) {
    return { status: 400, body: { error: parsed.success ? "A valid complaint-definition stableKey is required." : parsed.error.issues[0]?.message } };
  }
  const provenance = provenanceFor(staff.staffReference, deps.now?.(), "Practice complaint-definition option added.");
  try {
    const definition = await new FhirComplaintDefinitionStore(staff.fhir).addOption({
      stableKey,
      list: parsed.data.list,
      option: { ...parsed.data.option, active: true },
      provenance,
    });
    return { status: 200, body: { definition } };
  } catch (error) {
    return { status: 400, body: { error: errorMessage(error) } };
  }
}

export async function handleEncounterComplaintListRequest(
  deps: ComplaintEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read encounter complaints." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const encounterId = readId(input.params, "encounterId");
  if (!encounterId) return { status: 400, body: { error: "A valid encounter id is required." } };
  const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  const patientId = patientIdFromEncounter(encounter);
  if (!patientId) return { status: 400, body: { error: "Encounter must reference a Patient subject." } };
  const definitions = await new FhirComplaintDefinitionStore(staff.fhir).list();
  const rows = await new FhirEncounterComplaintStore(staff.fhir).listByEncounter(encounterId);
  const complaints = rows.length ? rows : legacyComplaint(encounter, patientId, deps.now?.());
  return {
    status: 200,
    body: {
      complaints: complaints.map((complaint) => complaintView(complaint, definitions)),
      legacyFallback: rows.length === 0 && complaints.length > 0,
    },
  };
}

export async function handleEncounterComplaintMutationRequest(
  deps: ComplaintEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to manage encounter complaints." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const encounterId = readId(input.params, "encounterId");
  const parsed = mutationSchema.safeParse(input.body);
  if (!encounterId || !parsed.success) {
    return { status: 400, body: { error: parsed.success ? "A valid encounter id is required." : parsed.error.issues[0]?.message } };
  }
  const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  const patientId = patientIdFromEncounter(encounter);
  if (!patientId) return { status: 400, body: { error: "Encounter must reference a Patient subject." } };
  if (encounter.status === "finished" || encounter.status === "cancelled" || encounter.status === "entered-in-error") {
    return { status: 409, body: { error: "Signed or closed encounters cannot be reordered or edited." } };
  }
  const store = new FhirEncounterComplaintStore(staff.fhir);
  const definitionStore = new FhirComplaintDefinitionStore(staff.fhir);
  const definitions = await definitionStore.list();
  const existing = await store.listByEncounter(encounterId);
  const provenance = provenanceFor(staff.staffReference, deps.now?.(), `Encounter complaint ${parsed.data.action}.`);
  try {
    if (parsed.data.action === "create") {
      if (parsed.data.patientReference !== `Patient/${patientId}`) {
        return { status: 400, body: { error: "Complaint patient does not match the encounter subject." } };
      }
      validateComplaintFields(parsed.data.complaint, definitions);
      const complaint = complaintFromInput({
        id: deps.id?.() ?? `complaint-${randomUUID()}`,
        encounterId,
        patientId,
        ordinal: Math.max(0, ...existing.filter(active).map((row) => row.ordinal)) + 1,
        input: parsed.data.complaint,
        provenance,
      });
      await store.save(complaint);
    } else if (parsed.data.action === "update") {
      const complaintId = parsed.data.complaintId;
      const current = existing.find((row) => row.id === complaintId && row.status === "active");
      if (!current) return { status: 404, body: { error: "Active encounter complaint not found." } };
      validateComplaintFields(parsed.data.complaint, definitions);
      await store.save(complaintFromInput({
        id: current.id,
        encounterId,
        patientId,
        ordinal: current.ordinal,
        input: parsed.data.complaint,
        provenance,
        current,
      }));
    } else if (parsed.data.action === "remove") {
      const complaintId = parsed.data.complaintId;
      const current = existing.find((row) => row.id === complaintId && row.status === "active");
      if (!current) return { status: 404, body: { error: "Active encounter complaint not found." } };
      await store.save({
        ...current,
        status: "removed",
        provenance,
        provenanceHistory: [...current.provenanceHistory, provenance],
      });
    } else {
      const activeRows = existing.filter(active);
      if (new Set(parsed.data.complaintIds).size !== parsed.data.complaintIds.length ||
        parsed.data.complaintIds.length !== activeRows.length ||
        parsed.data.complaintIds.some((id) => !activeRows.some((row) => row.id === id))) {
        return { status: 400, body: { error: "Reorder must include every active complaint exactly once." } };
      }
      for (const [index, id] of parsed.data.complaintIds.entries()) {
        const complaint = activeRows.find((row) => row.id === id)!;
        await store.save({
          ...complaint,
          ordinal: index + 1,
          provenance,
          provenanceHistory: [...complaint.provenanceHistory, provenance],
        });
      }
    }
    const finalRows = await normalizeOrdinals(store, encounterId, provenance);
    await staff.fhir.update("Encounter", encounterId, stampPrimaryComplaint(encounter, finalRows, definitions), {
      ...WRITE_HEADERS,
      ...(encounter.meta?.versionId ? { "If-Match": `W/"${encounter.meta.versionId}"` } : {}),
    });
    return { status: 200, body: { complaints: finalRows.map((row) => complaintView(row, definitions)) } };
  } catch (error) {
    if (isConcurrentEdit(error)) {
      return {
        status: 409,
        body: { error: CONCURRENT_EDIT_MESSAGE, code: "concurrent-edit" },
      };
    }
    return { status: 400, body: { error: errorMessage(error) } };
  }
}

export function stampPrimaryComplaint(
  encounter: Encounter,
  complaints: EncounterComplaint[],
  definitions: ComplaintDefinition[],
): Encounter {
  const primary = complaints.filter(active).sort((left, right) => left.ordinal - right.ordinal)[0];
  const text = primary
    ? complaintReasonText(primary, definitions.find((definition) => definition.stableKey === primary.complaintKey))
    : undefined;
  let handled = false;
  const reasonCode = (encounter.reasonCode ?? []).flatMap((reason) => {
    if (!handled && !reason.coding?.length) {
      handled = true;
      return text ? [{ text }] : [];
    }
    return [reason];
  });
  if (text && !handled) reasonCode.push({ text });
  return { ...encounter, reasonCode };
}

function complaintFromInput(input: {
  id: string;
  encounterId: string;
  patientId: string;
  ordinal: number;
  input: z.infer<typeof complaintFieldsSchema>;
  provenance: ClinicalGraphProvenance;
  current?: EncounterComplaint;
}): EncounterComplaint {
  const overrideProvenance = input.input.narrative.mode === "override"
    ? provenanceFor(input.provenance.actorReference ?? "Practitioner/unknown", input.provenance.recordedAt, "clinician-edited")
    : undefined;
  return {
    id: input.id,
    encounterId: input.encounterId,
    patientId: input.patientId,
    ordinal: input.ordinal,
    ...(input.input.complaintKey ? { complaintKey: input.input.complaintKey } : {}),
    ...(input.input.freeTextLabel ? { freeTextLabel: input.input.freeTextLabel } : {}),
    conditions: input.input.conditions,
    eyeLocation: input.input.eyeLocation,
    ...(input.input.eyeComparison ? { eyeComparison: input.input.eyeComparison } : {}),
    ...(input.input.eyeComparisonOtherText ? { eyeComparisonOtherText: input.input.eyeComparisonOtherText } : {}),
    qualities: input.input.qualities,
    ...(input.input.severity ? { severity: input.input.severity } : {}),
    ...(input.input.duration ? { duration: input.input.duration } : {}),
    treatmentsTried: input.input.treatmentsTried,
    ...(input.input.referringPhysicianRef ? { referringPhysicianRef: input.input.referringPhysicianRef } : {}),
    ...(input.input.referringPhysicianName ? { referringPhysicianName: input.input.referringPhysicianName } : {}),
    additionalHistory: input.input.additionalHistory,
    narrative: {
      mode: input.input.narrative.mode,
      ...(input.input.narrative.overrideText ? { overrideText: input.input.narrative.overrideText } : {}),
      ...(overrideProvenance ? { overrideProvenance } : {}),
    },
    resolvedDx: input.current?.resolvedDx ?? [],
    status: "active",
    provenance: input.provenance,
    provenanceHistory: [...(input.current?.provenanceHistory ?? []), input.provenance],
  };
}

function validateComplaintFields(
  complaint: z.infer<typeof complaintFieldsSchema>,
  definitions: ComplaintDefinition[],
): void {
  const definition = complaint.complaintKey
    ? definitions.find((candidate) => candidate.stableKey === complaint.complaintKey && candidate.status === "active")
    : undefined;
  if (complaint.complaintKey && !definition) throw new Error(`Complaint definition ${complaint.complaintKey} is unknown or inactive.`);
  if (definition?.kind === "evaluation-reason" && (complaint.conditions.length || complaint.qualities.length)) {
    throw new Error("Evaluation-reason complaints cannot carry symptom or character selections.");
  }
  const effective = effectiveComplaintOptions(definition);
  assertSelectedOptions(complaint.conditions, effective.conditions, "condition");
  assertSelectedOptions(complaint.qualities, effective.qualities, "quality");
  assertSelectedOptions(complaint.treatmentsTried, effective.treatments, "treatment");
}

function assertSelectedOptions(codes: string[], options: Array<{ code: string; active: boolean }>, label: string): void {
  const activeCodes = new Set(options.filter((option) => option.active).map((option) => option.code));
  const unknown = codes.find((code) => !activeCodes.has(code));
  if (unknown) throw new Error(`Complaint ${label} option is unknown or inactive: ${unknown}.`);
}

async function normalizeOrdinals(
  store: FhirEncounterComplaintStore,
  encounterId: string,
  provenance: ClinicalGraphProvenance,
): Promise<EncounterComplaint[]> {
  const rows = await store.listByEncounter(encounterId);
  const activeRows = rows.filter(active).sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  for (const [index, row] of activeRows.entries()) {
    if (row.ordinal === index + 1) continue;
    await store.save({ ...row, ordinal: index + 1, provenance, provenanceHistory: [...row.provenanceHistory, provenance] });
  }
  return (await store.listByEncounter(encounterId)).filter(active);
}

function legacyComplaint(encounter: Encounter, patientId: string, at: string | undefined): EncounterComplaint[] {
  const text = encounter.reasonCode?.find((reason) => !reason.coding?.length && reason.text?.trim())?.text?.trim();
  if (!text || !encounter.id) return [];
  const provenance = provenanceFor("Practitioner/legacy-import", at ?? encounter.meta?.lastUpdated ?? new Date(0).toISOString(), "Legacy chief-complaint read fallback; no migration rewrite.");
  return [{
    id: `legacy-${encounter.id}`,
    encounterId: encounter.id,
    patientId,
    ordinal: 1,
    freeTextLabel: text,
    conditions: [],
    eyeLocation: "not-applicable",
    qualities: [],
    treatmentsTried: [],
    additionalHistory: "",
    narrative: { mode: "automated" },
    resolvedDx: [],
    status: "active",
    provenance,
    provenanceHistory: [provenance],
  }];
}

function complaintView(complaint: EncounterComplaint, definitions: ComplaintDefinition[]) {
  const definition = definitions.find((candidate) => candidate.stableKey === complaint.complaintKey);
  return { ...complaint, renderedNarrative: renderComplaintNarrative(complaint, definition) };
}

function provenanceFor(actorReference: string, recordedAt: string | undefined, note: string): ClinicalGraphProvenance {
  return { source: "manual", recordedAt: recordedAt ?? new Date().toISOString(), actorReference, note };
}

function patientIdFromEncounter(encounter: Encounter): string | undefined {
  return encounter.subject?.reference?.match(/^Patient\/([A-Za-z0-9.-]+)$/)?.[1];
}

function readId(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as Record<string, unknown>)[field];
  return typeof id === "string" && /^[A-Za-z0-9.-]+$/.test(id) ? id : undefined;
}

function active(complaint: EncounterComplaint): boolean {
  return complaint.status === "active";
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write" | "finding-definitions.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConcurrentEdit(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = Number(error.status);
  return status === 409 || status === 412;
}
