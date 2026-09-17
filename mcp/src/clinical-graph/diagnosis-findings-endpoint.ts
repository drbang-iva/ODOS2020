import { isClosedEncounter , observePostCommandClosure } from "./encounter-sign-gate.js";
import { ownsFact } from "./current-finding-identity.js";
import type { Bundle, Condition, Encounter, Resource } from '@medplum/fhirtypes';
import { z } from 'zod';
import { staffHasBusinessAction, type PracticeRoleId } from '../authz/roles.js';
import { FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM, hasConditionCategory } from '../fhir/condition.js';
import { ODOS_EXTENSION_URLS } from '../fhir/ophthalmology/extensions.js';
import { customFieldEntries, type FindingQualifierValue } from './custom-fields.js';
import { FhirDiagnosisCatalogStore } from './diagnosis-catalog-store.js';
import { FhirFindingDefinitionStore } from './finding-definition-store.js';
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from './diagnosis-pick-endpoint.js';
import { FAMILY_RESOLUTION_MODES } from './diagnosis-catalog-seeds.js';
import type { ClinicalFindingDefinition, DiagnosisCatalogRow, MappingTrigger } from './glaucoma-suspect.js';
import { readDiagnosisCarryState } from './diagnosis-carry-provenance.js';
import { currentFindingKeySchema, currentFindingIdentifier, type CurrentFindingKey } from './current-finding-identity.js';
import { loadEncounterFindingState, projectCurrentFindings, type EncounterFindingState, type CurrentFindingFact, type FindingConflict, type CurrentFindingProjection } from './current-finding-reader.js';
import { FindingReplayLookupError, classifyReplay, executeFindingCommand, repairPendingAudits, type FindingCommandDeps, type FindingCommand, type FindingCommandTarget, type FindingCommandResult } from './current-finding-writer.js';
export type FindingLaterality = 'OD' | 'OS' | 'OU' | 'UNKNOWN';
export interface AtomicFindingCatalogRow {
    atomicFindingId: string;
    findingDefinitionId: string;
    findingDefinitionKey: string;
    fieldCode: string;
    optionCode: string;
    display: string;
    sectionKey: string;
    gradeScale: string[];
    diagnosisKeys: string[];
    origin: 'shipped' | 'custom';
}
export interface EncounterFindingRow extends AtomicFindingCatalogRow {
    rowKey: string;
    kind: 'fact' | 'conflict' | 'unresolved' | 'offered';
    eye: 'OD' | 'OS' | 'UNKNOWN';
    laterality: FindingLaterality;
    presence?: 'present' | 'absent';
    qualifiers: Record<string, FindingQualifierValue>;
    grade?: string;
    status: 'live' | 'retired' | 'offered';
    editable: boolean;
    readOnlyReason?: string;
    homes: string[];
    homeSources: CurrentFindingFact['homeSources'];
    conditionReference?: string;
    key?: CurrentFindingKey;
    baseline?: Exclude<FindingCommandTarget, {
        kind: 'legacy-retire';
    }>['baseline'] | {
        kind: 'absent';
        key: CurrentFindingKey;
    };
    contributors: CurrentFindingFact['contributors'];
    carried?: boolean;
    auditPending?: boolean;
    priorPresence?: 'present' | 'absent';
    priorGrade?: string;
    priorLaterality?: FindingLaterality;
}
export interface DiagnosisFindingsPayload {
    encounterEditable: boolean;
    readOnlyReason?: string;
    canWrite: boolean;
    canWriteDiagnosis: boolean;
    diagnosis?: DiagnosisCatalogRow;
    carryProvenance?: {
        pulledFromDate?: string;
        unchangedSinceDate?: string;
        edited: boolean;
        integrityWarning?: string;
    };
    findings: EncounterFindingRow[];
    catalog: AtomicFindingCatalogRow[];
    searchIndex: EncounterFindingRow[];
    unassigned: EncounterFindingRow[];
    bySection: Record<string, EncounterFindingRow[]>;
    auditDebt: EncounterFindingRow[];
    visitDiagnoses: Array<{
        conditionReference: string;
        diagnosisKey: string;
        display: string;
        laterality: FindingLaterality;
    }>;
}
export interface DiagnosisFindingsFhirClient {
    readonly baseUrl: string;
    read<T extends Resource>(resourceType: T['resourceType'], id: string): Promise<T>;
    search<T extends Resource>(resourceType: T['resourceType'], params?: Record<string, string>): Promise<Bundle<T>>;
    searchUrl?<T extends Resource>(url: string, resourceType: T['resourceType']): Promise<Bundle<T>>;
    create<T extends Resource>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
    createWithOutcome?: FindingCommandDeps['fhir']['createWithOutcome'];
    update<T extends Resource>(resourceType: T['resourceType'], id: string, resource: T, extraHeaders?: Record<string, string>): Promise<T>;
}
export interface DiagnosisFindingsEndpointDeps {
    fhirBaseUrl: string;
    authenticate(authHeader: string | undefined): Promise<{
        staffReference: string;
        actorRole: PracticeRoleId;
        fhir: DiagnosisFindingsFhirClient;
    } | null>;
    findingDefinitions?: () => ClinicalFindingDefinition[] | Promise<ClinicalFindingDefinition[]>;
    diagnosisCatalog?: () => DiagnosisCatalogRow[] | Promise<DiagnosisCatalogRow[]>;
    now?: () => string;
}
type Incomplete = Extract<EncounterFindingState, {
    incomplete: true;
}>;
export type DiagnosisFindingContext = {
    incomplete: false;
    encounter: Encounter;
    state: Extract<EncounterFindingState, {
        incomplete: false;
    }>;
    projection: CurrentFindingProjection;
    catalog: AtomicFindingCatalogRow[];
};
type Response = {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
};
const paramsSchema = z.object({ encounterId: z.string().trim().min(1).max(128) }).strict();
const conditionReferenceSchema = z.string().regex(/^Condition\/[A-Za-z0-9.-]+$/);
const patientReferenceSchema = z.string().regex(/^Patient\/[A-Za-z0-9.-]+$/);
const readQuerySchema = z.object({ condition: conditionReferenceSchema.optional() }).strict();
const canonicalBaseline = z.object({ kind: z.literal('canonical'), reference: z.string().regex(/^Observation\/[A-Za-z0-9.-]+$/), versionId: z.string().min(1) }).strict();
const absentBaseline = z.object({ kind: z.literal('absent'), key: currentFindingKeySchema }).strict();
const qualifierValue = z.union([z.string(), z.number().finite(), z.object({ from: z.number().int().min(1).max(12), to: z.number().int().min(1).max(12), clockwise: z.boolean() }).strict()]);
const targetSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fact'), key: currentFindingKeySchema, baseline: z.union([canonicalBaseline, absentBaseline]).optional(), state: z.object({ status: z.enum(['live', 'retired']), presence: z.enum(['present', 'absent']), qualifiers: z.record(qualifierValue), homes: z.array(conditionReferenceSchema) }).strict() }).strict(),
    z.object({ kind: z.literal('reassert'), key: currentFindingKeySchema, baseline: canonicalBaseline.optional() }).strict(),
]);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const eyesSchema = z.array(z.enum(['OD', 'OS'])).min(1).max(2).refine(v => new Set(v).size === v.length);
const mutationSchema = z.object({ commandId: uuid, patientReference: patientReferenceSchema, operation: z.enum(['assert', 'clear', 'grade', 'eye-change', 'move', 'standalone', 'link', 'reassert']), context: z.object({ selectedConditionReference: conditionReferenceSchema }).strict().optional(), targets: z.array(targetSchema).min(1), eyes: z.object({ from: eyesSchema, to: eyesSchema }).strict().optional() }).strict();
type Mutation = z.infer<typeof mutationSchema>;
const invalid = (reason: string, targetIndex?: number): Response => ({ status: reason === 'signed-or-cancelled' ? 422 : ['destination-differs', 'command-reused', 'pre-rebuild-test-encounter', 'encounter-closed'].includes(reason) ? 409 : 400, body: { result: 'invalid', error: reason, reason, ...(targetIndex !== undefined ? { targetIndex } : {}) } });
const unavailable = (state: Incomplete): Response => ({ status: loadStatus(state.kind), body: { result: 'unavailable', kind: state.kind, error: state.reason } });
const loadStatus = (kind: Incomplete['kind']) => kind === 'refused' ? 403 : kind === 'missing' ? 404 : 502;
function dependencyState(error: unknown): Incomplete { const status = (error as {
    status?: number;
})?.status; return { incomplete: true, kind: status === 401 || status === 403 ? 'refused' : status === 404 || status === 410 ? 'missing' : 'upstream', reason: 'Encounter findings could not be loaded.' }; }
export async function loadDiagnosisFindingContext(fhir: Pick<DiagnosisFindingsFhirClient, 'baseUrl' | 'read' | 'search' | 'searchUrl'>, encounterId: string, definitions: ClinicalFindingDefinition[]): Promise<DiagnosisFindingContext | Incomplete> {
    try {
        const encounter = await fhir.read<Encounter>('Encounter', encounterId);
        const patientReference = encounter.subject?.reference;
        if (!patientReferenceSchema.safeParse(patientReference).success)
            return { incomplete: true, kind: 'foreign-or-unscoped', reason: 'Encounter has no scoped patient.' };
        const catalog = materializeAtomicFindingCatalog(definitions);
        const state = await loadEncounterFindingState(fhir, { patientReference: patientReference!, encounterReference: `Encounter/${encounterId}`, definitions, catalog, includeAuditState: true });
        if (state.incomplete)
            return state;
        return { incomplete: false, encounter, state, projection: projectCurrentFindings(state), catalog };
    }
    catch (error) {
        return dependencyState(error);
    }
}
const targetId = (key: CurrentFindingKey) => `finding:${currentFindingIdentifier(key).value}`;
const catalogId = (key: CurrentFindingKey) => `${key.stableKey}::${key.fieldCode}::${key.optionCode}`;
function owner(context: DiagnosisFindingContext, key: CurrentFindingKey) { const id = currentFindingIdentifier(key); return context.state.observations.find(o => o.identifier?.some(i => i.system === id.system && i.value === id.value)); }
const domain = (context: DiagnosisFindingContext) => new Set(context.state.conditions.map(c => `Condition/${c.id}`));
const liveHomes = (context: DiagnosisFindingContext, fact: CurrentFindingFact | FindingConflict) => fact.status === 'live' ? fact.homes.filter(h => context.state.conditions.some(c => `Condition/${c.id}` === h && isCurrentVisitDiagnosis(c))) : [];
export function findingTargetReadOnlyReason(context: DiagnosisFindingContext, key: CurrentFindingKey): string | undefined {
    if (isClosedEncounter(context.encounter)) return 'encounter-closed';
    if (context.projection.preRebuild)
        return 'pre-rebuild-test-encounter';
    if (context.projection.conflicts.some(f => f.projectionKey === targetId(key)))
        return 'conflict';
    const record = owner(context, key);
    if (record && !['preliminary', 'entered-in-error'].includes(record.status))
        return 'signed-or-cancelled';
    const fact = context.projection.currentFacts.find(f => f.projectionKey === targetId(key));
    if (fact?.readOnlyReason) return fact.readOnlyReason;
    if (fact?.homes.some(h => !domain(context).has(h)))
        return 'home-outside-encounter';
    return undefined;
}
export function projectRow(context: DiagnosisFindingContext, fact: CurrentFindingFact | FindingConflict, kind: 'fact' | 'conflict'): EncounterFindingRow {
    const definition = context.state.definitions.find(d => d.stableKey === fact.key.stableKey);
    const option = definition && customFieldEntries(definition, true).find(f => f.localCode === fact.key.fieldCode)?.options?.find(o => o.code === fact.key.optionCode);
    const catalog = context.catalog.find(row => row.atomicFindingId === catalogId(fact.key)) ?? {
        atomicFindingId: catalogId(fact.key), findingDefinitionId: definition?.id ?? '',
        findingDefinitionKey: fact.key.stableKey, fieldCode: fact.key.fieldCode, optionCode: fact.key.optionCode,
        display: option?.display ?? fact.key.optionCode, sectionKey: definition?.sectionKey ?? fact.key.stableKey, gradeScale: [], diagnosisKeys: [], origin: 'custom' as const,
    };
    const homes = liveHomes(context, fact), reason = findingTargetReadOnlyReason(context, fact.key);
    return { ...catalog, rowKey: fact.projectionKey, kind, key: fact.key, eye: fact.eye, laterality: fact.eye, presence: fact.presence, qualifiers: fact.qualifiers ?? {},
        ...(typeof fact.qualifiers?.grade === 'string' ? { grade: fact.qualifiers.grade } : {}), status: fact.status, editable: !reason, ...(reason ? { readOnlyReason: reason } : {}),
        homes: fact.homes, homeSources: fact.homeSources, ...(homes.length === 1 ? { conditionReference: homes[0] } : {}), baseline: fact.baseline, contributors: fact.contributors,
        ...(fact.contributors.some(c => c.carried !== undefined) ? { carried: fact.contributors.every(c => c.carried === true) } : {}), ...(fact.auditPending ? { auditPending: true } : {}), ...('auditIntegrity' in fact && fact.auditIntegrity ? { auditIntegrity: fact.auditIntegrity } : {}) };
}
export function offeredRow(context: DiagnosisFindingContext, row: AtomicFindingCatalogRow, eye: 'OD' | 'OS' | 'UNKNOWN'): EncounterFindingRow {
    const key: CurrentFindingKey | undefined = eye === 'UNKNOWN' ? undefined : { v: 1, patientId: context.state.patientReference.slice(8), encounterId: context.state.encounterReference.slice(10), stableKey: row.findingDefinitionKey, fieldCode: row.fieldCode, optionCode: row.optionCode, eye };
    const fact = key ? context.projection.currentFacts.find(f => f.projectionKey === targetId(key)) : undefined;
    const reason = key ? findingTargetReadOnlyReason(context, key) : context.projection.preRebuild ? 'pre-rebuild-test-encounter' : undefined;
    return { ...row, rowKey: `offered:${row.atomicFindingId}:${eye}`, kind: 'offered', eye, laterality: eye, status: 'offered', editable: !reason, ...(reason ? { readOnlyReason: reason } : {}), qualifiers: {}, homes: [], homeSources: [], contributors: [],
        ...(key ? { key, baseline: fact?.baseline ?? { kind: 'absent' as const, key } } : {}) };
}
export async function handleDiagnosisFindingsReadRequest(deps: DiagnosisFindingsEndpointDeps, input: {
    authHeader: string | undefined;
    params: unknown;
    query: unknown;
}): Promise<Response> {
    const staff = await deps.authenticate(input.authHeader);
    if (!staff)
        return { status: 401, body: { result: 'unauthenticated', error: 'Authentication required.' } };
    if (!staffHasBusinessAction(staff, 'chart.read'))
        return { status: 403, body: { result: 'forbidden', error: 'chart.read role required' } };
    const params = paramsSchema.safeParse(input.params), query = readQuerySchema.safeParse(input.query);
    if (!params.success || !query.success)
        return invalid('Invalid encounter findings request.');
    try {
        const definitions = await (deps.findingDefinitions?.() ?? new FhirFindingDefinitionStore(staff.fhir).list());
        const context = await loadDiagnosisFindingContext(staff.fhir, params.data.encounterId, definitions);
        if (context.incomplete)
            return unavailable(context);
        const diagnoses = await (deps.diagnosisCatalog?.() ?? new FhirDiagnosisCatalogStore(staff.fhir).list());
        const visits = context.state.conditions.filter(isCurrentVisitDiagnosis).map(condition => ({ condition, conditionReference: `Condition/${condition.id}`, diagnosisKey: conditionDiagnosisKey(condition, params.data.encounterId, diagnoses) ?? '', display: condition.code?.text ?? '', laterality: conditionLaterality(condition, params.data.encounterId) }));
        const selected = visits.find(v => v.conditionReference === query.data.condition);
        if (query.data.condition && !selected)
            return { status: 404, body: { result: 'unavailable', kind: 'missing', error: 'Selected diagnosis is not part of this encounter.' } };
        const carried: Record<string, boolean> = {};
        let carryProvenance: DiagnosisFindingsPayload['carryProvenance'];
        let priorAbsent: Awaited<ReturnType<typeof readDiagnosisCarryState>>['sourceAbsentSnapshots'] = [];
        for (const visit of visits) {
            const carry = await readDiagnosisCarryState(staff.fhir, visit.condition, context.state.observations, { preRebuild: context.projection.preRebuild });
            Object.assign(carried, carry.observationCarried);
            if (visit === selected) {
                priorAbsent = carry.sourceAbsentSnapshots;
                if (carry.pulledFromDate || carry.integrityWarning)
                    carryProvenance = { ...(carry.pulledFromDate ? { pulledFromDate: carry.pulledFromDate } : {}), ...(carry.unchangedSinceDate ? { unchangedSinceDate: carry.unchangedSinceDate } : {}), edited: carry.edited, ...(carry.integrityWarning ? { integrityWarning: carry.integrityWarning } : {}) };
            }
        }
        context.state.observationCarried = carried;
        context.projection = projectCurrentFindings(context.state);
        const rows = [...context.projection.currentFacts.filter(f => f.status === 'live').map(f => projectRow(context, f, 'fact')), ...context.projection.conflicts.map(f => projectRow(context, f, 'conflict'))];
        const unresolved: EncounterFindingRow[] = context.projection.unresolved.map(f => {
            const observation = context.state.observations.find(o => `Observation/${o.id}` === f.reference);
            const row = context.catalog.find(row => observation?.code.coding?.some(c => c.code === row.atomicFindingId));
            return { atomicFindingId: '', findingDefinitionId: '', findingDefinitionKey: '', fieldCode: '', optionCode: '', display: f.reason, sectionKey: 'unresolved', gradeScale: [], diagnosisKeys: [], origin: 'custom', ...row,
                rowKey: `unresolved:${f.reference}`, kind: 'unresolved', eye: 'UNKNOWN', laterality: 'UNKNOWN', status: f.status, editable: false, readOnlyReason: context.projection.preRebuild ? 'pre-rebuild-test-encounter' : f.reason, qualifiers: {}, homes: [], homeSources: [], contributors: [] };
        });
        const bySection: Record<string, EncounterFindingRow[]> = {};
        for (const row of [...rows, ...unresolved])
            (bySection[row.sectionKey] ??= []).push(row);
        const rawDiagnosis = selected ? diagnoses.find(d => d.stableKey === selected.diagnosisKey) : undefined;
        const diagnosis = rawDiagnosis ? { ...rawDiagnosis, applicableFindingDefinitionIds: [...new Set(context.catalog.filter(r => r.diagnosisKeys.includes(rawDiagnosis.stableKey)).map(r => r.findingDefinitionId))].sort() } : undefined;
        const findings = selected ? rows.filter(r => r.status === 'live' && r.homes.includes(selected.conditionReference)) : [];
        if (selected && diagnosis)
            for (const row of context.catalog.filter(r => r.diagnosisKeys.includes(diagnosis.stableKey)))
                for (const eye of selected.laterality === 'OU' ? ['OD', 'OS'] as const : [selected.laterality as 'OD' | 'OS' | 'UNKNOWN']) {
                    if (!rows.some(f => f.atomicFindingId === row.atomicFindingId && f.eye === eye)) {
                        const offered = offeredRow(context, row, eye), prior = priorAbsent.filter(p => p.atomicFindingId === row.atomicFindingId && p.laterality === eye);
                        if (prior.length === 1)
                            Object.assign(offered, { priorPresence: prior[0].presence, ...(prior[0].grade ? { priorGrade: prior[0].grade } : {}), priorLaterality: prior[0].laterality });
                        findings.push(offered);
                    }
                }
        const searchIndex = context.catalog.flatMap(row => (['OD', 'OS'] as const).map(eye => rows.find(f => f.atomicFindingId === row.atomicFindingId && f.eye === eye) ?? offeredRow(context, row, eye)));
        const payload: DiagnosisFindingsPayload = { encounterEditable: !context.projection.preRebuild && !isClosedEncounter(context.encounter), ...(isClosedEncounter(context.encounter) ? { readOnlyReason: 'encounter-closed' } : context.projection.preRebuild ? { readOnlyReason: 'pre-rebuild-test-encounter' } : {}), canWrite: staffHasBusinessAction(staff, 'chart.write'), canWriteDiagnosis: staffHasBusinessAction(staff, 'chart.diagnosis.write'), ...(diagnosis ? { diagnosis } : {}), ...(carryProvenance ? { carryProvenance } : {}), findings, catalog: context.catalog, searchIndex, unassigned: rows.filter(r => r.kind === 'fact' && r.status === 'live' && liveHomes(context, context.projection.currentFacts.find(f => f.projectionKey === r.rowKey)!).length === 0), bySection, auditDebt: context.projection.currentFacts.filter(f => f.auditPending).map(f => projectRow(context, f, 'fact')), visitDiagnoses: visits.map(({ condition, ...visit }) => visit) };
        return { status: 200, body: payload };
    }
    catch (error) {
        return unavailable(dependencyState(error));
    }
}
function equal(a: unknown, b: unknown): boolean { const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)).map(([k, w]) => [k, normalize(w)])) : v; return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)); }
const sameHomes = (a: string[], b: string[]) => equal([...a].sort(), [...b].sort()) && new Set(a).size === a.length;
function validQualifiers(context: DiagnosisFindingContext, target: Extract<FindingCommandTarget, {
    kind: 'fact';
}>): boolean {
    const definition = context.state.definitions.find(d => d.stableKey === target.key.stableKey);
    const option = definition && customFieldEntries(definition).find(f => f.localCode === target.key.fieldCode)?.options?.find(o => o.code === target.key.optionCode);
    if (!option)
        return false;
    return Object.entries(target.state.qualifiers).every(([name, value]) => {
        const q = option.qualifiers?.find(q => q.key === name);
        if (!q)
            return false;
        if (q.kind === 'graded')
            return typeof value === 'string' && q.options.includes(value);
        if (q.kind === 'enum')
            return typeof value === 'string' && q.options.some(o => o.code === value);
        if (q.kind === 'numeric')
            return typeof value === 'number' && value >= q.min && value <= q.max;
        return typeof value === 'object' && value !== null && Number.isInteger(value.from) && Number.isInteger(value.to) && value.from >= 1 && value.from <= 12 && value.to >= 1 && value.to <= 12 && typeof value.clockwise === 'boolean';
    });
}
function commandDependencies(staff: NonNullable<Awaited<ReturnType<DiagnosisFindingsEndpointDeps['authenticate']>>>, context: DiagnosisFindingContext, deps: DiagnosisFindingsEndpointDeps): FindingCommandDeps {
    if (!staff.fhir.createWithOutcome)
        throw new Error('Conditional create transport is required.');
    return { fhir: staff.fhir as FindingCommandDeps['fhir'], definitions: context.state.definitions, catalog: context.catalog, staffReference: staff.staffReference, now: deps.now };
}
export function findingCommandResponse(result: FindingCommandResult): Response {
    const causal = result.executionOrder.map(i => result.outcomes[i]).find(o => !['applied', 'unchanged', 'already-applied'].includes(o.status) && o.cause !== 'halted-by-earlier-target');
    let status = 200;
    if (causal) {
        status = causal.status === 'conflict' ? 409 : causal.status === 'refused' ? 422 : causal.status === 'unconfirmed' ? 502 : causal.cause === 'audit-repair' ? 503 : 502;
        if (causal.status === 'not-attempted' && (causal.cause === 'load' || causal.cause === 'refresh') && causal.fresh && 'incomplete' in causal.fresh)
            status = loadStatus(causal.fresh.kind);
    }
    return { status, body: { result: 'command', ...result, outcomes: result.outcomes.map(({ fresh, ...outcome }) => outcome) } };
}
export function materializeAtomicFindingCatalog(definitions: readonly ClinicalFindingDefinition[]): AtomicFindingCatalogRow[] {
    return definitions
        .filter((definition) => definition.active)
        .flatMap((definition) => customFieldEntries(definition).filter(field => ownsFact(definition, field)).flatMap((field) => field.options?.filter((option) => option.active).map((option): AtomicFindingCatalogRow => ({
        atomicFindingId: `${definition.stableKey}::${field.localCode}::${option.code}`,
        findingDefinitionId: definition.id,
        findingDefinitionKey: definition.stableKey,
        fieldCode: field.localCode,
        optionCode: option.code,
        display: option.display,
        sectionKey: definition.sectionKey ?? definition.stableKey,
        gradeScale: option.qualifiers
            ?.filter((qualifier) => qualifier.kind === "graded")
            .flatMap((qualifier) => qualifier.options) ?? [],
        diagnosisKeys: [...new Set((definition.diagnosisCandidates ?? [])
                .filter((candidate) => candidate.active && triggerIncludesOption(candidate.trigger, field.localCode, option.code))
                .flatMap((candidate) => {
                if (candidate.diagnosisKey !== undefined)
                    return [candidate.diagnosisKey];
                const mode = FAMILY_RESOLUTION_MODES[candidate.familyGroup];
                return mode?.mode === "staged" ? mode.members.map((member) => member.stableKey) : [];
            }))].sort(),
        origin: definition.sourceStatus === "local-practice" ? "custom" : "shipped",
    })) ?? []))
        .sort((left, right) => left.display.localeCompare(right.display) ||
        left.atomicFindingId.localeCompare(right.atomicFindingId));
}
function triggerIncludesOption(trigger: MappingTrigger, field: string, option: string): boolean {
    if (trigger.kind === "option")
        return trigger.field === field && trigger.anyOf.includes(option);
    if (trigger.kind === "qualifier")
        return trigger.field === field && trigger.option === option;
    if (trigger.kind === "allOf") {
        return trigger.triggers.some((nested) => triggerIncludesOption(nested, field, option));
    }
    return false;
}
function conditionLaterality(condition: Condition, encounterId: string): FindingLaterality {
    const recorded = condition.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
        ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code ??
        condition.bodySite?.flatMap((bodySite) => [
            ...(bodySite.coding ?? []).flatMap((coding) => coding.code ? [coding.code] : []),
            ...(bodySite.text ? [bodySite.text] : []),
        ]).find((value) => value === "OD" || value === "OS" || value === "OU" ||
            value === "right" || value === "left" || value === "bilateral");
    if (recorded === "OD" || recorded === "right")
        return "OD";
    if (recorded === "OS" || recorded === "left")
        return "OS";
    if (recorded === "OU" || recorded === "bilateral")
        return "OU";
    const value = condition.identifier?.find((identifier) => identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM && identifier.value?.startsWith(`${encounterId}::`))?.value?.split("::").at(-1);
    if (value === "right")
        return "OD";
    if (value === "left")
        return "OS";
    if (value === "bilateral")
        return "OU";
    return "UNKNOWN";
}
function isCurrentVisitDiagnosis(condition: Condition): boolean {
    if (!hasConditionCategory(condition, "encounter-diagnosis"))
        return false;
    const verification = condition.verificationStatus?.coding?.find((coding) => coding.system === FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM)?.code;
    return verification === "confirmed" ||
        verification === "provisional" ||
        verification === "differential" ||
        verification === "unconfirmed";
}
function conditionDiagnosisKey(condition: Condition, encounterId: string, diagnoses: readonly DiagnosisCatalogRow[]): string | undefined {
    const value = condition.identifier?.find((identifier) => identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM)?.value;
    return diagnoses.find((diagnosis) => value === diagnosis.stableKey || value?.startsWith(`${encounterId}::${diagnosis.stableKey}::`))?.stableKey;
}
function conditionReference(condition: Condition): string | undefined {
    return condition.id ? `Condition/${condition.id}` : undefined;
}
export async function handleDiagnosisFindingsMutationRequest(deps: DiagnosisFindingsEndpointDeps, input: {
    authHeader: string | undefined;
    params: unknown;
    body: unknown;
}): Promise<Response> {
    const staff = await deps.authenticate(input.authHeader);
    if (!staff)
        return { status: 401, body: { result: 'unauthenticated', error: 'Authentication required.' } };
    if (!staffHasBusinessAction(staff, 'chart.write'))
        return { status: 403, body: { result: 'forbidden', error: 'chart.write role required' } };
    const params = paramsSchema.safeParse(input.params), parsed = mutationSchema.safeParse(input.body);
    if (!params.success || !parsed.success) {
        const index = !parsed.success ? parsed.error.issues[0]?.path[1] : undefined;
        return invalid('Invalid finding command.', typeof index === 'number' ? index : undefined);
    }
    const body = parsed.data;
    const missing = body.targets.findIndex(t => !t.baseline);
    if (missing !== -1)
        return { status: 428, headers: { 'Cache-Control': 'no-store' }, body: { result: 'precondition', error: 'A finding baseline is required.', targetIndex: missing } };
    try {
        const definitions = await (deps.findingDefinitions?.() ?? new FhirFindingDefinitionStore(staff.fhir).list());
        const context = await loadDiagnosisFindingContext(staff.fhir, params.data.encounterId, definitions);
        if (context.incomplete)
            return unavailable(context);
        if (isClosedEncounter(context.encounter)) return invalid('encounter-closed');
        if (body.patientReference !== context.state.patientReference)
            return invalid('patient-mismatch');
        if (context.projection.preRebuild)
            return invalid('pre-rebuild-test-encounter');
        const writerDeps = commandDependencies(staff, context, deps);
        const command: FindingCommand = { commandId: body.commandId, patientReference: body.patientReference, encounterReference: context.state.encounterReference, surface: 'diagnosis-door', targets: body.targets };
        const ids = new Set<string>();
        const replay: boolean[] = [];
        for (const [index, target] of body.targets.entries()) {
            if (target.key.patientId !== body.patientReference.slice(8) || target.key.encounterId !== params.data.encounterId)
                return invalid('target-scope', index);
            if (ids.has(targetId(target.key)))
                return invalid('duplicate-target', index);
            ids.add(targetId(target.key));
            const definition = definitions.find(d => d.stableKey === target.key.stableKey);
            const field = definition && customFieldEntries(definition, true).find(f => f.localCode === target.key.fieldCode);
            if (!definition || !field || !ownsFact(definition, field)) return invalid('not-a-shared-finding', index);
            if (!context.catalog.some(row => row.atomicFindingId === catalogId(target.key)))
                return invalid('catalog-key', index);
            if (target.baseline?.kind === 'absent' && !equal(target.baseline.key, target.key))
                return invalid('baseline-key', index);
            const reason = findingTargetReadOnlyReason(context, target.key);
            if (reason)
                return invalid(reason, index);
            if (target.kind === 'fact') {
                if (!validQualifiers(context, target))
                    return invalid('qualifiers', index);
                if (target.state.homes.some(h => !domain(context).has(h)) || new Set(target.state.homes).size !== target.state.homes.length)
                    return invalid('home-outside-encounter', index);
            }
            let classification;
            try {
                classification = await classifyReplay({ ...context.state, fhir: writerDeps.fhir, staffReference: staff.staffReference }, command, target);
            }
            catch (error) {
                if (!(error instanceof FindingReplayLookupError))
                    throw error;
                return findingCommandResponse({ commandId: body.commandId, complete: false, executionOrder: [index, ...body.targets.map((_, i) => i).filter(i => i !== index)],
                    outcomes: body.targets.map((t, i) => ({ status: 'not-attempted', target: targetId(t.key), clinicalWrite: 'none', cause: i === index ? 'audit-lookup' : 'halted-by-earlier-target', reason: error.message })) });
            }
            if (classification === 'reused-with-different-content')
                return invalid('command-reused', index);
            replay.push(classification === 'exact-replay');
        }
        if (body.operation !== 'link' && (body.targets.length > 2 || new Set(body.targets.map(t => catalogId(t.key))).size !== 1))
            return invalid('operation-targets', 0);
        if (body.operation !== 'eye-change' && body.eyes)
            return invalid('unexpected-eyes', 0);
        const selected = body.context?.selectedConditionReference;
        if (selected && !context.state.conditions.some(c => `Condition/${c.id}` === selected && isCurrentVisitDiagnosis(c)))
            return invalid('selected-diagnosis', 0);
        if (body.operation === 'eye-change') {
            const failed = validateEyeChange(context, body, replay);
            if (failed)
                return failed;
        }
        if (body.operation === 'reassert' && replay.some(v => !v)) {
            const observationCarried: Record<string, boolean> = {};
            for (const condition of context.state.conditions.filter(isCurrentVisitDiagnosis)) {
                const carry = await readDiagnosisCarryState(staff.fhir, condition, context.state.observations, { preRebuild: context.projection.preRebuild });
                Object.assign(observationCarried, carry.observationCarried);
            }
            context.state.observationCarried = observationCarried;
            context.projection = projectCurrentFindings(context.state);
        }
        for (const [index, target] of body.targets.entries()) {
            if (replay[index])
                continue;
            const current = context.projection.currentFacts.find(f => f.projectionKey === targetId(target.key));
            if (body.operation === 'reassert') {
                if (target.kind !== 'reassert' || !current || current.status !== 'live' || !current.contributors.every(c => c.carried === true))
                    return invalid('reassert-requires-carried-live-fact', index);
                continue;
            }
            if (target.kind !== 'fact')
                return invalid('operation-target-kind', index);
            if (current?.status === 'retired' && !['assert', 'eye-change'].includes(body.operation))
                return invalid('retired-fact-operation', index);
            if (body.operation === 'eye-change')
                continue;
            if (body.operation === 'assert') {
                const homes = [...new Set([...(current?.status === 'live' ? liveHomes(context, current) : []), ...(selected ? [selected] : [])])];
                if (target.state.status !== 'live' || !sameHomes(target.state.homes, homes))
                    return invalid('assert-homes', index);
                continue;
            }
            if (!current || current.status !== 'live')
                return invalid('operation-requires-live-fact', index);
            const samePresence = target.state.presence === current.presence, sameQualifiers = equal(target.state.qualifiers, current.qualifiers), homes = sameHomes(target.state.homes, current.homes);
            if (body.operation === 'clear') {
                if (target.state.status !== 'retired' || !samePresence || !sameQualifiers || !homes)
                    return invalid('clear-keeps-state-and-homes', index);
            }
            else if (body.operation === 'grade') {
                const withoutGrade = ({ grade, ...rest }: Record<string, FindingQualifierValue>) => rest;
                if (target.state.status !== 'live' || !samePresence || !homes || !equal(withoutGrade(target.state.qualifiers), withoutGrade(current.qualifiers)))
                    return invalid('grade-only', index);
            }
            else {
                if (target.state.status !== 'live' || !samePresence || !sameQualifiers)
                    return invalid('homes-only', index);
                const expected = body.operation === 'standalone' ? [] : body.operation === 'move' ? (selected ? [selected] : []) : [...new Set([...liveHomes(context, current), ...(selected ? [selected] : [])])];
                if (body.operation !== 'standalone' && !selected)
                    return invalid('selected-diagnosis-required', index);
                if (!sameHomes(target.state.homes, expected))
                    return invalid('operation-homes', index);
            }
        }
        const response = findingCommandResponse(await executeFindingCommand(writerDeps, command));
        const closure = await observePostCommandClosure(() => staff.fhir.read<Encounter>('Encounter', params.data.encounterId));
        return { ...response, body: { ...(response.body as object), ...closure } };
    }
    catch (error) {
        return unavailable(dependencyState(error));
    }
}
function validateEyeChange(context: DiagnosisFindingContext, body: Mutation, replay: boolean[]): Response | undefined {
    if (!body.eyes)
        return invalid('explicit-eye-sets-required', 0);
    if (replay.every(Boolean))
        return;
    const key = body.targets[0].key, { from, to } = body.eyes;
    const facts = context.projection.currentFacts.filter(f => catalogId(f.key) === catalogId(key));
    const sources = from.map(eye => facts.find(f => f.eye === eye && (f.status === 'live' || body.targets.some((target, index) => replay[index] && target.key.eye === eye && target.kind === 'fact' && target.state.status === 'retired'))));
    const sample = sources.find(f => f !== undefined);
    if (!sample)
        return invalid('eye-source-missing', 0);
    const sameState = (fact: CurrentFindingFact) => fact.presence === sample.presence && equal(fact.qualifiers, sample.qualifiers);
    for (const eye of to.filter(eye => !from.includes(eye))) {
        const destination = facts.find(f => f.eye === eye && f.status === 'live');
        if (destination && !sameState(destination))
            return invalid('destination-differs', body.targets.findIndex(t => t.key.eye === eye));
    }
    if (sources.some(f => !f || !sameState(f)))
        return invalid('eye-sources-disagree', 0);
    if (facts.some(f => f.status === 'live' && !from.includes(f.eye) && !to.includes(f.eye)))
        return invalid('eye-from-mismatch', 0);
    const expected = new Set<string>();
    for (const eye of from.filter(eye => !to.includes(eye)))
        expected.add(eye);
    for (const eye of to.filter(eye => !from.includes(eye) && !facts.some(f => f.eye === eye && f.status === 'live')))
        expected.add(eye);
    for (const [index, target] of body.targets.entries()) {
        if (replay[index]) {
            expected.delete(target.key.eye);
            continue;
        }
        if (target.kind !== 'fact' || !expected.delete(target.key.eye))
            return invalid('eye-target-set', index);
        const current = facts.find(f => f.eye === target.key.eye), removed = from.includes(target.key.eye) && !to.includes(target.key.eye);
        const state = target.state;
        if (removed) {
            if (!current || state.status !== 'retired' || state.presence !== current.presence || !equal(state.qualifiers, current.qualifiers) || !sameHomes(state.homes, current.homes))
                return invalid('eye-retirement-state', index);
        }
        else if (state.status !== 'live' || state.presence !== sample.presence || !equal(state.qualifiers, sample.qualifiers) || !sameHomes(state.homes, sample.homes.filter(h => context.state.conditions.some(c => `Condition/${c.id}` === h && isCurrentVisitDiagnosis(c)))))
            return invalid('eye-added-state', index);
    }
    if (expected.size)
        return invalid('eye-target-missing', 0);
}
export async function handleDiagnosisFindingsAuditRepairRequest(deps: DiagnosisFindingsEndpointDeps, input: {
    authHeader: string | undefined;
    params: unknown;
    body: unknown;
}): Promise<Response> {
    const staff = await deps.authenticate(input.authHeader);
    if (!staff)
        return { status: 401, body: { result: 'unauthenticated', error: 'Authentication required.' } };
    if (!staffHasBusinessAction(staff, 'chart.write'))
        return { status: 403, body: { result: 'forbidden', error: 'chart.write role required' } };
    const params = paramsSchema.safeParse(input.params), body = z.object({ commandId: uuid, patientReference: patientReferenceSchema }).strict().safeParse(input.body);
    if (!params.success || !body.success)
        return invalid('Invalid audit repair command.');
    try {
        const definitions = await (deps.findingDefinitions?.() ?? new FhirFindingDefinitionStore(staff.fhir).list());
        const context = await loadDiagnosisFindingContext(staff.fhir, params.data.encounterId, definitions);
        if (context.incomplete)
            return unavailable(context);
        if (isClosedEncounter(context.encounter)) return invalid('encounter-closed');
        if (context.state.patientReference !== body.data.patientReference)
            return invalid('patient-mismatch');
        if (context.projection.preRebuild)
            return invalid('pre-rebuild-test-encounter');
        const response = findingCommandResponse(await repairPendingAudits(commandDependencies(staff, context, deps), { ...body.data, encounterReference: context.state.encounterReference }));
        const closure = await observePostCommandClosure(() => staff.fhir.read<Encounter>('Encounter', params.data.encounterId));
        return { ...response, body: { ...(response.body as object), ...closure } };
    }
    catch (error) {
        return unavailable(dependencyState(error));
    }
}
