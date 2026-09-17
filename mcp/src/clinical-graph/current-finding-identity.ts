import { createHash } from "node:crypto";
import type { Bundle, Identifier, Observation, ObservationComponent, Provenance, Resource } from "@medplum/fhirtypes";
import { z } from "zod";
import { collectAllFhirSearchPages, type FhirSearchClient } from "../fhir-search.js";
import { V3_DATA_OPERATION_CODE_SYSTEM } from "../fhir/ophthalmology/provenance.js";
import { ODOS_EXTENSION_URLS, odosConcept } from "../fhir/ophthalmology/extensions.js";
import { customFieldEntries, type CustomFieldEntry, type FindingQualifierValue } from "./custom-fields.js";
import type { AtomicFindingCatalogRow, FindingLaterality } from "./diagnosis-findings-endpoint.js";
import { findingDefinitionForObservation } from "./finding-observation-match.js";
import { translateRetiredFindingQualifierForRead } from "./finding-read-compatibility.js";
import type { FindingReadAlias } from "./finding-read-aliases.js";
import { observationFindingDetails, componentString } from "./finding-section-helpers.js";
import type { ClinicalFindingDefinition } from "./glaucoma-suspect.js";

export const CURRENT_FINDING_SYSTEM = "urn:odos:current-finding:v1";
export const FINDING_PANEL_SYSTEM = "urn:odos:finding-panel:v1";
export const SUPPORTS_DIAGNOSIS_URL = "https://odos2020.com/fhir/StructureDefinition/supports-diagnosis";
export const FINDING_OPERATION_AUDIT_SYSTEM = "urn:odos:finding-operation:v1";
const operationSchema = z.object({ commandId: z.string().min(1), target: z.string().min(1), digest: z.string().min(1),
  audit: z.object({ kind: z.literal("mutation"), actor: z.string().min(1), recorded: z.string().min(1),
    activity: z.enum(["CREATE", "UPDATE"]), targetReferences: z.array(z.string().min(1)).min(1) }).strict() }).strict();
export type FindingOperation = z.infer<typeof operationSchema>;

export function parseFindingOperation(observation: Observation): FindingOperation | undefined {
  const components = observation.component?.filter(c => c.code.coding?.some(v => v.code === "R10_OPERATION")) ?? [];
  if (!components.length) return undefined;
  if (components.length !== 1 || !components[0].valueString) throw new Error("Invalid finding operation marker.");
  try {
    const parsed = operationSchema.safeParse(JSON.parse(components[0].valueString));
    if (parsed.success) return parsed.data;
  } catch { /* fail closed below */ }
  throw new Error("Invalid finding operation marker.");
}

export function findingAuditKey(commandId: string, target: string, kind: "mutation" | "reassertion", digest: string): string {
  return createHash("sha256").update(`${commandId}|${target}|${kind}|${digest}`).digest("hex");
}

export type PendingFindingAudits = Set<string> & { mismatches: Set<string> };
export async function findPendingAudits(fhir: FhirSearchClient, observations: readonly Observation[]): Promise<PendingFindingAudits> {
  const markers = observations.flatMap(observation => {
    const operation = parseFindingOperation(observation);
    if (!operation) return [];
    if (!observation.id) throw new Error("Finding operation has no Observation id.");
    return [{ operation, reference: `Observation/${observation.id}`, key: findingAuditKey(operation.commandId,operation.target,operation.audit.kind,operation.digest) }];
  });
  if (!markers.length) return Object.assign(new Set<string>(), { mismatches: new Set<string>() });
  const keys = [...new Set(markers.map(m => m.key))];
  const validate = <T extends Resource>(bundle: Bundle<T>): Bundle<T> => {
    if (bundle.resourceType !== "Bundle" || bundle.type !== "searchset" || bundle.link?.some(l => l.relation === "next" && !l.url) ||
      bundle.entry?.some(e => !e.resource || e.resource.resourceType !== "Provenance" || !e.resource.id)) throw new Error("Malformed finding audit search page.");
    return bundle;
  };
  const client: FhirSearchClient = { baseUrl: fhir.baseUrl, search: fhir.search.bind(fhir),
    ...(fhir.searchUrl ? { searchUrl: async <T extends Resource>(url: string, type: T["resourceType"]) => validate(await fhir.searchUrl!<T>(url,type)) } : {}) };
  const page = validate(await fhir.search<Provenance>("Provenance",{ _tag: keys.map(k => `${FINDING_OPERATION_AUDIT_SYSTEM}|${k}`).join(","), _count:"200" }));
  const audits = await collectAllFhirSearchPages<Provenance>(client,"Provenance",page,client.baseUrl);
  const pending = Object.assign(new Set<string>(), { mismatches: new Set<string>() });
  for (const marker of markers) {
    const tagged = audits.filter(a => a.meta?.tag?.some(t => t.system === FINDING_OPERATION_AUDIT_SYSTEM && t.code === marker.key));
    const mismatch = tagged.some(a => !matchesFindingAudit(a, marker.key, marker.reference, marker.operation));
    if (!tagged.length || mismatch) pending.add(marker.reference);
    if (mismatch) pending.mismatches.add(marker.reference);
  }
  return pending;
}
export function matchesFindingAudit(audit: Provenance, key: string, reference: string, operation: FindingOperation): boolean {
  return matchesFindingAuditContent(audit, key, operation.audit.actor, V3_DATA_OPERATION_CODE_SYSTEM,
    operation.audit.activity, operation.audit.targetReferences.map(r => r === "self" ? reference : r), operation.audit.recorded);
}
export function matchesFindingAuditContent(audit: Provenance, key: string, actor: string, activitySystem: string,
  activityCode: string, targets: readonly string[], recorded?: string): boolean {
  const actual = new Set(audit.target?.map(t => t.reference));
  const expected = new Set(targets);
  return !!audit.meta?.tag?.some(t => t.system === FINDING_OPERATION_AUDIT_SYSTEM && t.code === key) &&
    audit.agent?.length === 1 && audit.agent[0].who.reference === actor &&
    !!audit.activity?.coding?.some(c => c.system === activitySystem && c.code === activityCode) &&
    (recorded === undefined || (Number.isFinite(Date.parse(recorded)) && Date.parse(audit.recorded) === Date.parse(recorded))) &&
    actual.size === expected.size && [...expected].every(t => actual.has(t));
}
export function ownsFact(definition: ClinicalFindingDefinition, field: Pick<CustomFieldEntry, "valueType">): boolean {
  return definition.valueSchema.type === "ocular-health-structure" && field.valueType === "multi-select";
}
export const currentFindingPanelKeySchema = z.object({ v: z.literal(1), patientId: z.string().min(1), encounterId: z.string().min(1),
  stableKey: z.string().min(1), eye: z.enum(["OD", "OS"]) }).strict();
export type FindingPanelKey = z.infer<typeof currentFindingPanelKeySchema>;
export interface FindingPanelState { deferred: boolean; other?: string; remarks?: string; values: Record<string, number | string> }
export function findingPanelIdentifier(key: FindingPanelKey): Identifier {
  return { system: FINDING_PANEL_SYSTEM, value: createHash("sha256").update(JSON.stringify([1,key.patientId,key.encounterId,key.stableKey,key.eye])).digest("hex") };
}
export function findingPanelTargetId(key: FindingPanelKey): string { return `panel:${findingPanelIdentifier(key).value}`; }
export function parseFindingPanelEnvelope(observation: Observation): { status: "valid"; key: FindingPanelKey } | { status: "invalid"; reason: string } {
  const invalid = (reason: string) => ({ status: "invalid" as const, reason });
  const ids = observation.identifier?.filter(i => i.system === FINDING_PANEL_SYSTEM) ?? [];
  const metas = observation.component?.filter(c => c.code.coding?.some(v => v.code === "R10_PANEL_META")) ?? [];
  if (ids.length !== 1 || metas.length !== 1) return invalid("Expected one panel identifier and envelope.");
  let value: unknown;
  try { value = JSON.parse(metas[0].valueString ?? ""); } catch { return invalid("Invalid panel JSON."); }
  const parsed = currentFindingPanelKeySchema.safeParse(value);
  if (!parsed.success) return invalid("Invalid panel tuple.");
  const key = parsed.data;
  if (ids[0].value !== findingPanelIdentifier(key).value || observation.subject?.reference !== `Patient/${key.patientId}` ||
    observation.encounter?.reference !== `Encounter/${key.encounterId}` || observationLaterality(observation) !== key.eye ||
    !observation.code.coding?.some(c => c.code === key.stableKey) ||
    observation.identifier?.some(i => [CURRENT_FINDING_SYSTEM,"urn:odos:negative-act"].includes(i.system ?? "")) ||
    observation.component?.some(c => c.code.coding?.some(v => ["R10_CURRENT_META","NEGATIVE_ACT"].includes(v.code ?? ""))) ||
    !["preliminary","entered-in-error","final","amended","corrected"].includes(observation.status)) return invalid("Panel identity or role mismatch.");
  return { status: "valid", key };
}
export function normalizeFindingPanelState(value: unknown, definition: ClinicalFindingDefinition, forWrite = true): FindingPanelState {
  const fail = (): never => { throw Object.assign(new Error("Invalid panel state."), { status: 400 }); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const state = value as FindingPanelState;
  if (Object.keys(state).some(k => !["deferred","other","remarks","values"].includes(k)) || typeof state.deferred !== "boolean" ||
    !definition || !state.values || typeof state.values !== "object" || Array.isArray(state.values) || definition.valueSchema.type !== "ocular-health-structure" ||
    (forWrite && !definition.active)) return fail();
  const result: FindingPanelState = { deferred: state.deferred, values: {} };
  for (const name of ["other","remarks"] as const) if (state[name] !== undefined) {
    if (typeof state[name] !== "string" || !state[name]!.trim()) return fail(); result[name] = state[name]!.trim();
  }
  const fields = customFieldEntries(definition, !forWrite);
  for (const [code,v] of Object.entries(state.values)) {
    const field = fields.find(f => f.localCode === code);
    if (!field || ownsFact(definition,field)) return fail();
    if (field.valueType === "number") {
      if (typeof v !== "number" || !Number.isFinite(v) || (field.min !== undefined && v < field.min) || (field.max !== undefined && v > field.max) ||
        (field.step !== undefined && Math.abs((v-(field.min ?? 0))/field.step - Math.round((v-(field.min ?? 0))/field.step)) > 1e-8)) return fail();
      result.values[code] = v;
    } else {
      if (typeof v !== "string" || !v.trim()) return fail();
      if (field.valueType === "select" && !field.options?.some(o => o.code === v.trim() && (!forWrite || o.active))) return fail();
      result.values[code] = v.trim();
    }
  }
  return result;
}
export function findingPanelComponents(state: FindingPanelState, definition: ClinicalFindingDefinition): ObservationComponent[] {
  const normalized = normalizeFindingPanelState(state, definition, false);
  return [...(normalized.deferred ? [{code:odosConcept("EXAM_STATE"),valueString:"deferred"}] : []),
    ...(["other","remarks"] as const).flatMap(k => normalized[k] ? [{code:odosConcept(k.toUpperCase()),valueString:normalized[k]}] : []),
    ...Object.entries(normalized.values).sort(([a],[b]) => a.localeCompare(b)).map(([code,value]) => ({code:odosConcept(code),
      ...(typeof value === "number" ? {valueQuantity:{value}} : {valueString:value})}))];
}
export function readFindingPanelState(observation: Observation, definition: ClinicalFindingDefinition): FindingPanelState {
  const result: FindingPanelState = { deferred:false, values:{} }; const seen = new Set<string>();
  if (Object.keys(observation).some(k => k.startsWith("value") && (observation as unknown as Record<string,unknown>)[k] !== undefined) || observation.interpretation?.length)
    throw new Error("Panel cannot carry a finding value.");
  for (const c of observation.component ?? []) {
    const codes = c.code.coding?.map(v=>v.code).filter(Boolean) ?? [];
    if (codes.length !== 1 || seen.has(codes[0]!)) throw new Error("Ambiguous panel component.");
    const code = codes[0]!; seen.add(code);
    if (["R10_PANEL_META","R10_OPERATION"].includes(code)) continue;
    const types = Object.keys(c).filter(k=>k.startsWith("value") && (c as unknown as Record<string,unknown>)[k] !== undefined);
    if (types.length !== 1) throw new Error("Ambiguous panel value.");
    if (code === "EXAM_STATE") { if(c.valueString !== "deferred") throw new Error("Invalid panel state."); result.deferred=true; }
    else if (code === "OTHER" || code === "REMARKS") { if(typeof c.valueString !== "string") throw new Error("Invalid panel text."); result[code === "OTHER" ? "other" : "remarks"] = c.valueString; }
    else { const field=customFieldEntries(definition,true).find(f=>f.localCode===code);
      if (!field || (field.valueType === "number" ? types[0] !== "valueQuantity" : types[0] !== "valueString")) throw new Error("Invalid panel component type.");
      result.values[code] = (c.valueQuantity?.value ?? c.valueString)!;
    }
  }
  parseFindingOperation(observation);
  return normalizeFindingPanelState(result,definition,false);
}
export const currentFindingKeySchema = z.object({ v: z.literal(1), patientId: z.string().min(1), encounterId: z.string().min(1), stableKey: z.string().min(1),
  fieldCode: z.string().min(1), optionCode: z.string().min(1), eye: z.enum(["OD", "OS"]) }).strict();
export type CurrentFindingKey = z.infer<typeof currentFindingKeySchema>;
export type FindingEye = CurrentFindingKey["eye"];

export function currentFindingIdentifier(key: CurrentFindingKey): Identifier {
  return { system: CURRENT_FINDING_SYSTEM, value: createHash("sha256").update(JSON.stringify([
    key.v, key.patientId, key.encounterId, key.stableKey, key.fieldCode, key.optionCode, key.eye,
  ])).digest("hex") };
}
export function parseCurrentFindingEnvelope(observation: Observation):
  { status: "valid"; key: CurrentFindingKey } | { status: "invalid"; reason: string } {
  const invalid = (reason: string) => ({ status: "invalid" as const, reason });
  const identifiers = observation.identifier?.filter(i => i.system === CURRENT_FINDING_SYSTEM) ?? [];
  const components = observation.component?.filter(c => c.code.coding?.some(v => v.code === "R10_CURRENT_META")) ?? [];
  if (identifiers.length !== 1 || components.length !== 1) return invalid("Expected one canonical identifier and one identity envelope.");
  let parsed: unknown;
  try { parsed = JSON.parse(components[0].valueString ?? ""); } catch { return invalid("Malformed identity JSON."); }
  const result = currentFindingKeySchema.safeParse(parsed);
  if (!result.success) return invalid("Invalid identity tuple.");
  const key = result.data;
  if (identifiers[0].value !== currentFindingIdentifier(key).value) return invalid("Identity hash mismatch.");
  if (observation.subject?.reference !== `Patient/${key.patientId}`) return invalid("Identity patient mismatch.");
  if (observation.encounter?.reference !== `Encounter/${key.encounterId}`) return invalid("Identity encounter mismatch.");
  if (!observation.code.coding?.some(c => c.code === `${key.stableKey}::${key.fieldCode}::${key.optionCode}`)) return invalid("Identity code mismatch.");
  if (observationLaterality(observation) !== key.eye) return invalid("Identity eye mismatch.");
  return { status: "valid", key };
}
export function resolveCatalogRow(catalog: readonly AtomicFindingCatalogRow[], atomicFindingId: string): AtomicFindingCatalogRow | undefined {
  return catalog.find(row => row.atomicFindingId === atomicFindingId);
}
export function eyeSet(laterality: string): FindingEye[] {
  return laterality === "OD" ? ["OD"] : laterality === "OS" ? ["OS"] : laterality === "OU" ? ["OD", "OS"] : [];
}
export function observationLaterality(observation: Observation): FindingLaterality {
  const code = observation.extension?.find(e => e.url === ODOS_EXTENSION_URLS.eyeLaterality)?.valueCodeableConcept?.coding?.find(c => c.code)?.code ?? observation.bodySite?.coding?.find(c => c.code)?.code;
  return code === "OD" || code === "right" ? "OD" : code === "OS" || code === "left" ? "OS" : code === "OU" || code === "bilateral" ? "OU" : "UNKNOWN";
}
export function findingQualifiers(observation: Observation, definition: ClinicalFindingDefinition, row: AtomicFindingCatalogRow, prefix: string): Record<string, FindingQualifierValue> {
  const fields = Object.fromEntries(customFieldEntries(definition, true).filter(field => field.localCode === row.fieldCode).map(field => [field.localCode, field]));
  const addressedDefinition = { ...definition, valueSchema: { ...definition.valueSchema, fields } };
  const details = { ...(observationFindingDetails(observation, addressedDefinition, prefix)?.[row.optionCode] ?? {}) };
  const grade = observation.component?.find(c => c.code.coding?.some(v => v.code === "GRADE"));
  const persisted = grade?.valueString ?? grade?.valueCodeableConcept?.coding?.find(c => c.code)?.code;
  if (details.grade === undefined && persisted !== undefined) {
    const translated = translateRetiredFindingQualifierForRead(definition.stableKey, row.optionCode, "grade", persisted);
    if (translated !== undefined) details.grade = translated;
  }
  return details;
}
export interface FindingClassification {
  kind: "canonical-fact" | "legacy-atomic" | "legacy-section-snapshot" | "negative-act" | "panel-context" | "unresolved-legacy" | "unrelated" | "invalid";
  key?: CurrentFindingKey;
  panelKey?: FindingPanelKey;
  row?: AtomicFindingCatalogRow;
  definition?: ClinicalFindingDefinition;
  qualifiers?: Record<string, FindingQualifierValue>;
  translated?: boolean;
  reason?: string;
}
export function classifyFindingObservation(observation: Observation, definitions: readonly ClinicalFindingDefinition[], catalog: readonly AtomicFindingCatalogRow[], aliases: ReadonlyMap<string, FindingReadAlias>): FindingClassification {
  const markers = [CURRENT_FINDING_SYSTEM, "urn:odos:negative-act", FINDING_PANEL_SYSTEM].filter(system => observation.identifier?.some(i => i.system === system));
  if (markers.length > 1) return { kind: "invalid", reason: "Conflicting identity markers." };
  if (markers[0] === CURRENT_FINDING_SYSTEM) {
    const envelope = parseCurrentFindingEnvelope(observation);
    if (envelope.status === "invalid") return { kind: "invalid", reason: envelope.reason };
    let row = resolveCatalogRow(catalog, `${envelope.key.stableKey}::${envelope.key.fieldCode}::${envelope.key.optionCode}`);
    const definition = definitions.find(d => d.stableKey === envelope.key.stableKey);
    const field = definition && customFieldEntries(definition,true).find(f=>f.localCode===envelope.key.fieldCode);
    if (definition && (!field || !ownsFact(definition,field))) return {kind:"invalid",reason:"not-a-shared-finding"};
    const option = field?.options?.find(o=>o.code===envelope.key.optionCode);
    if (!row && definition && field && option) row = {atomicFindingId:`${definition.stableKey}::${field.localCode}::${option.code}`,findingDefinitionId:definition.id,
      findingDefinitionKey:definition.stableKey,fieldCode:field.localCode,optionCode:option.code,display:option.display,sectionKey:definition.sectionKey ?? definition.stableKey,
      gradeScale:option.qualifiers?.flatMap(q=>q.kind==="graded"?q.options:[]) ?? [],diagnosisKeys:[],origin:definition.sourceStatus==="local-practice"?"custom":"shipped"};
    if (!row || !definition) return { kind: "unresolved-legacy", reason: "Canonical key has no effective definition/catalog row." };
    return { kind: "canonical-fact", key: envelope.key, row, definition };
  }
  const definition = findingDefinitionForObservation(observation, definitions);
  if (markers[0] === "urn:odos:negative-act") return { kind: "negative-act", definition };
  if (markers[0] === FINDING_PANEL_SYSTEM) {
    const envelope = parseFindingPanelEnvelope(observation);
    if (envelope.status === "invalid") return {kind:"invalid",reason:envelope.reason};
    const panelDefinition = definitions.find(d=>d.stableKey===envelope.key.stableKey);
    if (!panelDefinition || panelDefinition.valueSchema.type !== "ocular-health-structure") return {kind:"invalid",reason:"Panel definition is not shared."};
    try { readFindingPanelState(observation,panelDefinition); } catch { return {kind:"invalid",reason:"Invalid panel state."}; }
    return {kind:"panel-context",definition:panelDefinition,panelKey:envelope.key};
  }
  if (componentString(observation, "R10_CURRENT_META") || componentString(observation, "R10_PANEL_META") || componentString(observation, "NEGATIVE_ACT")) return { kind: "invalid", reason: "Role envelope is missing its identity marker." };
  for (const coding of observation.code.coding ?? []) {
    const row = resolveCatalogRow(catalog, coding.code ?? "");
    const alias = aliases.get(coding.code ?? "");
    if (row || alias) {
      if (!row && (!alias?.row || observation.valueBoolean === false)) return { kind: "unresolved-legacy", reason: alias?.reason ?? "A false retired subtype cannot imply absence of its replacement." };
      const resolved = row ?? alias!.row!;
      const matchedDefinition = definitions.find(d => d.stableKey === resolved.findingDefinitionKey);
      if (!matchedDefinition) return { kind: "unresolved-legacy", reason: "Missing atomic definition." };
      return { kind: "legacy-atomic", row: resolved, definition: matchedDefinition, ...(row ? {} : { qualifiers: alias!.qualifiers, translated: true }) };
    }
  }
  if (definition && definition.valueSchema.type === "ocular-health-structure") return { kind: "legacy-section-snapshot", definition };
  if (definition) return { kind: "unrelated", definition };
  if (observation.code.coding?.some(c => c.code?.startsWith("ocular-health:") || c.code?.includes("::"))) return { kind: "unresolved-legacy", reason: "Unrecognized finding code or missing definition." };
  return { kind: "unrelated" };
}
