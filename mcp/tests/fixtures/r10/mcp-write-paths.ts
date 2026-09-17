import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Observation, Resource } from '@medplum/fhirtypes';
import * as attestation from '../../../src/fhir/scribeAttestation.js';
import * as policy from '../../../../policy/attestation-policy-urls.js';
import * as guards from '../../../src/clinical-graph/shared-finding-write-guard.js';
import * as extensions from '../../../src/fhir/ophthalmology/extensions.js';
import * as iop from '../../../src/fhir/ophthalmology/iop.js';
import * as va from '../../../src/fhir/ophthalmology/visualAcuity.js';
import * as refraction from '../../../src/fhir/ophthalmology/refraction.js';
import * as bodyStructure from '../../../src/fhir/ophthalmology/bodyStructure.js';
import * as sectionSave from '../../../src/fhir/ophthalmology/save-section-bundle.js';
import * as assets from '../../../src/fhir/ophthalmology/rawAssets.js';
import * as provenance from '../../../src/fhir/ophthalmology/provenance.js';
import * as smoking from '../../../src/fhir/smokingStatus.js';
import * as dryEyeTerminology from '../../../src/fhir/dryEyeTerminology.js';
import * as questionnaire from '../../../src/fhir/dryEyeQuestionnaireResponse.js';
import * as meibography from '../../../src/fhir/meibography.js';
import * as orthoK from '../../../src/fhir/orthoK.js';
import * as contactLens from '../../../src/fhir/contactLens.js';
import * as eyeGrowth from '../../../src/clinical-graph/eye-growth-endpoint.js';
import * as myopiaDefinition from '../../../src/clinical-graph/myopia-finding-definition.js';
import * as glaucoma from '../../../src/clinical-graph/glaucoma-suspect.js';
import { auditHeaders } from '../../../src/tools/audit.js';
import { FhirFindingDefinitionStore, buildFindingDefinitionResource } from '../../../src/clinical-graph/finding-definition-store.js';
import { materializeAtomicFindingCatalog } from '../../../src/clinical-graph/diagnosis-findings-endpoint.js';
import { executeFindingCommand, type FindingCommandTarget } from '../../../src/clinical-graph/current-finding-writer.js';
import { lens, lensField, nuclear, atomic, comp, snapshot, negative } from './factories.js';
import { currentFindingIdentifier, findingPanelIdentifier, findingPanelComponents, classifyFindingObservation } from '../../../src/clinical-graph/current-finding-identity.js';
import { buildFindingReadAliases } from '../../../src/clinical-graph/finding-read-aliases.js';
import { createMcpRuntimeTransport } from './mcp-runtime-transport.js';
import { classifyWriteTrace, type WritePathEvidence, type WriteTrace } from './write-path-recorder.js';

const at = '2026-09-16T12:00:00.000Z';
const practiceOption = 'synthetic-practice-option';
const practiceStableKey = 'synthetic-practice-shared';
const scope = { patient_id: 'p1', encounter_id: 'e1' };
const agent = { provenance_agent_reference: 'Practitioner/synthetic' };
const signature = { clinician_id: 'synthetic', signature_data_base64: Buffer.from('synthetic').toString('base64') };
const functionNames = ['createServer', 'toolJson', 'stripReference', 'buildCreateObservationResource', 'persistObservationBodyStructures', 'isBodyStructure', 'buildSectionSaveEntries', 'normalizeSectionLaterality', 'getStringArray', 'normalizeIopMethod', 'normalizeChartType', 'normalizeCorrection', 'normalizeRefractionType', 'normalizeSourceType', 'normalizeToolReference', 'createV035Provenance', 'buildV035ProvenanceResource', 'createV04Provenance'];
const variableNames = ['maybeStringArraySchema', 'isoTimestampSchema', 'provenanceControlSchema', 'v04ProvenanceAgentSchema', 'createObservationSchema', 'saveSectionObservationEntrySchema', 'saveSectionObservationsSchema', 'createSmokingStatusObservationSchema', 'createDryEyeQuestionnaireResponseSchema', 'createMeibographyObservationSchema', 'recordOrthoKFitObservationSchema', 'recordEyeGrowthAxialLengthMeasurementSchema', 'CREATE_OBSERVATION_AUDIT_HEADERS', 'SCRIBE_WRITE_OBSERVATION_AUDIT_HEADERS', 'CREATE_SECTION_OBSERVATIONS_AUDIT_HEADERS', 'CLINICIAN_ATTEST_OBSERVATION_AUDIT_HEADERS', 'AMEND_OBSERVATION_AUDIT_HEADERS', 'APPEND_OBSERVATION_CONTEXT_AUDIT_HEADERS'];
function dispatchCode(): string {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const counts = new Map([...functionNames, ...variableNames].map(name => [name, 0]));
  const pieces: string[] = [];
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && functionNames.includes(node.name?.text ?? '')) {
      const name = node.name!.text; counts.set(name, counts.get(name)! + 1); pieces.push(node.getText(source));
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && variableNames.includes(declaration.name.text)) {
          const name = declaration.name.text; counts.set(name, counts.get(name)! + 1); pieces.push(`const ${declaration.getText(source)};`);
        }
      }
    }
  }
  for (const [name, count] of counts) assert.equal(count, 1, `Exact production AST declaration: ${name}`);
  return ts.transpileModule(pieces.join('\n') + '\ncreateServer();', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
async function harness(scenarioId: string, injectedBody?: Observation) {
  const override = structuredClone(lens);
  const field = (override.valueSchema.fields as Record<string, { options: unknown[] }>)[lensField];
  field.options.push({ code: practiceOption, display: 'Synthetic practice-only option', active: true });
  const stored = buildFindingDefinitionResource({ ...override, sourceStatus: 'local-practice', display: 'Synthetic stored lens override' });
  stored.id = 'stored-lens-definition';
  const localOnly = buildFindingDefinitionResource({ ...override, stableKey: practiceStableKey, sectionKey: practiceStableKey, sourceStatus: 'local-practice', display: 'Synthetic practice-only shared definition' });
  localOnly.id = 'stored-practice-only-definition';
  const transport = createMcpRuntimeTransport([
    { resourceType: 'Patient', id: 'p1' },
    { resourceType: 'Encounter', id: 'e1', status: 'in-progress', class: {}, subject: { reference: 'Patient/p1' }, meta: { versionId: 'encounter-1' } },
    { resourceType: 'Practitioner', id: 'synthetic' },
    { resourceType: 'Device', id: 'lens' }, stored, localOnly,
  ] as Resource[], scenarioId);
  const findingDefinitionStore = new FhirFindingDefinitionStore(transport.fhir);
  const definitions = await findingDefinitionStore.list();
  assert.equal(definitions.find(d => d.stableKey === lens.stableKey)?.display, 'Synthetic stored lens override');
  assert.ok(materializeAtomicFindingCatalog(definitions).some(row => row.findingDefinitionKey === lens.stableKey && row.optionCode === practiceOption));
  assert.ok(definitions.some(definition => definition.stableKey === practiceStableKey));
  const auditRows: unknown[] = [];
  const context = { Server, CallToolRequestSchema, ListToolsRequestSchema, tools: [], console, Error, Buffer, z,
    ...attestation, ...policy, ...guards, ...extensions, ...iop, ...va, ...refraction, ...bodyStructure, ...sectionSave, ...assets, ...provenance,
    ...smoking, ...dryEyeTerminology, ...questionnaire, ...meibography, ...orthoK, ...contactLens, ...eyeGrowth, ...myopiaDefinition, ...glaucoma,
    auditHeaders, fhir: transport.fhir, findingDefinitionStore, sessionPractitionerId: () => 'synthetic',
    auditRuntime: { record: async (row: unknown, action: () => unknown) => { auditRows.push(structuredClone(row)); return action(); }, recordDenied: async (row: unknown) => { auditRows.push(structuredClone(row)); } },
  };
  const injection = injectedBody ? {
    buildCreateObservationResource: () => ({ resource: injectedBody, warnings: [] }),
    buildScribeDraftObservation: () => injectedBody,
    buildSectionSaveBundle: () => ({ resourceType: 'Bundle', type: 'transaction', entry: [{ resource: injectedBody, request: { method: 'POST', url: 'Observation' } }] }),
    buildSmokingStatusObservation: () => injectedBody, buildDryEyeQuestionnaireScoreObservation: () => injectedBody,
    buildMeibographyObservation: () => injectedBody, buildOrthoKFitObservation: () => injectedBody,
    buildMyopiaEyeCapture: () => ({ axialLength: { observation: injectedBody }, cornealRadius: { observation: injectedBody } }),
    buildAppendObservationTransaction: (input: Parameters<typeof attestation.buildAppendObservationTransaction>[0]) => ({ ...attestation.buildAppendObservationTransaction(input), observation: injectedBody }),
  } : {};
  // Only the explicit adversarial mode replaces builder output. Schemas and positive builders stay real.
  const code = injectedBody ? dispatchCode().replace('createServer();', 'Object.assign(globalThis, injectedBuilders);\ncreateServer();') : dispatchCode();
  const server: Server = runInNewContext(code, { ...context, injectedBuilders: injection });
  const client = new Client({ name: 'r10-a3-real-mcp-runtime', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  return { ...transport, definitions, auditRows, call: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }), close: async () => { await client.close(); await server.close(); } };
}

interface Scenario { id: string; tool: string; args: Record<string, unknown>; count: number; lifecycle?: 'attest' | 'amend'; }
const scenarios: Scenario[] = [
  { id: 'mcp-create-observation', tool: 'create_observation', args: { ...scope, ...agent, type: 'iop', laterality: 'OD', value: 15, method: 'GAT', measured_at: at, create_provenance: true }, count: 1 },
  { id: 'mcp-scribe-write', tool: 'scribe_write_observation', args: { ...scope, intended_observation_type: 'Synthetic section note', text: 'Synthetic text', scribe_id: 'synthetic', recorded_at: at }, count: 1 },
  { id: 'mcp-save-section', tool: 'save_section_observations', args: { ...scope, section: 'iop', entries: [{ laterality: 'OD', value: 15, method: 'GAT' }, { laterality: 'OS', value: 16, method: 'GAT' }] }, count: 2 },
  { id: 'mcp-append-context', tool: 'append_observation_context', args: { ...scope, ...signature, source_observation_id: 'source', intended_observation_type: 'Synthetic appended note', text: 'Synthetic text', recorded_at: at }, count: 1 },
  { id: 'mcp-attest', tool: 'clinician_attest_observation', args: { ...signature }, count: 2, lifecycle: 'attest' },
  { id: 'mcp-amend', tool: 'amend_observation', args: { ...signature, target_status: 'amended', amendment_text: 'Synthetic amendment' }, count: 2, lifecycle: 'amend' },
  { id: 'mcp-smoking-status', tool: 'create_smoking_status_observation', args: { patient_id: 'p1', ...agent, status_code: smoking.SMOKING_STATUS_CODES[0], effective_date_time: at, create_provenance: true }, count: 1 },
  { id: 'mcp-dry-eye-questionnaire-score', tool: 'create_dry_eye_questionnaire_response', args: { ...scope, ...agent, instrument: dryEyeTerminology.DRY_EYE_QUESTIONNAIRE_INSTRUMENTS[0], score: 3, authored: at }, count: 1 },
  { id: 'mcp-meibography', tool: 'create_meibography_observation', args: { ...scope, ...agent, eye: 'OD', lid: meibography.MEIBOGRAPHY_LIDS[0], scoring_system: meibography.MEIBOGRAPHY_SCORE_SYSTEMS[0], total_score: 3, content_type: 'image/png', data: Buffer.from('synthetic image').toString('base64'), effective_date_time: at }, count: 1 },
  { id: 'mcp-ortho-k-fit', tool: 'record_ortho_k_fit_observation', args: { ...scope, ...agent, lens_device_id: 'lens', finding_code: orthoK.ORTHO_K_FIT_FINDING_CODES[0], value_number: 1, effective_date_time: at }, count: 1 },
  { id: 'mcp-eye-growth', tool: 'record_eye_growth_axial_length_measurement', args: { ...scope, ...agent, eye: 'OD', value_mm: 24, corneal_radius_mm: 7.8, biometry_method: myopiaDefinition.BIOMETRY_METHODS[0], measured_at: at }, count: 2 },
];

function observations(trace: WriteTrace): Observation[] { return trace.persisted.filter(write => write.resource.resourceType === 'Observation').map(write => write.resource as Observation); }
function assertResolvedReferences(resource: Resource, resources: Map<string, Resource>) {
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'reference' && typeof item === 'string') {
        assert.ok(!item.startsWith('urn:uuid:') && !item.includes('/pending'), `Unresolved reference ${item}`);
        if (/^(BodyStructure|QuestionnaireResponse|DocumentReference|Observation)\//.test(item)) assert.ok(resources.has(item), `Missing persisted dependency ${item}`);
      } else visit(item);
    }
  };
  visit(resource);
}
export interface McpWritePathEvidence extends WritePathEvidence {
  controls: Array<WritePathEvidence['rejection']>;
  patchProjections: Array<{ reference: string; resource: Observation; kind: string }>;
  builderControls: Array<WriteTrace & { scenarioId: string; observations: WritePathEvidence['observations'] }>;
}
export async function runMcpWritePaths(): Promise<McpWritePathEvidence[]> {
  const rows: McpWritePathEvidence[] = [];
  for (const scenario of scenarios) {
    const h = await harness(`T22:${scenario.id}`);
    try {
      const setupStart = h.recorder.mark();
      const calls: Record<string, unknown>[] = [];
      const originals = new Map<string, Observation>();
      if (scenario.lifecycle) {
        const key = { v: 1 as const, patientId: 'p1', encounterId: 'e1', stableKey: lens.stableKey, eye: 'OD' as const };
        const factKey = { ...key, fieldCode: lensField, optionCode: practiceOption };
        const targets: FindingCommandTarget[] = [
          { kind: 'fact', key: factKey, baseline: { kind: 'absent', key: factKey }, state: { status: 'live', presence: 'present', qualifiers: {}, homes: [] } },
          { kind: 'panel', key, baseline: { kind: 'absent', key }, state: { deferred: false, values: {}, other: 'Synthetic panel context' } },
        ];
        const result = await executeFindingCommand({ fhir: h.fhir, definitions: h.definitions, catalog: materializeAtomicFindingCatalog(h.definitions), staffReference: 'Practitioner/synthetic', now: () => at }, { commandId: randomUUID(), patientReference: 'Patient/p1', encounterReference: 'Encounter/e1', surface: 'T22-mcp-setup', targets });
        assert.equal(result.complete, true, JSON.stringify(result));
        for (const outcome of result.outcomes) {
          assert.ok(outcome.reference); const original = h.resources.get(outcome.reference) as Observation;
          if (scenario.lifecycle === 'amend') {
            const attested = await h.call('clinician_attest_observation', { ...signature, observation_id: original.id });
            assert.equal(attested.isError, undefined, JSON.stringify(attested));
          }
          originals.set(outcome.reference, structuredClone(h.resources.get(outcome.reference) as Observation));
          calls.push({ ...scenario.args, observation_id: original.id });
        }
        const encounter = h.resources.get('Encounter/e1') as any; encounter.status = 'finished';
      } else {
        if (scenario.id === 'mcp-append-context') {
          const source: Observation = { resourceType: 'Observation', id: 'source', meta: { versionId: 'source-1' }, status: 'final', code: { text: 'Synthetic unrelated section note' }, subject: { reference: 'Patient/p1' }, encounter: { reference: 'Encounter/e1' } };
          h.resources.set('Observation/source', source); originals.set('Observation/source', structuredClone(source));
        }
        calls.push(scenario.args);
      }
      const setup = h.recorder.since(setupStart);
      const start = h.recorder.mark(); const transactionStart = h.transactions.length; const projectionStart = h.patchProjections.length;
      for (const args of calls) {
        const result = await h.call(scenario.tool, args);
        assert.equal(result.isError, undefined, `${scenario.id}: ${JSON.stringify(result)}`);
      }
      const trace = h.recorder.since(start);
      const saved = observations(trace); assert.equal(saved.length, scenario.count, `${scenario.id} persisted Observation count`);
      const observationWrites = trace.persisted.filter(write => write.resource.resourceType === 'Observation');
      assert.equal(new Set(observationWrites.map(write => write.writeId)).size, observationWrites.length, `${scenario.id} preserves per-write attribution`);
      const classifications = classifyWriteTrace(trace, h.definitions, scenario.id);
      const expectedKinds = scenario.lifecycle ? ['canonical-fact', 'panel-context'] : ['unrelated'];
      assert.deepEqual([...new Set(classifications.map(row => row.kind))].sort(), [...expectedKinds].sort(), scenario.id);
      if (!scenario.lifecycle) assert.ok(classifications.some(row => row.stage === 'attempted'), scenario.id);
      for (const write of trace.persisted) { assert.ok(write.resource.id); assert.ok(write.resource.meta?.versionId); assertResolvedReferences(write.resource, h.resources); }
      if (scenario.lifecycle) {
        for (const resource of saved) {
          const original = originals.get(`Observation/${resource.id}`)!;
          assert.equal(resource.status, scenario.lifecycle === 'attest' ? 'final' : 'amended');
          for (const field of ['identifier', 'component', 'extension', 'code', 'valueBoolean'] as const) assert.deepEqual(resource[field], original[field], `${scenario.id} preserves ${field}`);
          assert.notEqual(resource.meta?.versionId, original.meta?.versionId);
          if (scenario.lifecycle === 'amend') assert.ok(resource.note?.some(note => note.text === 'Synthetic amendment'));
        }
        assert.equal(trace.attempted.length, 4, 'Two lifecycle calls attempt exactly two Binary patches and two Provenance writes');
        const patchEntries = h.transactions.slice(transactionStart).flatMap(bundle => bundle.entry ?? []).filter(entry => entry.request?.method === 'PATCH');
        assert.equal(patchEntries.length, 2);
        for (const entry of patchEntries) { assert.equal(entry.resource?.resourceType, 'Binary'); assert.ok(entry.request?.ifMatch); }
        assert.equal(trace.persisted.filter(write => write.resource.resourceType === 'Provenance').length, 2);
      } else if (scenario.id === 'mcp-append-context') {
        assert.deepEqual(h.resources.get('Observation/source'), originals.get('Observation/source'));
        assert.equal(saved[0].status, 'final');
        assert.equal(trace.persisted.filter(write => write.resource.resourceType === 'Provenance').length, 1);
      } else if (scenario.id === 'mcp-save-section') {
        assert.equal(trace.persisted.filter(write => write.resource.resourceType === 'BodyStructure').length, 2);
        assert.equal(trace.persisted.filter(write => write.resource.resourceType === 'Provenance').length, 2);
        assert.equal(h.transactions.length - transactionStart, 1);
      } else if (scenario.id === 'mcp-scribe-write') {
        assert.equal(saved[0].status, 'preliminary'); assert.equal(trace.attempted[0].method, 'PUT'); assert.equal(h.auditRows.length, 1);
      } else {
        assert.equal(trace.persisted.filter(write => write.resource.resourceType === 'Provenance').length, scenario.id === 'mcp-eye-growth' ? 2 : 1);
        if (scenario.id === 'mcp-create-observation') assert.equal(trace.persisted.filter(write => write.resource.resourceType === 'BodyStructure').length, 1);
        if (scenario.id === 'mcp-smoking-status') assert.equal(saved[0].encounter, undefined);
        if (scenario.id === 'mcp-ortho-k-fit') assert.deepEqual(saved[0].focus, [{ reference: 'Device/lens' }]);
        if (scenario.id === 'mcp-dry-eye-questionnaire-score' || scenario.id === 'mcp-meibography') {
          const type = scenario.id === 'mcp-meibography' ? 'DocumentReference' : 'QuestionnaireResponse';
          const dependency = trace.persisted.find(write => write.resource.resourceType === type)!.resource;
          assert.deepEqual(saved[0].derivedFrom, [{ reference: `${type}/${dependency.id}` }]);
        }
      }
      const rejectionStart = h.recorder.mark();
      const rejected = await h.call(scenario.tool, {});
      assert.equal(rejected.isError, true, `${scenario.id} requires its production schema`);
      const refusal = h.recorder.since(rejectionStart); assert.equal(refusal.attempted.length, 0); assert.equal(refusal.persisted.length, 0);
      const schemaControl = { ...refusal, scenarioId: `T22:${scenario.id}:invalid-public-schema`, responseStatus: 400, reason: JSON.stringify(rejected) };
      const builderControls = await positiveBuilderControls(scenario, h);
      const controls = await sharedBodyControls(scenario);
      controls.push(schemaControl);
      const catalog = materializeAtomicFindingCatalog(h.definitions);
      const aliases = buildFindingReadAliases(h.definitions, catalog);
      const patchProjections = h.patchProjections.slice(projectionStart).map(projected => {
        const kind = classifyFindingObservation(projected.resource, h.definitions, catalog, aliases).kind;
        assert.ok(['canonical-fact', 'panel-context'].includes(kind));
        return { reference: projected.reference, resource: projected.resource, kind };
      });
      rows.push({ id: scenario.id, scenarioId: `T22:${scenario.id}`, handler: scenario.tool, responseStatus: 200, ...trace, observations: classifications, setup, controls, patchProjections, builderControls, rejection: controls[0] });
    } finally { await h.close(); }
  }
  return rows;
}

function sharedBodies(): Array<[string, Observation]> {
  const key = { v: 1 as const, patientId: 'p1', encounterId: 'e1', stableKey: lens.stableKey, fieldCode: lensField, optionCode: nuclear.optionCode, eye: 'OD' as const };
  const panelKey = { v: 1 as const, patientId: 'p1', encounterId: 'e1', stableKey: lens.stableKey, eye: 'OD' as const };
  return [
    ['canonical', { ...atomic('shared'), identifier: [currentFindingIdentifier(key)], component: [comp('R10_CURRENT_META', JSON.stringify(key))] }],
    ['panel', { ...snapshot('shared', []), identifier: [findingPanelIdentifier(panelKey)], component: [comp('R10_PANEL_META', JSON.stringify(panelKey)), ...findingPanelComponents({ deferred: false, values: {}, other: 'Synthetic context' }, lens)] }],
    ['negative', negative()], ['legacy-shared', snapshot('shared')],
    ['stored-only-shared', { ...snapshot('shared'), code: extensions.odosConcept(practiceStableKey) }],
  ];
}
async function sharedBodyControls(scenario: Scenario): Promise<Array<WritePathEvidence['rejection']>> {
  const controls: Array<WritePathEvidence['rejection']> = [];
  const cases: Array<{ mode: string; body: Observation; injected: boolean }> = scenario.lifecycle
    ? [{ mode: 'legacy-target-refusal', body: snapshot('shared'), injected: false }]
    : scenario.id === 'mcp-append-context'
      ? sharedBodies().flatMap(([kind, body]) => [{ mode: `${kind}-shared-source`, body, injected: false }, { mode: `adversarial-${kind}-shared-result`, body, injected: true }])
      : sharedBodies().map(([kind, body]) => ({ mode: `adversarial-${kind}-output`, body, injected: true }));
  for (const item of cases) {
    const id = `T22:${scenario.id}:${item.mode}`;
    const h = await harness(id, item.injected ? item.body : undefined);
    try {
      let args = { ...scenario.args };
      if (scenario.lifecycle) {
        h.resources.set('Observation/shared', { ...item.body, status: scenario.lifecycle === 'amend' ? 'final' : 'preliminary' });
        args.observation_id = 'shared';
      } else if (scenario.id === 'mcp-append-context') {
        const source: Observation = item.injected
          ? { resourceType: 'Observation', id: 'source', meta: { versionId: 'source-1' }, status: 'final', code: { text: 'Synthetic unrelated source' }, subject: { reference: 'Patient/p1' }, encounter: { reference: 'Encounter/e1' } }
          : { ...item.body, id: 'source', status: 'final' };
        h.resources.set('Observation/source', source);
      }
      const mark = h.recorder.mark();
      const result = await h.call(scenario.tool, args);
      assert.equal(result.isError, true, `${id}: ${JSON.stringify(result)}`);
      assert.match(JSON.stringify(result), /Shared findings are charted in the finding doors/, id);
      const trace = h.recorder.since(mark); assert.equal(trace.attempted.length, 0, id); assert.equal(trace.persisted.length, 0, id);
      controls.push({ ...trace, scenarioId: id, responseStatus: 409, reason: JSON.stringify(result) });
    } finally { await h.close(); }
  }
  return controls;
}

async function positiveBuilderControls(scenario: Scenario, h: Awaited<ReturnType<typeof harness>>): Promise<McpWritePathEvidence['builderControls']> {
  const cases: Array<{ name: string; args: Record<string, unknown>; count: number }> = [];
  if (scenario.id === 'mcp-create-observation') {
    cases.push({ name: 'visual-acuity-builder', args: { ...scope, ...agent, type: 'va', laterality: 'OD', snellen: '20/20', measured_at: at }, count: 1 });
    cases.push({ name: 'refraction-builder', args: { ...scope, ...agent, type: 'refraction', laterality: 'OD', sphere: -1, cylinder: -0.5, axis: 90, measured_at: at }, count: 1 });
  } else if (scenario.id === 'mcp-save-section') {
    cases.push({ name: 'conditional-body-structure-reuse', args: scenario.args, count: 2 });
    cases.push({ name: 'visual-acuity-section', args: { ...scope, section: 'va', entries: [{ laterality: 'OD', snellen: '20/20' }] }, count: 1 });
    cases.push({ name: 'refraction-section', args: { ...scope, section: 'refraction', entries: [{ laterality: 'OD', sphere: -1, cylinder: -0.5, axis: 90 }] }, count: 1 });
  } else if (scenario.id === 'mcp-eye-growth') {
    const { corneal_radius_mm: _radius, ...args } = scenario.args;
    cases.push({ name: 'axial-only-optional-radius', args, count: 1 });
  }
  const controls: McpWritePathEvidence['builderControls'] = [];
  for (const item of cases) {
    const mark = h.recorder.mark();
    const result = await h.call(scenario.tool, item.args);
    assert.equal(result.isError, undefined, `${item.name}: ${JSON.stringify(result)}`);
    const trace = h.recorder.since(mark);
    assert.equal(observations(trace).length, item.count, item.name);
    const classified = classifyWriteTrace(trace, h.definitions, item.name);
    assert.ok(classified.length > 0); assert.ok(classified.every(row => row.kind === 'unrelated'));
    for (const write of trace.persisted) assertResolvedReferences(write.resource, h.resources);
    if (item.name === 'conditional-body-structure-reuse') {
      assert.equal(trace.attempted.filter(write => write.resource.resourceType === 'BodyStructure').length, 2);
      assert.equal(trace.persisted.filter(write => write.resource.resourceType === 'BodyStructure').length, 0);
    }
    if (item.name === 'axial-only-optional-radius') assert.equal(trace.persisted.filter(write => write.resource.resourceType === 'Provenance').length, 1);
    controls.push({ ...trace, scenarioId: `T22:${scenario.id}:${item.name}`, observations: classified });
  }
  return controls;
}
