import { createHash } from "node:crypto";
import type { Bundle, Identifier, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import { z } from "zod";
import { collectAllFhirSearchPages, type FhirSearchClient } from "../fhir-search.js";
import { ODOS_EXTENSION_URLS } from "../fhir/ophthalmology/extensions.js";
import { customFieldEntries, type FindingQualifierValue } from "./custom-fields.js";
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

export async function findPendingAudits(fhir: FhirSearchClient, observations: readonly Observation[]): Promise<Set<string>> {
  const markers = observations.flatMap(observation => {
    const operation = parseFindingOperation(observation);
    if (!operation) return [];
    if (!observation.id) throw new Error("Finding operation has no Observation id.");
    return [{ reference: `Observation/${observation.id}`, key: findingAuditKey(operation.commandId,operation.target,operation.audit.kind,operation.digest) }];
  });
  if (!markers.length) return new Set();
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
  return new Set(markers.filter(m => !audits.some(a => matchesFindingAudit(a,m.key,m.reference))).map(m => m.reference));
}
export function matchesFindingAudit(audit: Provenance, key: string, reference: string): boolean {
  return !!audit.meta?.tag?.some(t => t.system === FINDING_OPERATION_AUDIT_SYSTEM && t.code === key) &&
    !!audit.target?.some(t => t.reference === reference);
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
    const row = resolveCatalogRow(catalog, `${envelope.key.stableKey}::${envelope.key.fieldCode}::${envelope.key.optionCode}`);
    const definition = definitions.find(d => d.stableKey === envelope.key.stableKey);
    if (!row || !definition) return { kind: "unresolved-legacy", reason: "Canonical key has no effective definition/catalog row." };
    return { kind: "canonical-fact", key: envelope.key, row, definition };
  }
  const definition = findingDefinitionForObservation(observation, definitions);
  if (markers[0] === "urn:odos:negative-act") return { kind: "negative-act", definition };
  if (markers[0] === FINDING_PANEL_SYSTEM) return { kind: "panel-context", definition };
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
  if (definition && customFieldEntries(definition, true).some(f => f.valueType === "multi-select")) return { kind: "legacy-section-snapshot", definition };
  if (definition) return { kind: "unrelated", definition };
  if (observation.code.coding?.some(c => c.code?.startsWith("ocular-health:") || c.code?.includes("::"))) return { kind: "unresolved-legacy", reason: "Unrecognized finding code or missing definition." };
  return { kind: "unrelated" };
}
