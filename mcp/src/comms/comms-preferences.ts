import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Bundle, Consent, Patient } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { COMMS_PURPOSES, COMMS_PREFERENCE_CHANNELS, effectiveCommsPreferences, readCommsPreferenceCells, replaceCommsPreferenceCells, type CommsPreferenceInput, type CommsPreferenceSurface } from "./suppression-gate.js";

export interface CommsPreferenceActor {
  actorReference: string;
  actorRole: PracticeRoleId;
  policyUrl?: string;
  recordedAt: string;
  surface: CommsPreferenceSurface;
}

export async function writeCommsPreferences(
  fhir: Pick<MedplumClient, "read" | "executeTransactionAsActor">,
  patientReference: string,
  cells: CommsPreferenceInput[],
  actor: CommsPreferenceActor,
  confirmation?: { confirmedVia?: ConsentCaptureMethod | null; formDate?: string },
): Promise<Patient> {
  const patient = await fhir.read<Patient>("Patient", patientReference.slice("Patient/".length));
  if (!patient.id || !patient.meta?.versionId) throw new Error("Preference write requires a Patient id and version.");
  const consent = confirmation?.confirmedVia ? buildCommsConsent(patientReference, cells, confirmation.confirmedVia, actor, confirmation.formDate) : undefined;
  const consentUrl = consent ? `urn:uuid:${randomUUID()}` : undefined;
  const updated = replaceCommsPreferenceCells(patient, cells.map(cell => consentUrl ? { ...cell, evidence: { reference: consentUrl } } : cell), {
    recordedAt: actor.recordedAt, setBy: { reference: actor.actorReference }, surface: actor.surface,
  });
  const transaction: Bundle = {
    resourceType: "Bundle", type: "transaction", entry: [
      { resource: updated, request: { method: "PUT", url: patientReference, ifMatch: `W/"${patient.meta.versionId}"` } },
      { resource: buildProvenance({
        targetReferences: [patientReference], recorded: actor.recordedAt,
        activityCode: "UPDATE", activityDisplay: "Set communication preferences",
        agents: [{ whoReference: actor.actorReference, typeCode: "author" }],
        entityValues: cells.map(cell => ({ role: "source", display: `${cell.purpose}/${cell.channel}: ${cell.allowed}` })),
      }), request: { method: "POST", url: "Provenance" } },
    ],
  };
  if (consent) transaction.entry!.push({ fullUrl: consentUrl, resource: consent, request: { method: "POST", url: "Consent" } });
  await fhir.executeTransactionAsActor(transaction, {
    actorReference: actor.actorReference, actorRole: actor.actorRole, policyUrl: actor.policyUrl,
    actionReason: "communications.preferences.manage set",
  }, { "X-ODOS-Source": "mcp/comms-preferences-write" }, {
    validateResponse: response => assertPreferenceTransaction(response, transaction.entry!.length),
  });
  return fhir.read<Patient>("Patient", patient.id);
}

export function assertPreferenceTransaction(response: Bundle, expectedEntries: number): void {
  if (response.type !== "transaction-response" || response.entry?.length !== expectedEntries) {
    throw new Error("Preference write returned an incomplete transaction response.");
  }
  const failed = response.entry.find(entry => !/^2\d\d/.test(entry.response?.status ?? ""));
  if (failed) throw Object.assign(new Error(`Preference write failed with status ${failed.response?.status ?? "unknown"}.`), {
    status: Number.parseInt(failed.response?.status ?? "", 10),
  });
}

export const COMMS_CONSENT_CATEGORY_SYSTEM = "https://odos2020.com/fhir/CodeSystem/consent-category";
export const COMMS_CONSENT_SCOPE_URL = "https://odos2020.com/fhir/StructureDefinition/odos-comms-consent-scope";
export const COMMS_CONSENT_CAPTURE_URL = "https://odos2020.com/fhir/StructureDefinition/odos-comms-consent-capture";
export type ConsentCaptureMethod = "in-person" | "paper-form";
const pairSchema = z.object({ purpose: z.enum(COMMS_PURPOSES), channel: z.enum(COMMS_PREFERENCE_CHANNELS) }).strict();
const cellSchema = pairSchema.extend({ allowed: z.boolean() }).strict();
const pairs = <T extends z.ZodTypeAny>(schema: T) => z.array(schema).min(1).max(20).superRefine((items, ctx) => {
  const keys = items.map(item => `${item.purpose}/${item.channel}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate purpose/channel pair." });
});
const patientReferenceSchema = z.string().regex(/^Patient\/[A-Za-z0-9.-]{1,64}$/);
export const communicationPreferencesInputSchema = z.object({
  cells: pairs(cellSchema),
  confirmedVia: z.enum(["in-person", "paper-form"]).nullable().optional(), formDate: z.string().optional(),
}).strict();
export const preferenceWriteSchema = communicationPreferencesInputSchema.extend({ patientReference: patientReferenceSchema });
export const consentEvidenceSchema = z.object({
  patientReference: patientReferenceSchema, scope: pairs(pairSchema),
  method: z.enum(["in-person", "paper-form"]), formDate: z.string().optional(),
}).strict();
function validateFormDate(method: ConsentCaptureMethod | null | undefined, date: string | undefined, now: string): void {
  if ((method === "paper-form") !== (date !== undefined)) throw new Error("formDate is required only for paper-form.");
  if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date || date > now.slice(0, 10))) throw new Error("Invalid or future formDate.");
}
export function parsePreferenceWriteInput(value: unknown, now = new Date().toISOString()) {
  const input = preferenceWriteSchema.parse(value);
  validateFormDate(input.confirmedVia, input.formDate, now);
  return input;
}
export function parseConsentEvidenceInput(value: unknown, now = new Date().toISOString()) {
  const input = consentEvidenceSchema.parse(value);
  validateFormDate(input.method, input.formDate, now);
  return input;
}
export function buildCommsConsent(patientReference: string, scope: Pick<CommsPreferenceInput, "purpose" | "channel">[], method: ConsentCaptureMethod,
  actor: CommsPreferenceActor, formDate?: string): Consent {
  if (!/^urn:uuid:[A-Za-z0-9-]+$/.test(patientReference)) patientReferenceSchema.parse(patientReference);
  parseConsentEvidenceInput({ patientReference: "Patient/validation", scope: scope.map(({ purpose, channel }) => ({ purpose, channel })), method, ...(formDate ? { formDate } : {}) }, actor.recordedAt);
  return {
    resourceType: "Consent", status: "active",
    scope: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/consentscope", code: "patient-privacy" }] },
    category: [{ coding: [{ system: COMMS_CONSENT_CATEGORY_SYSTEM, code: "comms-consent" }] }],
    patient: { reference: patientReference }, dateTime: formDate ?? actor.recordedAt, performer: [{ reference: patientReference }],
    policy: [{ uri: `https://odos2020.com/fhir/comms-consent-policy/${method}/2026-09-10` }], provision: { type: "permit" },
    extension: [
      ...scope.map(pair => ({ url: COMMS_CONSENT_SCOPE_URL, extension: [{ url: "purpose", valueCode: pair.purpose }, { url: "channel", valueCode: pair.channel }] })),
      { url: COMMS_CONSENT_CAPTURE_URL, extension: [{ url: "surface", valueCode: actor.surface }, { url: "method", valueCode: method }] },
    ],
  };
}
export async function attachCommsConsentEvidence(fhir: Pick<MedplumClient, "read" | "executeTransactionAsActor">,
  input: ReturnType<typeof parseConsentEvidenceInput>, actor: CommsPreferenceActor): Promise<Patient> {
  const patient = await fhir.read<Patient>("Patient", input.patientReference.slice(8));
  if (!patient.id || !patient.meta?.versionId) throw new Error("Preference write requires a Patient id and version.");
  const consent = buildCommsConsent(input.patientReference, input.scope, input.method, actor, input.formDate);
  const consentUrl = `urn:uuid:${randomUUID()}`;
  let updated = patient;
  for (const cell of readCommsPreferenceCells(patient)) {
    if (input.scope.some(pair => pair.purpose === cell.purpose && pair.channel === cell.channel)) {
      updated = replaceCommsPreferenceCells(updated, [{ ...cell, evidence: { reference: consentUrl } }], cell);
    }
  }
  const transaction: Bundle = { resourceType: "Bundle", type: "transaction", entry: [
    { resource: updated, request: { method: "PUT", url: input.patientReference, ifMatch: `W/"${patient.meta.versionId}"` } },
    { fullUrl: consentUrl, resource: consent, request: { method: "POST", url: "Consent" } },
    { resource: buildProvenance({ targetReferences: [input.patientReference, consentUrl], recorded: actor.recordedAt,
      activityCode: "UPDATE", activityDisplay: "Record communication consent evidence",
      agents: [{ whoReference: actor.actorReference, typeCode: "author" }],
      entityValues: input.scope.map(pair => ({ role: "source", display: `${pair.purpose}/${pair.channel}: evidence recorded` })),
    }), request: { method: "POST", url: "Provenance" } },
  ] };
  await fhir.executeTransactionAsActor(transaction, { actorReference: actor.actorReference, actorRole: actor.actorRole,
    policyUrl: actor.policyUrl, actionReason: "communications.preferences.manage evidence" },
  { "X-ODOS-Source": "mcp/comms-preferences-write" }, { validateResponse: response => assertPreferenceTransaction(response, transaction.entry!.length) });
  return fhir.read<Patient>("Patient", patient.id);
}

type ResolverOptions = Parameters<typeof effectiveCommsPreferences>[1];
export function commsPreferencesWithEvidence(patient: Patient, consents: Consent[], options: ResolverOptions = {}) {
  const matrix = effectiveCommsPreferences(patient, options);
  const explicit = readCommsPreferenceCells(patient);
  const rows = COMMS_PURPOSES.flatMap(purpose => COMMS_PREFERENCE_CHANNELS.map(channel => {
    const evidence = consents.filter(consent => consent.status === "active" && consent.patient?.reference === `Patient/${patient.id}`
      && consent.category.some(category => category.coding?.some(code => code.system === COMMS_CONSENT_CATEGORY_SYSTEM && code.code === "comms-consent"))
      && consent.extension?.some(extension => extension.url === COMMS_CONSENT_SCOPE_URL
        && extension.extension?.some(part => part.url === "purpose" && part.valueCode === purpose)
        && extension.extension?.some(part => part.url === "channel" && part.valueCode === channel)))
      .map(consent => ({ reference: consent.id ? `Consent/${consent.id}` : undefined, dateTime: consent.dateTime,
        capture: consent.extension?.find(extension => extension.url === COMMS_CONSENT_CAPTURE_URL) }));
    const stored = explicit.find(cell => cell.purpose === purpose && cell.channel === channel);
    return { purpose, channel, ...matrix[purpose][channel], evidenceSummary: evidence,
      lastSet: stored ? { recordedAt: stored.recordedAt, setBy: stored.setBy, surface: stored.surface } : null,
      evidenceStatus: channel === "call" || channel === "mail" ? "not-applicable" : matrix[purpose][channel].source === "suppression" ? "suppressed"
        : matrix[purpose][channel].value && !evidence.length ? "gap" : evidence.length ? "recorded" : "not-required" };
  }));
  return { patientReference: `Patient/${patient.id}`, matrix, rows };
}
async function searchCommsConsents(fhir: Pick<MedplumClient, "search">, ids: string[]): Promise<Consent[]> {
  const bundle = await fhir.search<Consent>("Consent", { patient: ids.map(id => `Patient/${id}`).join(","),
    category: `${COMMS_CONSENT_CATEGORY_SYSTEM}|comms-consent`, status: "active", _count: "10000" });
  const resources = (bundle.entry ?? []).flatMap(entry => entry.resource?.resourceType === "Consent" ? [entry.resource] : []);
  if (bundle.link?.some(link => link.relation === "next") || (bundle.total !== undefined && bundle.total > resources.length)) {
    throw new Error("Consent evidence search is incomplete; evidence gaps cannot be determined.");
  }
  return resources;
}
export async function readCommsPreferences(fhir: Pick<MedplumClient, "read" | "search">, patientReference: string, options: ResolverOptions = {}) {
  patientReferenceSchema.parse(patientReference);
  const patient = await fhir.read<Patient>("Patient", patientReference.slice(8));
  return commsPreferencesWithEvidence(patient, await searchCommsConsents(fhir, [patientReference.slice(8)]), options);
}
const gapFilterSchema = z.object({ tier: z.enum(["1", "2", "3"]).optional(), purpose: z.enum(COMMS_PURPOSES).optional(),
  channel: z.enum(["sms", "email"]).optional(), cursor: z.string().regex(/^offset:(0|[1-9]\d{0,8})$/).optional(),
  format: z.enum(["json", "csv"]).optional() }).strict();
export type EvidenceGapFilters = z.infer<typeof gapFilterSchema>;
export function parseEvidenceGapFilters(value: unknown): EvidenceGapFilters { return gapFilterSchema.parse(value); }
export async function reportCommsEvidenceGaps(fhir: Pick<MedplumClient, "search">, filters: EvidenceGapFilters = {}, options: ResolverOptions = {}) {
  gapFilterSchema.parse(filters);
  type Row = { patientReference: string; purpose: CommsPreferenceInput["purpose"]; channel: "sms" | "email"; tier: number; source: string };
  const rows: Row[] = [], suppressed: Row[] = [];
  const counts = { "1": 0, "2": 0, "3": 0 };
  let offset = Number(filters.cursor?.slice(7) ?? "0");
  let truncated = false;
  for (let page = 0; page < 100; page++) {
    const bundle = await fhir.search<Patient>("Patient", { active: "true", _count: "100", _offset: String(offset), _sort: "_id" });
    const patients = (bundle.entry ?? []).flatMap(entry => entry.resource?.resourceType === "Patient" && entry.resource.active === true && entry.resource.id ? [entry.resource] : []);
    if (!patients.length) break;
    const consents = await searchCommsConsents(fhir, patients.map(patient => patient.id!));
    let processed = 0;
    for (const patient of patients) {
      if (rows.length + suppressed.length > 9990) { truncated = true; break; }
      const view = commsPreferencesWithEvidence(patient, consents, options);
      for (const cell of view.rows) {
        if (cell.channel !== "sms" && cell.channel !== "email") continue;
        const tier = cell.channel === "email" ? 3 : cell.purpose === "marketing-promo" ? 1 : 2;
        if ((filters.tier && String(tier) !== filters.tier) || (filters.purpose && filters.purpose !== cell.purpose)
          || (filters.channel && filters.channel !== cell.channel)) continue;
        const row: Row = { patientReference: view.patientReference, purpose: cell.purpose, channel: cell.channel, tier, source: cell.source };
        if (cell.evidenceStatus === "gap") { rows.push(row); counts[String(tier) as keyof typeof counts]++; }
        else if (cell.evidenceStatus === "suppressed") suppressed.push(row);
      }
      processed++;
      if (rows.length + suppressed.length >= 10000) { truncated = true; break; }
    }
    offset += processed;
    if (truncated) break;
    const hasNext = bundle.link?.some(link => link.relation === "next") || (bundle.total !== undefined ? offset < bundle.total : patients.length === 100);
    if (!hasNext) break;
    if (page === 99) truncated = true;
  }
  return { rows, suppressed, counts, truncated, ...(truncated ? { cursor: `offset:${offset}` } : {}) };
}
export function evidenceGapCsv(report: Awaited<ReturnType<typeof reportCommsEvidenceGaps>>): string {
  const escape = (value: string | number | boolean) => `"${String(value).replace(/"/g, '""')}"`;
  return ["patientReference,purpose,channel,tier,status,truncated",
    ...report.rows.map(row => [row.patientReference, row.purpose, row.channel, row.tier, "gap", report.truncated].map(escape).join(",")),
    ...report.suppressed.map(row => [row.patientReference, row.purpose, row.channel, row.tier, "suppressed", report.truncated].map(escape).join(",")),
  ].join("\r\n");
}
