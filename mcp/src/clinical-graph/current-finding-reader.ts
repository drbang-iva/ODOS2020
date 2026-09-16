import type { Bundle, Condition, Observation, ObservationComponent, Resource } from "@medplum/fhirtypes";
import { collectAllFhirSearchPages, type FhirSearchClient } from "../fhir-search.js";
import { hasConditionCategory, FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM } from "../fhir/condition.js";
import { ODOS_EXTENSION_URLS, odosConcept, lateralityConcept } from "../fhir/ophthalmology/extensions.js";
import { customFieldEntries, type FindingQualifierValue } from "./custom-fields.js";
import type { AtomicFindingCatalogRow } from "./diagnosis-findings-endpoint.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "./diagnosis-pick-endpoint.js";
import { buildFindingReadAliases } from "./finding-read-aliases.js";
import { translateRetiredFindingRead } from "./finding-read-compatibility.js";
import { componentString, observationNegativeAct } from "./finding-section-helpers.js";
import { isLiveObservation } from "./observation-liveness.js";
import type { ClinicalFindingDefinition } from "./glaucoma-suspect.js";
import { classifyFindingObservation, currentFindingIdentifier, eyeSet, findingQualifiers, observationLaterality, SUPPORTS_DIAGNOSIS_URL,
  type CurrentFindingKey, type FindingClassification, type FindingEye } from "./current-finding-identity.js";

export interface EncounterFindingInput {
  patientReference: string;
  encounterReference: string;
  definitions: readonly ClinicalFindingDefinition[];
  catalog: readonly AtomicFindingCatalogRow[];
  observationCarried?: Readonly<Record<string, boolean>>;
}
export type EncounterFindingState = (EncounterFindingInput & { incomplete: false; observations: Observation[]; conditions: Condition[] }) |
  { incomplete: true; reason: string };
export interface FindingContributor {
  reference: string;
  versionId?: string;
  effectiveDateTime?: string;
  kind: FindingClassification["kind"];
  carried?: boolean;
}
export interface CurrentFindingFact {
  key: CurrentFindingKey;
  projectionKey: string;
  eye: FindingEye;
  status: "live" | "retired";
  presence: "present" | "absent";
  qualifiers: Record<string, FindingQualifierValue>;
  legacy: boolean;
  contributors: FindingContributor[];
  homes: string[];
  effectiveDateTime?: string;
}
export interface FindingConflict extends Omit<CurrentFindingFact, "presence" | "qualifiers"> {
  presence?: CurrentFindingFact["presence"];
  qualifiers?: CurrentFindingFact["qualifiers"];
  reason: string;
  sources: Array<{ presence?: CurrentFindingFact["presence"]; qualifiers: CurrentFindingFact["qualifiers"]; status: CurrentFindingFact["status"]; contributor: FindingContributor }>;
}
export interface FindingPanel {
  stableKey: string;
  eye: FindingEye;
  snapshots: Array<{ source: FindingContributor; status: "live" | "retired"; state?: string; other?: string; remarks?: string; observation: Observation }>;
  negativeActs: Array<{ identifier: NonNullable<Observation["identifier"]>[number]; scope: NonNullable<ReturnType<typeof observationNegativeAct>>;
    exclusions: string[]; captureInput?: string; actor: string; time: string; source: FindingContributor; status: "live" | "retired" }>;
  state?: string;
  other?: string;
  remarks?: string;
  deferred: boolean;
  conflict?: boolean;
}
export type FindingDefinitionView = Observation & { projectionKey: string; contributors: FindingContributor[] };
export interface CurrentFindingProjection {
  currentFacts: CurrentFindingFact[];
  panels: FindingPanel[];
  definitionViews: FindingDefinitionView[];
  conflicts: FindingConflict[];
  unresolved: Array<{ reference?: string; reason: string }>;
}
type CompleteState = Extract<EncounterFindingState, { incomplete: false }>;
interface Assertion {
  key: CurrentFindingKey;
  observation: Observation;
  contributor: FindingContributor;
  row: AtomicFindingCatalogRow;
  definition: ClinicalFindingDefinition;
  status: "live" | "retired";
  presence?: "present" | "absent";
  qualifiers: Record<string, FindingQualifierValue>;
  translated: boolean;
  canonical: boolean;
  snapshotConflict?: boolean;
}
interface Snapshot { observation: Observation; definition: ClinicalFindingDefinition; eye: FindingEye; kind: FindingClassification["kind"] }

export async function loadEncounterFindingState(fhir: FhirSearchClient, input: EncounterFindingInput): Promise<EncounterFindingState> {
  try {
    const checked = <T extends Resource>(bundle: Bundle<T>): Bundle<T> => {
      if (bundle.resourceType !== "Bundle" || bundle.link?.some(l => l.relation === "next" && !l.url)) throw new Error("Malformed search page.");
      return bundle;
    };
    const client: FhirSearchClient = { baseUrl: fhir.baseUrl, search: fhir.search.bind(fhir),
      ...(fhir.searchUrl ? { searchUrl: async <T extends Resource>(url: string, type: T["resourceType"]) => checked(await fhir.searchUrl!<T>(url, type)) } : {}),
    };
    const [observationPage, conditionPage] = await Promise.all([
      fhir.search<Observation>("Observation", { encounter: input.encounterReference, _count: "200" }),
      fhir.search<Condition>("Condition", { encounter: input.encounterReference, _count: "200" }),
    ]);
    const [observations, conditions] = await Promise.all([
      collectAllFhirSearchPages<Observation>(client, "Observation", checked(observationPage), client.baseUrl),
      collectAllFhirSearchPages<Condition>(client, "Condition", checked(conditionPage), client.baseUrl),
    ]);
    for (const [type, resources] of [["Observation", observations], ["Condition", conditions]] as const) {
      if (resources.some(r => r.resourceType !== type || r.subject?.reference !== input.patientReference || r.encounter?.reference !== input.encounterReference)) {
        throw new Error(`${type} search returned a resource outside the requested patient/encounter scope.`);
      }
    }
    return { ...input, incomplete: false, observations, conditions };
  } catch (error) {
    return { incomplete: true, reason: error instanceof Error ? error.message : "Encounter search failed." };
  }
}

export function projectCurrentFindings(state: EncounterFindingState): CurrentFindingProjection {
  if (state.incomplete) throw new Error(`Cannot project incomplete finding state: ${state.reason}`);
  const result: CurrentFindingProjection = { currentFacts: [], panels: [], definitionViews: [], conflicts: [], unresolved: [] };
  const aliases = buildFindingReadAliases(state.definitions, state.catalog);
  const assertions = new Map<string, Assertion[]>();
  const snapshots = new Map<string, Snapshot[]>();
  const latestSnapshots = new Map<string, Snapshot[]>();
  const panelMap = new Map<string, FindingPanel>();
  const passthrough: Observation[] = [];
  const unresolved = (o: Observation, reason: string) => result.unresolved.push({ ...(o.id ? { reference: `Observation/${o.id}` } : {}), reason });
  const panel = (stableKey: string, eye: FindingEye): FindingPanel => {
    const id = panelKey(stableKey, eye);
    if (!panelMap.has(id)) panelMap.set(id, { stableKey, eye, snapshots: [], negativeActs: [], deferred: false });
    return panelMap.get(id)!;
  };
  const add = (a: Assertion) => {
    const id = projectionKey(a.key);
    assertions.set(id, [...(assertions.get(id) ?? []), a]);
  };
  for (const observation of state.observations) {
    const classified = classifyFindingObservation(observation, state.definitions, state.catalog, aliases);
    if (classified.kind === "unrelated") { passthrough.push(observation); continue; }
    if (!observation.id) { unresolved(observation, "Stored finding has no resource id."); continue; }
    if (classified.kind === "invalid" || classified.kind === "unresolved-legacy") { unresolved(observation, classified.reason!); continue; }
    if (classified.kind === "negative-act") {
      const act = observationNegativeAct(observation);
      if (!act) { unresolved(observation, "Negative marker has no scope envelope."); continue; }
      if (!classified.definition || classified.definition.stableKey !== act.definitionStableKey || observationLaterality(observation) !== act.eye) {
        unresolved(observation, "Negative scope does not match its definition/eye."); continue;
      }
      panel(act.definitionStableKey, act.eye).negativeActs.push({ identifier: structuredClone(observation.identifier!.find(i => i.system === "urn:odos:negative-act")!),
        scope: act, exclusions: [...act.exclusions], captureInput: componentString(observation, "NEGATIVE_CAPTURE_INPUT"), actor: act.actorReference, time: act.assertedAt,
        source: contributor(observation, classified.kind, state), status: status(observation) });
      continue;
    }
    const eyes = eyeSet(observationLaterality(observation));
    if (!eyes.length) { unresolved(observation, "UNKNOWN laterality has no eye identity."); continue; }
    if (!classified.definition) { unresolved(observation, "Missing finding definition."); continue; }
    for (const eye of eyes) {
      if (classified.kind === "panel-context" || classified.kind === "legacy-section-snapshot") {
        const p = panel(classified.definition.stableKey, eye);
        p.snapshots.push({ source: contributor(observation, classified.kind, state), status: status(observation), observation: structuredClone(observation),
          state: componentString(observation, "EXAM_STATE"), other: componentString(observation, "OTHER"), remarks: componentString(observation, "REMARKS") });
        if (classified.kind === "legacy-section-snapshot" && isLiveObservation(observation)) {
          const id = panelKey(classified.definition.stableKey, eye);
          snapshots.set(id, [...(snapshots.get(id) ?? []), { observation, definition: classified.definition, eye, kind: classified.kind }]);
        }
        continue;
      }
      const row = classified.row!;
      add({ key: classified.key ?? factKey(state, row, eye), row, definition: classified.definition, observation,
        contributor: contributor(observation, classified.kind, state), status: status(observation), presence: observation.valueBoolean === false ? "absent" : "present",
        qualifiers: { ...classified.qualifiers, ...findingQualifiers(observation, classified.definition, row, "") }, translated: classified.translated === true,
        canonical: classified.kind === "canonical-fact" });
    }
  }
  for (const [id, group] of snapshots) {
    const newest = group.reduce((max, s) => time(s.observation) > max ? time(s.observation) : max, "");
    const latest = group.filter(s => time(s.observation) === newest).sort(sourceOrder);
    latestSnapshots.set(id, latest);
    const differing = new Set(latest.map(s => snapshotContent(s.observation))).size > 1;
    const p = panelMap.get(id)!;
    p.conflict = differing || undefined;
    if (!differing) Object.assign(p, { state: componentString(latest[0].observation, "EXAM_STATE"), other: componentString(latest[0].observation, "OTHER"),
      remarks: componentString(latest[0].observation, "REMARKS"), deferred: componentString(latest[0].observation, "EXAM_STATE") === "deferred" });
    const rows = latest.map(s => sectionAssertions(s, state, unresolved));
    const union = new Map(rows.flat().map(a => [projectionKey(a.key), a]));
    for (const [index, snapshot] of latest.entries()) {
      for (const [key, example] of union) {
        const found = rows[index].find(a => projectionKey(a.key) === key);
        add(found ? { ...found, snapshotConflict: differing } : { ...example, observation: snapshot.observation,
          contributor: contributor(snapshot.observation, snapshot.kind, state), presence: undefined, qualifiers: {}, snapshotConflict: differing });
      }
    }
  }
  const selected = new Map<string, Assertion[]>();
  for (const [id, group] of [...assertions].sort(([a], [b]) => a.localeCompare(b))) {
    const canonical = group.filter(a => a.canonical);
    const live = group.filter(a => !a.canonical && a.status === "live");
    const chosen = (canonical.length ? canonical : live.length ? live : group).sort((a,b) => a.contributor.reference.localeCompare(b.contributor.reference));
    const first = chosen[0];
    const homes = explicitHomes(chosen, state.conditions);
    const contributors = uniqueContributors(chosen.map(a => a.contributor));
    const common = { key: first.key, projectionKey: id, eye: first.key.eye, status: first.status, legacy: !first.canonical, contributors,
      homes: homes.length || first.canonical ? homes : inferredHomes(chosen.find(a => a.contributor.kind === "legacy-section-snapshot") ?? first, state),
      effectiveDateTime: contributors.flatMap(c => c.effectiveDateTime ? [c.effectiveDateTime] : []).sort().at(-1) };
    const different = new Set(chosen.map(a => normalized([a.presence, a.qualifiers, a.status]))).size > 1;
    if (canonical.length > 1 || different || chosen.some(a => a.snapshotConflict)) {
      result.conflicts.push({ ...common, reason: canonical.length > 1 ? "Multiple canonical owners." : "Contradicting legacy assertions or equal-time snapshots.",
        sources: chosen.map(a => ({ presence: a.presence, qualifiers: structuredClone(a.qualifiers), status: a.status, contributor: a.contributor })) });
    } else if (first.presence !== undefined) {
      result.currentFacts.push({ ...common, presence: first.presence, qualifiers: structuredClone(first.qualifiers) });
      selected.set(id, chosen);
    }
  }
  for (const p of panelMap.values()) {
    p.snapshots.sort((a,b) => a.source.reference.localeCompare(b.source.reference));
    p.negativeActs.sort((a,b) => a.source.reference.localeCompare(b.source.reference));
    const contexts = p.snapshots.filter(s => s.source.kind === "panel-context" && s.status === "live");
    if (contexts.length) {
      const newest = contexts.map(s => time(s.observation)).sort().at(-1);
      const latest = contexts.filter(s => time(s.observation) === newest);
      if (new Set(latest.map(s => snapshotContent(s.observation))).size > 1) p.conflict = true;
      else Object.assign(p, { state: latest[0].state, other: latest[0].other, remarks: latest[0].remarks, deferred: latest[0].state === "deferred" });
    }
  }
  result.panels = [...panelMap.values()].sort((a,b) => panelKey(a.stableKey,a.eye).localeCompare(panelKey(b.stableKey,b.eye)));
  buildViews(result, state, selected, latestSnapshots);
  for (const observation of passthrough) result.definitionViews.push({ ...structuredClone(observation), projectionKey: `passthrough:${observation.id ?? normalized(observation.code)}`,
    contributors: observation.id ? [contributor(observation, "unrelated", state)] : [] });
  result.currentFacts.sort(factOrder); result.conflicts.sort(factOrder);
  result.unresolved.sort((a,b) => (a.reference ?? "").localeCompare(b.reference ?? "") || a.reason.localeCompare(b.reason));
  return result;
}

function sectionAssertions(snapshot: Snapshot, state: CompleteState, unresolved: (o: Observation, reason: string) => void): Assertion[] {
  const { observation, definition, eye } = snapshot;
  const assertions: Assertion[] = [];
  const known = new Set<string>();
  for (const field of customFieldEntries(definition, true).filter(f => f.valueType === "multi-select")) {
    const prefix = observation.component?.some(c => c.code.coding?.some(v => v.code?.startsWith(`${eye}_`))) ? `${eye}_` : "";
    const translated = translateRetiredFindingRead(observation, definition.stableKey, field, prefix);
    const options = Array.isArray(translated.value) ? translated.value : [];
    for (const option of field.options ?? []) { known.add(`${prefix}${field.localCode}::${option.code}`); known.add(`${prefix}${option.code}`); }
    const aliasMap = buildFindingReadAliases([definition], state.catalog);
    for (const atomicId of aliasMap.keys()) known.add(`${prefix}${atomicId.slice(definition.stableKey.length + 2)}`);
    for (const option of options) {
      const row = state.catalog.find(r => r.findingDefinitionKey === definition.stableKey && r.fieldCode === field.localCode && r.optionCode === option);
      if (!row) { unresolved(observation, `Option ${option} is missing from the effective catalog.`); continue; }
      const qualifiers = findingQualifiers(observation, definition, row, prefix);
      const selectedDirectly = observation.component?.some(c => c.valueBoolean === true && c.code.coding?.some(v => v.code === `${prefix}${field.localCode}::${option}` || v.code === `${prefix}${option}`));
      const qualifierKeys = field.options?.find(o => o.code === option)?.qualifiers?.map(q => q.key) ?? [];
      const retiredQualifier = qualifierKeys.some(key => !Object.hasOwn(qualifiers, key) && observation.component?.some(c =>
        c.code.coding?.some(v => v.code === `${prefix}${field.localCode}::${option}::${key}`)));
      const retiredSelection = [...aliasMap].some(([atomicId, alias]) => alias.row?.optionCode === option && observation.component?.some(c =>
        c.valueBoolean === true && c.code.coding?.some(v => v.code === `${prefix}${atomicId.slice(definition.stableKey.length + 2)}`)));
      assertions.push({ key: factKey(state,row,eye), row, definition, observation, contributor: contributor(observation,"legacy-section-snapshot",state),
        status: "live", presence: "present", qualifiers, translated: !selectedDirectly || retiredSelection || retiredQualifier || observationLaterality(observation) === "OU", canonical: false });
    }
  }
  const unknown = observation.component?.flatMap(c => c.valueBoolean === true ? (c.code.coding ?? []).flatMap(v => v.code && v.code !== "CLINICAL_VALUE" && !known.has(v.code) ? [v.code] : []) : []) ?? [];
  if (unknown.length) unresolved(observation, `Unrecognized selected option components: ${unknown.join(", ")}`);
  return assertions;
}

function buildViews(result: CurrentFindingProjection, state: CompleteState, selected: Map<string, Assertion[]>, latest: Map<string, Snapshot[]>): void {
  const groups = new Map<string, { definition: ClinicalFindingDefinition; eye: FindingEye; facts: CurrentFindingFact[] }>();
  for (const snapshots of latest.values()) {
    const first = snapshots[0]; groups.set(panelKey(first.definition.stableKey,first.eye), { definition: first.definition, eye: first.eye, facts: [] });
  }
  for (const fact of result.currentFacts.filter(f => f.status === "live")) {
    const id = panelKey(fact.key.stableKey, fact.eye);
    if (!groups.has(id)) groups.set(id, { definition: state.definitions.find(d => d.stableKey === fact.key.stableKey)!, eye: fact.eye, facts: [] });
    groups.get(id)!.facts.push(fact);
  }
  for (const [id, group] of [...groups].sort(([a],[b]) => a.localeCompare(b))) {
    if (result.conflicts.some(c => panelKey(c.key.stableKey,c.eye) === id)) continue;
    const snapshots = latest.get(id) ?? [];
    const sources = new Map<string, Observation>();
    const attributions: FindingContributor[] = [];
    for (const s of snapshots) { sources.set(s.observation.id!, s.observation); attributions.push(contributor(s.observation,s.kind,state)); }
    const factAssertions = group.facts.flatMap(f => selected.get(f.projectionKey) ?? []);
    for (const a of factAssertions) { sources.set(a.observation.id!, a.observation); attributions.push(a.contributor); }
    const source = [...sources.values()].sort((a,b) => time(b).localeCompare(time(a)) || a.id!.localeCompare(b.id!))[0];
    if (!source) continue;
    const removed = result.currentFacts.some(f => f.status === "retired" && panelKey(f.key.stableKey,f.eye) === id);
    const translated = sources.size !== 1 || !snapshots.length || removed || factAssertions.some(a => a.translated || a.contributor.kind !== "legacy-section-snapshot");
    const view: FindingDefinitionView = { ...structuredClone(source), projectionKey: `definition:${id}`, contributors: uniqueContributors(attributions) };
    if (translated) {
      delete view.id; delete view.identifier; delete view.valueBoolean;
      view.code = odosConcept(group.definition.stableKey, group.definition.display);
      view.extension = [...(view.extension ?? []).filter(e => e.url !== ODOS_EXTENSION_URLS.eyeLaterality && e.url !== SUPPORTS_DIAGNOSIS_URL),
        { url: ODOS_EXTENSION_URLS.eyeLaterality, valueCodeableConcept: lateralityConcept(group.eye) }];
      const panelSource = snapshots[0]?.observation;
      const fields = customFieldEntries(group.definition, true).filter(f => f.valueType === "multi-select");
      const components = (panelSource?.component ?? []).filter(c => !c.code.coding?.some(v => fields.some(f =>
        v.code?.startsWith(`${f.localCode}::`) || v.code?.startsWith(`OD_${f.localCode}::`) || v.code?.startsWith(`OS_${f.localCode}::`) ||
        f.options?.some(o => v.code === o.code || v.code === `OD_${o.code}` || v.code === `OS_${o.code}`))));
      view.component = [...structuredClone(components), ...group.facts.flatMap(f => {
        const base = `${group.eye}_${f.key.fieldCode}::${f.key.optionCode}`;
        return [{ code: odosConcept(base), valueBoolean: f.presence === "present" }, ...Object.entries(f.qualifiers).sort(([a],[b])=>a.localeCompare(b)).map(([key,value]): ObservationComponent => ({
          code: odosConcept(`${base}::${key}`), ...(typeof value === "number" ? { valueQuantity: { value } } : typeof value === "string" ? { valueCodeableConcept: odosConcept(value) } : { valueString: JSON.stringify(value) }),
        }))];
      })];
      view.interpretation = [{ coding: [{ code: group.facts.some(f => f.presence === "present") ? "A" : "N" }] }];
      view.effectiveDateTime = group.facts.flatMap(f => f.effectiveDateTime ? [f.effectiveDateTime] : []).sort().at(-1) ?? source.effectiveDateTime;
    }
    result.definitionViews.push(view);
  }
}
function factKey(state: CompleteState, row: AtomicFindingCatalogRow, eye: FindingEye): CurrentFindingKey {
  return { v: 1, patientId: state.patientReference.slice("Patient/".length), encounterId: state.encounterReference.slice("Encounter/".length),
    stableKey: row.findingDefinitionKey, fieldCode: row.fieldCode, optionCode: row.optionCode, eye };
}
function contributor(observation: Observation, kind: FindingClassification["kind"], state: CompleteState): FindingContributor {
  const reference = `Observation/${observation.id}`;
  return { reference, ...(observation.meta?.versionId ? {versionId:observation.meta.versionId}:{}), ...(observation.effectiveDateTime ? {effectiveDateTime:observation.effectiveDateTime}:{}), kind,
    ...(Object.hasOwn(state.observationCarried ?? {},reference) ? {carried:state.observationCarried![reference]}:{}) };
}
function explicitHomes(assertions: Assertion[], conditions: Condition[]): string[] {
  const references = new Set(assertions.map(a => a.contributor.reference));
  return [...new Set([
    ...conditions.flatMap(c => c.id && c.evidence?.some(e => e.detail?.some(d => d.reference && references.has(d.reference))) ? [`Condition/${c.id}`] : []),
    ...assertions.flatMap(a => a.observation.extension?.flatMap(e => e.url === SUPPORTS_DIAGNOSIS_URL && /^Condition\/[A-Za-z0-9.-]+$/.test(e.valueReference?.reference ?? "") ? [e.valueReference!.reference!] : []) ?? []),
  ])].sort();
}
function inferredHomes(assertion: Assertion, state: CompleteState): string[] {
  if (assertion.contributor.kind !== "legacy-section-snapshot") return [];
  return [...new Set(state.conditions.flatMap(c => {
    if (!c.id || !hasConditionCategory(c, "encounter-diagnosis")) return [];
    const verification = c.verificationStatus?.coding?.find(v => v.system === FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM)?.code;
    if (!["confirmed", "provisional", "differential", "unconfirmed"].includes(verification ?? "")) return [];
    const value = c.identifier?.find(i => i.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM)?.value;
    const keyMatch = assertion.row.diagnosisKeys.some(k => value === k || value?.startsWith(`${assertion.key.encounterId}::${k}::`));
    const recorded = c.extension?.find(e => e.url === ODOS_EXTENSION_URLS.eyeLaterality)?.valueCodeableConcept?.coding?.find(v => v.code)?.code ??
      c.bodySite?.flatMap(b => [...(b.coding ?? []).flatMap(v => v.code ? [v.code] : []), ...(b.text ? [b.text] : [])]).find(v => ["OD","OS","OU","right","left","bilateral"].includes(v)) ?? value?.split("::").at(-1);
    const laterality = recorded === "right" ? "OD" : recorded === "left" ? "OS" : recorded === "bilateral" ? "OU" : recorded ?? "UNKNOWN";
    return keyMatch && eyeSet(laterality).includes(assertion.key.eye) ? [`Condition/${c.id}`] : [];
  }))].sort();
}
function uniqueContributors(contributors: FindingContributor[]): FindingContributor[] {
  return [...new Map(contributors.map(c => [c.reference,c])).values()].sort((a,b)=>a.reference.localeCompare(b.reference));
}
function normalized(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,sort(x)])) : v;
  return JSON.stringify(sort(value));
}
function snapshotContent(o: Observation): string {
  return normalized({ component: [...(o.component ?? [])].sort((a,b)=>normalized(a).localeCompare(normalized(b))), valueBoolean: o.valueBoolean, valueString:o.valueString, interpretation:o.interpretation });
}
function sourceOrder(a: Snapshot,b: Snapshot): number { return a.observation.id!.localeCompare(b.observation.id!); }
function status(o: Observation): "live" | "retired" { return isLiveObservation(o) ? "live" : "retired"; }
function time(o: Observation): string { return o.effectiveDateTime ?? o.issued ?? o.meta?.lastUpdated ?? ""; }
function projectionKey(key: CurrentFindingKey): string { return `finding:${currentFindingIdentifier(key).value}`; }
function panelKey(key: string, eye: FindingEye): string { return JSON.stringify([key,eye]); }
function factOrder(a: {key:CurrentFindingKey},b: {key:CurrentFindingKey}): number {
  return a.key.stableKey.localeCompare(b.key.stableKey) || a.key.fieldCode.localeCompare(b.key.fieldCode) || a.key.optionCode.localeCompare(b.key.optionCode) || a.key.eye.localeCompare(b.key.eye);
}
