import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { fixture, AUTH, NOW, PATIENT, ENCOUNTER, complaintResource, writeFinding } from '../../../mcp/tests/encounterVoidFixture.ts';
import { buildFindingDefinitionSeeds, FhirFindingDefinitionStore } from '../../../mcp/src/clinical-graph/finding-definition-store.ts';
import { handleIopCaptureRequest, resolveIopDefinitions } from '../../../mcp/src/clinical-graph/iop-endpoint.ts';
import { handleCupDiscCaptureRequest, resolveCupDiscDefinition } from '../../../mcp/src/clinical-graph/cup-disc-endpoint.ts';
import { handleAutoRefractionCaptureRequest, resolveAutoRefractionDefinitions } from '../../../mcp/src/clinical-graph/pretest-endpoint.ts';
import { buildEntranceFindingDefinitions, COVER_TEST_KEY, MANUAL_K_KEY } from '../../../mcp/src/clinical-graph/entrance-definition.ts';
import { handleCoverTestCaptureRequest } from '../../../mcp/src/clinical-graph/cover-test-endpoint.ts';
import { HPI_STABLE_KEY } from '../../../mcp/src/clinical-graph/hpi-definition.ts';
import { handleHpiCaptureRequest } from '../../../mcp/src/clinical-graph/hpi-endpoint.ts';
import { DRY_EYE_TEAR_VOLUME_KEY } from '../../../mcp/src/clinical-graph/dry-eye-finding-definition.ts';
import { handleCustomSectionCaptureRequest } from '../../../mcp/src/clinical-graph/custom-section-endpoint.ts';
import { handleFindingDefinitionCreationRequest } from '../../../mcp/src/clinical-graph/finding-definition-endpoint.ts';
import { customFieldEntries } from '../../../mcp/src/clinical-graph/custom-fields.ts';
import { materializeAtomicFindingCatalog } from '../../../mcp/src/clinical-graph/diagnosis-findings-endpoint.ts';
import { handleExamOverviewRequest } from '../../../mcp/src/clinical-graph/exam-overview-endpoint.ts';
import { handleEncounterVoidRequest } from '../../../mcp/src/clinical-graph/encounter-void-endpoint.ts';

const provenance = { source: 'manual', recordedAt: NOW, actorReference: 'Practitioner/doc1' };
const entrance = buildEntranceFindingDefinitions(provenance);
export const writerKeys = {
  iop: resolveIopDefinitions().intraocularPressure.stableKey,
  'cup-disc': resolveCupDiscDefinition().stableKey,
  'auto-refraction': resolveAutoRefractionDefinitions().autoRefraction.stableKey,
  'cover-test': COVER_TEST_KEY,
  'manual-keratometry': MANUAL_K_KEY,
  'color-vision': entrance.find(row => row.display === 'Color vision').stableKey,
  stereopsis: entrance.find(row => row.display === 'Stereopsis').stableKey,
  hpi: HPI_STABLE_KEY,
};

export async function proveEditor(editor) {
  const { fhir, deps } = fixture();
  fhir.create = async (resource, headers) => (await fhir.createWithOutcome({ ...resource, id: undefined }, headers)).resource;
  const transaction = fhir.executeTransaction.bind(fhir);
  fhir.executeTransaction = async bundle => transaction({ ...bundle, entry: bundle.entry?.map(entry => {
    if (entry.request?.method !== 'PUT' || !entry.request.url?.startsWith('Observation?identifier=')) return entry;
    const identifier = entry.resource.identifier[0];
    const existing = fhir.all('Observation').find(row => row.identifier?.some(value => value.system === identifier.system && value.value === identifier.value));
    return { ...entry, request: existing ? { ...entry.request, url: `Observation/${existing.id}` } : { method: 'POST', url: 'Observation' } };
  }) });
  let definitions = buildFindingDefinitionSeeds();
  let key = writerKeys[editor] ?? editor;
  if (editor === 'custom:synthetic') {
    const created = await handleFindingDefinitionCreationRequest({
      authenticate: async () => ({ staffReference: 'Practitioner/doc1', actorRole: 'admin', fhir }),
      now: () => NOW, shortId: () => 's2b2a000',
    }, { authHeader: AUTH, body: { action: 'create-definition', display: 'Synthetic measurement', perEye: false,
      fields: [{ display: 'Synthetic value', valueType: 'number' }] } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    key = created.body.definition.stableKey;
    definitions = await new FhirFindingDefinitionStore(fhir).list();
  }
  const definition = definitions.find(row => row.stableKey === key);
  assert.ok(definition, `real definition missing for ${editor}`);
  deps.findingDefinitions = () => definitions;
  const input = { authHeader: AUTH, body: { patientReference: PATIENT, encounterReference: ENCOUNTER } };
  const overview = async () => {
    const result = await handleExamOverviewRequest(deps, { authHeader: AUTH, params: { encounterId: 'e1' } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const before = await overview();
  let result;
  if (editor === 'iop') result = await handleIopCaptureRequest(deps, { ...input, body: { ...input.body, eyes: { OD: { value: 17, method: 'GAT', date: NOW.slice(0,10), timeOfDay: '09:00' } } } });
  else if (editor === 'cup-disc') result = await handleCupDiscCaptureRequest(deps, { ...input, body: { ...input.body, eyes: { OD: { verticalCupDiscRatio: 0.3 } } } });
  else if (editor === 'auto-refraction') result = await handleAutoRefractionCaptureRequest(deps, { ...input, body: { ...input.body, eyes: { OD: { sphere: -1 } } } });
  else if (editor === 'cover-test') result = await handleCoverTestCaptureRequest(deps, { ...input, body: { ...input.body, rows: [{ slot: 'distance-cc', state: 'ortho' }] } });
  else if (editor === 'hpi') {
    fhir.add(complaintResource('synthetic', 1));
    result = await handleHpiCaptureRequest(deps, { ...input, body: { ...input.body, templateAnswers: [], reviewAttestations: ['general'] } });
  } else if (key.startsWith('ocular-health:')) {
    const option = materializeAtomicFindingCatalog(definitions).find(row => row.findingDefinitionKey === key);
    assert.ok(option, 'a real stored catalog option must exist');
    const findingKey = { v: 1, patientId: 'p1', encounterId: 'e1', stableKey: key,
      fieldCode: option.fieldCode, optionCode: option.optionCode, eye: 'OD' };
    const written = await writeFinding(fhir, { kind: 'fact', key: findingKey, baseline: { kind: 'absent', key: findingKey },
      state: { status: 'live', presence: 'present', qualifiers: {}, homes: [] } }, definitions);
    assert.equal(written.complete, true, JSON.stringify(written));
    result = { status: 200 };
  } else {
    const fields = customFieldEntries(definition);
    const values = editor === 'manual-keratometry' ? [{ code: 'CUSTOM_FLAT_K', value: 43 }, { code: 'CUSTOM_FLAT_AXIS', value: 180 }, { code: 'CUSTOM_STEEP_K', value: 44 }, { code: 'CUSTOM_STEEP_AXIS', value: 90 }] :
      key === DRY_EYE_TEAR_VOLUME_KEY ? [{ code: 'CUSTOM_SCHIRMER_MM', value: 12 }] :
      editor.startsWith('custom:') ? [{ code: fields[0].localCode, value: 12 }] : [];
    const state = definition.valueSchema.type === 'entrance-state-section' ? { state: 'normal' } : {};
    result = await handleCustomSectionCaptureRequest(deps, { ...input, params: { stableKey: key }, body: { ...input.body,
      ...(definition.valueSchema.perEye ? { eyes: { OD: { customFields: values, ...state } } } : { customFields: values, ...state }),
    } });
  }
  assert.equal(result.status, 200, `save ${editor}: ${JSON.stringify(result.body)}`);
  const saved = await overview();
  const found = saved.findings.find(row => row.findingKey === key);
  assert.ok(found, `saved ${editor} (${key}) must reach the real overview`);
  const cleared = await handleEncounterVoidRequest(deps, { authHeader: AUTH, params: { encounterId: 'e1' },
    body: { scope: 'section', sectionKey: definition.sectionKey } });
  assert.equal(cleared.status, 200, `clear ${editor}: ${JSON.stringify(cleared.body)}`);
  assert.ok(cleared.body.count > 0, `clear ${editor} must retire saved content`);
  const after = await overview();
  assert.equal(after.findings.some(row => row.findingKey === key), false, `cleared ${editor} must leave projection`);
  return { editor, key, before, saved, after, savedResourceKinds: [...new Set([...fhir.writes.map(row => row.resource.resourceType), ...fhir.transactions.flatMap(bundle => bundle.entry?.map(entry => entry.resource?.resourceType) ?? [])].filter(Boolean))].sort() };
}

export const proofEditors = [...Object.keys(writerKeys), 'ocular-health:anterior:cornea', DRY_EYE_TEAR_VOLUME_KEY, 'custom:synthetic'];
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const editor of proofEditors) {
    try {
      const proof = await proveEditor(editor);
      console.log(JSON.stringify({ editor, key: proof.key, saved: proof.saved.findings.length, afterClear: proof.after.findings.length, savedResourceKinds: proof.savedResourceKinds }));
    } catch (error) { console.log(JSON.stringify({ editor, failure: error.message })); }
  }
}
