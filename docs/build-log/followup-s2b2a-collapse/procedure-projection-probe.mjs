import assert from 'node:assert/strict';
import { fixture, AUTH, NOW, PATIENT, ENCOUNTER } from '../../../mcp/tests/encounterVoidFixture.ts';
import { ODOS_DISCIPLINE_SYSTEM } from '../../../mcp/src/scheduling/clinic-mode.ts';
import { buildProcedureDefinitionSeeds } from '../../../mcp/src/clinical-graph/procedure-definition-store.ts';
import { handleProcedureDefinitionCaptureRequest } from '../../../mcp/src/clinical-graph/procedure-definition-endpoint.ts';
import { handleExamOverviewRequest } from '../../../mcp/src/clinical-graph/exam-overview-endpoint.ts';

const { fhir, deps } = fixture({ role: 'provider' });
fhir.create = async (resource, headers) => (await fhir.createWithOutcome(resource, headers)).resource;
const encounter = await fhir.read('Encounter', 'e1');
fhir.replace({ ...encounter, serviceType: { coding: [{ system: ODOS_DISCIPLINE_SYSTEM, code: 'aesthetics' }] } });
const definition = buildProcedureDefinitionSeeds().find(row => row.discipline === 'aesthetics');
assert.ok(definition);
const before = await handleExamOverviewRequest(deps, { authHeader: AUTH, params: { encounterId: 'e1' } });
assert.equal(before.status, 200, JSON.stringify(before.body));
const saved = await handleProcedureDefinitionCaptureRequest({
  authenticate: deps.authenticate,
  now: () => NOW,
}, { authHeader: AUTH, params: { stableKey: definition.stableKey }, body: {
  patientReference: PATIENT, encounterReference: ENCOUNTER, remarks: 'Synthetic projection probe',
} });
assert.equal(saved.status, 201, JSON.stringify(saved.body));
assert.equal(fhir.all('Procedure').length, 1);
assert.equal(fhir.all('Observation').length, 0);
const searchStart = fhir.searches.length;
const after = await handleExamOverviewRequest(deps, { authHeader: AUTH, params: { encounterId: 'e1' } });
assert.equal(after.status, 200, JSON.stringify(after.body));
const searched = [...new Set(fhir.searches.slice(searchStart).map(row => row.resourceType))].sort();
assert.ok(!searched.includes('Procedure'));
assert.deepEqual(after.body.findings, before.body.findings);
console.log(JSON.stringify({
  editor: definition.stableKey,
  captureStatus: saved.status,
  savedProcedures: fhir.all('Procedure').length,
  savedObservations: fhir.all('Observation').length,
  overviewStatus: after.status,
  beforeFindings: before.body.findings.length,
  afterFindings: after.body.findings.length,
  overviewSearchedResourceTypes: searched,
  projectionUnchanged: true,
  limitation: 'Real endpoint functions with in-memory persistence; no live-server proof.',
}, null, 2));
