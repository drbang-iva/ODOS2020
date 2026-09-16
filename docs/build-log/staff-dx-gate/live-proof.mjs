import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture as helper, sourceRoot } from './fixture.mjs';
import { authenticateStaffRoute } from '../../../mcp/src/payments/payment-endpoint.ts';
import { handleDiagnosisPickRequest } from '../../../mcp/src/clinical-graph/diagnosis-pick-endpoint.ts';
import { handleDiagnosisFindingsReadRequest, handleDiagnosisFindingsMutationRequest } from '../../../mcp/src/clinical-graph/diagnosis-findings-endpoint.ts';
import { handleDiagnosisOrderRequest, handleDiagnosisProblemStatusRequest } from '../../../mcp/src/clinical-graph/diagnosis-order-endpoint.ts';
import { handleDiagnosisVisitStatusUpdateRequest } from '../../../mcp/src/clinical-graph/diagnosis-visit-status-endpoint.ts';
import { handleDiagnosisNewnessUpdateRequest } from '../../../mcp/src/clinical-graph/diagnosis-newness-endpoint.ts';
import { PgDiagnosisVisitStatusStore } from '../../../mcp/src/clinical-graph/diagnosis-visit-status-store.ts';
import { buildDiagnosisCatalogSeeds } from '../../../mcp/src/clinical-graph/diagnosis-catalog-seeds.ts';
import { MDM_PROBLEM_STATUSES } from '../../../mcp/src/fhir/condition.ts';

const fixture = await helper.refreshFixtureTokens();
const { audit, serviceFhir } = await helper.createLiveClients(fixture);
const store = new PgDiagnosisVisitStatusStore({ postgresUrl: fixture.postgresUrl });
const writes = [];
const report = {
  kind: 'Author live handler proof with verified caller identities and real Medplum AccessPolicy enforcement',
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries([
    'mcp/src/authz/roles.ts', 'mcp/src/clinical-graph/diagnosis-pick-endpoint.ts',
    'mcp/src/clinical-graph/diagnosis-findings-endpoint.ts', 'mcp/src/clinical-graph/diagnosis-order-endpoint.ts',
  ].map(path => [path, createHash('sha256').update(readFileSync(resolve(sourceRoot, path))).digest('hex')])),
  cases: [], identities: [], limits: ['Handler invocation; HTTP registration is checked separately.', 'The provider identity is a real provider+staff+admin composite membership.'],
};
const trackedMethods = new Set(['create', 'update', 'patch', 'delete', 'executeTransaction']);
async function authenticate(authHeader) {
  const staff = await authenticateStaffRoute({ baseUrl: fixture.baseUrl, authHeader, serviceClient: serviceFhir, audit });
  if (!staff) return null;
  const fhir = new Proxy(staff.fhir, { get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return (...args) => {
      if (trackedMethods.has(key)) writes.push({ actor: staff.staffReference, method: key, resourceType: typeof args[0] === 'string' ? args[0] : args[0]?.resourceType });
      return value.apply(target, args);
    };
  } });
  return { ...staff, fhir };
}
const auth = name => `Bearer ${fixture.principals[name].token}`;
const deps = { authenticate, diagnosisVisitStatusStore: store, store, fhirBaseUrl: fixture.baseUrl };
const read = (type, id) => helper.successfulHttp(fixture, 'GET', `/fhir/R4/${type}/${id}`);
async function snapshot() {
  const result = {};
  for (const type of ['Condition', 'Observation', 'Encounter', 'Provenance']) {
    const bundle = await helper.successfulHttp(fixture, 'GET', `/fhir/R4/${type}?_count=1000`);
    result[type] = (bundle.entry ?? []).map(row => `${row.resource.id}/${row.resource.meta.versionId}`).sort();
  }
  return result;
}
async function run(label, handler, name, params, body, expected, zeroWrites = false) {
  const before = zeroWrites ? await snapshot() : undefined;
  const start = writes.length;
  const response = await handler(deps, { authHeader: auth(name), params, body });
  const observed = writes.slice(start);
  if (zeroWrites) {
    assert.equal(observed.length, 0, `${label}: attempted FHIR writes`);
    assert.deepEqual(await snapshot(), before, `${label}: persisted resource state`);
  }
  assert.equal(response.status, expected, `${label}: ${JSON.stringify(response.body)}`);
  report.cases.push({ label, status: response.status, attemptedWrites: observed, unchangedResourceVersions: zeroWrites });
  return response.body;
}
try {
  for (const name of ['staff', 'composite']) {
    const caller = await authenticate(auth(name));
    assert.equal(caller.businessActions.includes('chart.diagnosis.write'), name === 'composite');
    report.identities.push({ name, roles: caller.roles, canWriteDiagnosis: caller.businessActions.includes('chart.diagnosis.write') });
  }
  // Reuse the existing seeded encounter class literal instead of introducing a clinical code.
  const seedSource = readFileSync(resolve(sourceRoot, 'src/index.ts'), 'utf8');
  const encounterClass = seedSource.match(/class:\s*\{\s*system:\s*"([^"]+)",\s*code:\s*"([^"]+)"/);
  assert.ok(encounterClass, 'Existing encounter class seed must be available');
  const encounter = await helper.successfulHttp(fixture, 'POST', '/fhir/R4/Encounter', { body: {
    resourceType: 'Encounter', meta: { project: fixture.projectA }, status: 'in-progress', period: { start: new Date().toISOString() },
    class: { system: encounterClass[1], code: encounterClass[2] }, subject: { reference: `Patient/${fixture.patientId}` },
  } });
  const params = { encounterId: encounter.id };
  const findingPayload = await handleDiagnosisFindingsReadRequest(deps, { authHeader: auth('composite'), params, query: {} });
  assert.equal(findingPayload.status, 200);
  const diagnoses = buildDiagnosisCatalogSeeds();
  const atomic = findingPayload.body.catalog.find(row => row.diagnosisKeys.some(key => diagnoses.some(dx => dx.stableKey === key && dx.active && dx.icd10Code)));
  assert.ok(atomic, 'An existing diagnosis-linked atomic finding must be available');
  const diagnosisKey = atomic.diagnosisKeys.find(key => diagnoses.some(dx => dx.stableKey === key && dx.active && dx.icd10Code));
  await run('staff pick refuses before any resource write', handleDiagnosisPickRequest, 'staff', params, { diagnosisKey, action: 'confirm', laterality: 'OD' }, 403, true);
  await run('provider confirm retains Condition and Encounter attachment', handleDiagnosisPickRequest, 'composite', params, { diagnosisKey, action: 'confirm', laterality: 'OD' }, 201);
  const currentEncounter = await read('Encounter', encounter.id);
  const conditionReference = currentEncounter.diagnosis[0].condition.reference;
  const conditionId = conditionReference.slice('Condition/'.length);
  assert.ok(conditionReference);
  const assertion = { action: 'assert', patientReference: `Patient/${fixture.patientId}`, conditionReference, atomicFindingId: atomic.atomicFindingId, presence: 'present', laterality: 'OD' };
  await run('staff assertion refuses before Observation creation', handleDiagnosisFindingsMutationRequest, 'staff', params, assertion, 403, true);
  await run('provider assertion creates Observation and retains Condition evidence', handleDiagnosisFindingsMutationRequest, 'composite', params, assertion, 200);
  const condition = await read('Condition', conditionId);
  assert.ok(condition.evidence?.some(row => row.detail?.some(detail => detail.reference?.startsWith('Observation/'))));
  for (const [label, handler, body] of [
    ['visit status', handleDiagnosisVisitStatusUpdateRequest, { status: 'stable' }],
    ['newness', handleDiagnosisNewnessUpdateRequest, { value: 'established' }],
    ['complexity', handleDiagnosisProblemStatusRequest, { problemStatus: MDM_PROBLEM_STATUSES[0].code, expectedEncounterVersion: currentEncounter.meta.versionId }],
  ]) {
    await run(`staff ${label} refuses before writes`, handler, 'staff', { ...params, conditionId }, body, 403, true);
    await run(`provider ${label} succeeds`, handler, 'composite', { ...params, conditionId }, body, 200);
  }
  await run('staff reorder refuses before writes', handleDiagnosisOrderRequest, 'staff', params, { conditionReferences: [conditionReference] }, 403, true);
  await run('provider reorder succeeds', handleDiagnosisOrderRequest, 'composite', params, { conditionReferences: [conditionReference] }, 200);
  const native = await helper.http(fixture, 'PUT', `/fhir/R4/Condition/${conditionId}`, {
    token: fixture.principals.staff.token, body: condition, principal: 'staff', scenario: 'native Condition write denied by unchanged AccessPolicy',
  });
  assert.equal(native.status, 403);
  report.cases.push({ label: 'native staff Condition update rejected by Medplum', status: native.status });
  report.synthetic = { patientId: fixture.patientId, encounterId: encounter.id, conditionId, diagnosisKey, atomicFindingId: atomic.atomicFindingId };
  writeFileSync(resolve(sourceRoot, '.odos/staff-dx-gate/browser-case.json'), JSON.stringify(report.synthetic), { mode: 0o600 });
  helper.writeEvidence('live-proof.json', report);
  console.log(JSON.stringify({ cases: report.cases.length, outcomes: report.cases.map(row => ({ label: row.label, status: row.status, writes: row.attemptedWrites?.length })) }));
} finally {
  await store.close();
  await audit.close();
}
