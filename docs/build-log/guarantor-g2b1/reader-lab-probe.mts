import assert from 'node:assert/strict';
import { createLabOrderDispatch } from '../../../mcp/src/lab-orders/lab-order-dispatch.ts';
import { handleSubmitLabOrderRequest, handleLabOrderWorklistRequest } from '../../../mcp/src/lab-orders/lab-order-handlers.ts';

const operation = {
  resourceType: 'Task', id: 'guarantor-operation-synthetic', status: 'in-progress', intent: 'order',
  code: { coding: [{ system: 'https://odos2020.com/fhir/CodeSystem/guarantor-link-operation', code: 'transfer' }] },
  businessStatus: { text: 'claiming' },
  requester: { reference: 'Practitioner/synthetic-staff' },
  input: [{ type: { text: 'kind' }, valueCode: 'transfer' }],
};
const stored = new Map([[operation.id, structuredClone(operation)]]);
const writes: unknown[] = [];
const fhir = {
  async read(type: string, id: string) {
    assert.equal(type, 'Task');
    const resource = stored.get(id);
    assert.ok(resource);
    return structuredClone(resource);
  },
  async search(type: string, params: Record<string, string>) {
    assert.equal(type, 'Task');
    const entries = [...stored.values()].filter(task => {
      const coding = task.code.coding[0];
      return (!params.code || `${coding.system}|${coding.code}` === params.code)
        && (!params['based-on'] || task.basedOn?.some(ref => ref.reference === params['based-on']));
    });
    return { resourceType: 'Bundle', type: 'searchset', entry: entries.map(resource => ({ resource: structuredClone(resource) })) };
  },
  async create(resource: unknown) {
    const copy = { ...structuredClone(resource), id: 'synthetic-lab-transmission' };
    stored.set(copy.id, copy);
    writes.push(structuredClone(copy));
    return copy;
  },
  async update() { throw new Error('Unexpected update'); },
};
const deps = {
  authenticate: async () => ({ staffReference: 'Practitioner/synthetic-staff', fhir }),
  dispatch: createLabOrderDispatch([{ vendor: 'manual' }], { recordAudit: async () => {} }),
  now: () => '2026-09-14T09:00:00.000Z',
};
const result = await handleSubmitLabOrderRequest(deps, {
  authHeader: undefined,
  body: {
    vendor: 'manual', lab: 'Synthetic Lab', orderTaskReference: `Task/${operation.id}`,
    order: {
      header: { orderId: 'SYNTHETIC-READER-PROBE', orderDate: '2026-09-14', lab: 'Synthetic Lab', patientName: 'Synthetic Patient' },
      rx: { od: { sphere: -1 }, os: { sphere: -1 } },
      lensSpec: { jobType: 'Complete', lensDesign: 'Single Vision', lensMaterial: 'Polycarbonate', treatments: [] },
      frameSource: 4, frameOwnership: 'in-house',
    },
  },
});
assert.equal(result.status, 200);
assert.equal(writes.length, 1);
assert.equal(writes[0].basedOn[0].reference, `Task/${operation.id}`);
assert.deepEqual(stored.get(operation.id), operation);
const board = await handleLabOrderWorklistRequest(deps, { authHeader: undefined });
assert.equal(board.status, 200);
assert.equal(board.body.items.length, 1);
console.log(JSON.stringify({
  evidenceKind: 'Pinned production handler and adapter, injected synthetic in-memory FHIR transport; no network or actual lab delivery',
  submitStatus: result.status, operationUnchanged: true, createdCount: writes.length,
  createdCode: writes[0].code.coding, createdBasedOn: writes[0].basedOn,
  boardStatus: board.status, boardItemCount: board.body.items.length,
  limitation: 'The lab transmission appears on the board; the operation Task itself is not a board row. The caller must explicitly supply its ID.',
}, null, 2));
