import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ServiceRequest } from '@medplum/fhirtypes';
import { loadVerifiedOperatorFhirClient } from '../../../scripts/operator-identity.ts';
import { ProtocolBasicStore, PROTOCOL_BASIC_CODES } from '../../../mcp/src/clinical-graph/protocol-store.ts';
import type { ChargeProposal, PlanActionInstance } from '../../../mcp/src/clinical-graph/protocol-types.ts';

const fixture = JSON.parse(readFileSync(`${process.env.W1_RUNTIME_DIR}/w1-live-fixture.json`, 'utf8'));
const projectId = process.env.MEDPLUM_PROJECT_ID;
assert.ok(projectId);
const seeder = await loadVerifiedOperatorFhirClient({ baseUrl: 'http://localhost:18103/', projectId, postgresUrl: process.env.W1_MEDPLUM_POSTGRES_URL });
const actions = await new ProtocolBasicStore<PlanActionInstance>(seeder.fhir, PROTOCOL_BASIC_CODES.planActionInstance).list();
const charges = await new ProtocolBasicStore<ChargeProposal>(seeder.fhir, PROTOCOL_BASIC_CODES.chargeProposal).list();
for (const role of ['provider', 'composite'] as const) {
  const encounterId = fixture[`${role}Encounter`];
  const orders = await seeder.fhir.search<ServiceRequest>('ServiceRequest', { encounter: `Encounter/${encounterId}` });
  const liveOrders = orders.entry?.flatMap(entry => entry.resource?.encounter?.reference === `Encounter/${encounterId}` ? [entry.resource] : []) ?? [];
  const liveActions = actions.filter(row => row.encounterId === encounterId && row.state !== 'removed');
  const acceptedCharges = charges.filter(row => row.encounterId === encounterId && row.state === 'accepted');
  assert.equal(liveOrders.length, 1, `${role} ServiceRequest count`);
  assert.equal(liveActions.length, 1, `${role} plan action count`);
  assert.equal(acceptedCharges.length, 1, `${role} accepted charge count`);
  const token = readFileSync(`${process.env.W1_RUNTIME_DIR}/w1-${role}-token`, 'utf8');
  const response = await fetch(`http://127.0.0.1:3334/clinical-graph/encounters/${encounterId}/follow-up-queue`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const queue = await response.json() as { rows: Array<{ orderable: string; state: string; charge?: { status: string } }>; diagnoses?: Array<{ matches: boolean }> };
  const photo = queue.rows.find(row => row.orderable === 'fundus-photography');
  assert.equal(photo?.state, 'already-ordered');
  assert.equal(photo?.charge?.status, 'billed');
  assert.equal(queue.diagnoses?.[0]?.matches, true);
  console.log(`${role}: ServiceRequest=1 plan-action=1 accepted-charge=1 row=already-ordered diagnosis-match=true`);
}
