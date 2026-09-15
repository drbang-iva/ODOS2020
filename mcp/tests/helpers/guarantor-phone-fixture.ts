import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as engine from '../../src/clinic/guarantor-link-operation.js';
import * as editor from '../../../ui/src/lib/guarantor-editor.js';
import { fixture } from '../guarantorScreensFixture.js';
import { registerPatientFromDemographics } from '../../src/clinic/patient-registration-endpoint.js';
import { applyTextableAnswer, ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL as NO } from '../../src/clinic/patient-telecom.js';
const { GUARANTOR_CLAIM_URL: CLAIM, GUARANTOR_EPOCH_URL: EPOCH } = engine;
export const PROJECT = 'g2b1-synthetic';
export const SERVICE = 'ClientApplication/g2b1-service';
export const staff: any = { staffReference: 'Practitioner/g2b1-staff', actorRole: 'staff', roles: ['staff'], businessActions: ['patients.register', 'guarantor.link'], project: { reference: `Project/${PROJECT}` } };
export const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const refused = (r: any) => r.extension?.some((e: any) => e.url === NO && e.valueBoolean === true) ?? false;
export const setRefusal = (r: any, yes: boolean) => wire(yes ? applyTextableAnswer(r, 'neither') : { ...r, extension: r.extension?.filter((e: any) => e.url !== NO) });
export const otherExtensions = (r: any) => r.extension?.filter((e: any) => e.url !== NO && e.url !== CLAIM) ?? [];
function registrationInput(kind = 'person', family = 'Guardian', emptyAddress = false): any {
  return {
    demographics: { firstName: 'EXAMPLEV', middleName: '', lastName: 'EXAMPLEV', preferredName: '', birthDate: '2015-04-03', gender: 'female', phones: [{ value: '864-555-0100', use: 'home' }, { value: '', use: 'mobile' }], textable: '', email: '', address: '', city: '', state: '', postalCode: '' },
    responsibleParties: [{ localId: 'guardian', kind, relationship: 'parent', financialResponsible: !emptyAddress, consentAuthority: true, primary: true, courtOrderNotes: 'Synthetic court note', effectiveDate: '2026-01-01', endDate: '',
      ...(kind === 'existing' ? { personId: 'D' } : { birthDate: '1980-01-02', firstName: 'EXAMPLEV', middleName: '', lastName: family, phones: [{ value: '864-555-0101', use: 'home' }, { value: '864-555-0102', use: 'mobile' }], textable: '', address: emptyAddress ? '' : '2 Synthetic Way', city: emptyAddress ? '' : 'Greenville', state: emptyAddress ? '' : 'SC', postalCode: emptyAddress ? '' : '29601' }) }], confirmDuplicate: true,
  };
}

async function writerResources(family = 'Guardian', emptyAddress = false) {
  let transaction: any;
  const captured = new Error('capture actual registration transaction');
  const serviceFhir: any = {
    baseUrl: 'http://scratch.invalid',
    search: async () => ({ resourceType: 'Bundle', type: 'searchset', entry: [] }),
    searchProject: async () => ({ resourceType: 'Bundle', type: 'searchset', entry: [] }),
    searchProjectUrl: async () => { throw new Error('unexpected pagination'); },
    create: async (r: any) => wire({ ...r, id: 'reservation', meta: { ...r.meta, versionId: '1', project: PROJECT } }),
    executeTransactionAsActor: async (bundle: any) => { transaction = wire(bundle); throw captured; },
  };
  const input = registrationInput('person', family, emptyAddress);
  if (emptyAddress) input.responsibleParties.push({ ...registrationInput().responsibleParties[0], localId: 'financial-party', primary: false });
  try {
    await registerPatientFromDemographics(input, staff, { serviceFhir, now: () => '2026-09-15T12:00:00.000Z' });
  } catch (error) { if (error !== captured) throw error; }
  assert.ok(transaction, 'the real writer must have emitted its transaction');
  const byType: any = {};
  for (const e of transaction.entry) if (e.resource && !byType[e.resource.resourceType]) byType[e.resource.resourceType] = e.resource;
  return byType;
}
const writer = await writerResources();
const writerBare = await writerResources('Guardian', true);
const writerDestination = await writerResources('Destination');

async function world(sourceRefusal = false, destinationRefusal = true, emptyAddress = false) {
  const f = fixture(2);
  f.data.clear();
  const seed = (r: any) => f.seed(wire(r));
  const src = emptyAddress ? writerBare : writer;
  seed(setRefusal({ ...src.Person, id: 'S', meta: { project: PROJECT, versionId: '1', author: { reference: SERVICE } }, link: ['r1', 'r2'].map(id => ({ target: { reference: `RelatedPerson/${id}` }, assurance: 'level2' })) }, sourceRefusal));
  seed(setRefusal({ ...writerDestination.Person, id: 'D', active: true, meta: { project: PROJECT, versionId: '1', author: { reference: SERVICE } }, link: [{ target: { reference: 'RelatedPerson/k' }, assurance: 'level2' }] }, destinationRefusal));
  for (const id of ['r1', 'r2', 'k']) {
    const base = id === 'k' ? writerDestination : src;
    seed({ ...base.Patient, id: `p-${id}` });
    seed(setRefusal({ ...base.RelatedPerson, id, patient: { reference: `Patient/p-${id}` } }, id === 'k' ? destinationRefusal : sourceRefusal));
  }
  const read = f.deps.serviceFhir.readExtended.bind(f.deps.serviceFhir);
  f.deps.serviceFhir.readExtended = async (...args: any[]) => wire(await (read as any)(...args));
  const search = f.deps.serviceFhir.searchProject.bind(f.deps.serviceFhir);
  f.deps.serviceFhir.searchProject = async (...args: any[]) => wire(await (search as any)(...args));
  const transaction = f.deps.serviceFhir.executeTransactionAsActor.bind(f.deps.serviceFhir);
  f.deps.serviceFhir.executeTransactionAsActor = async (bundle: any, ...args: any[]) => wire(await (transaction as any)(wire(bundle), ...args));
  return f;
}
type World = Awaited<ReturnType<typeof world>>;
export const get = (f: World, ref: string): any => wire(f.get(ref));
export const store = (f: World, r: any) => f.seed(wire(r));
export const run = (f: World, action: string, body?: any, taskId?: string, api = engine) => api.handleGuarantorOperation(f.deps as any, staff, { action, body, taskId });
function input(f: World, kind = 'transfer', ids = ['r1']) {
  const refs = [...(kind === 'attach' ? [] : ['Person/S']), 'Person/D', ...ids.map(id => `RelatedPerson/${id}`)];
  return { operationId: randomUUID(), kind, ...(kind === 'attach' ? {} : { sourcePersonId: 'S' }), destinationPersonId: 'D', relatedPersonIds: ids, expected: Object.fromEntries(refs.map(ref => [ref, get(f, ref).meta.versionId])), reason: 'Synthetic guarantor phone regression' };
}
function journal(f: World, taskId: string): any[] {
  return JSON.parse(get(f, `Task/${taskId}`).extension.find((e: any) => e.url.endsWith('/guarantor-link-journal')).valueString).intents;
}
function fetchFor(f: World, loss?: { target: string; stage: 'before' | 'after'; count?: number }) {
  let lost = false;
  const writes: string[] = [];
  const fetch = async (request: any, init: any = {}) => {
    const url = new URL(String(request), 'http://scratch.invalid');
    const key = url.pathname.replace('/fhir/R4/', '');
    const method = init.method ?? 'GET';
    if (url.pathname.startsWith('/guarantors/')) return Response.json(url.searchParams.has('relatedPersonId') ? [] : {}, { status: url.searchParams.has('relatedPersonId') ? 200 : 404 });
    if (method === 'PUT') {
      writes.push(key);
      const before = get(f, key);
      if (new Headers(init.headers).get('If-Match') !== `W/"${before.meta.versionId}"`) return Response.json({}, { status: 412 });
      if (loss?.target === key && !lost && loss.stage === 'before') { lost = true; throw new TypeError('reply unavailable before commit'); }
      const accepted = wire({ ...JSON.parse(init.body), meta: { ...before.meta, versionId: String(Number(before.meta.versionId) + 1) } });
      store(f, accepted);
      if (loss?.target === key && !lost && loss.stage === 'after') { lost = true; throw new TypeError('reply lost after commit'); }
      return Response.json(accepted);
    }
    if (method !== 'GET') throw new Error(`unexpected UI write ${method} ${key}`);
    if (key === 'Person' || key === 'RelatedPerson') {
      const rows = [...f.data.values()].filter((r: any) => r.resourceType === key && (!url.searchParams.has('link') || r.link?.some((l: any) => l.target.reference === url.searchParams.get('link'))) && (!url.searchParams.has('patient') || r.patient.reference === url.searchParams.get('patient')));
      return Response.json({ resourceType: 'Bundle', type: 'searchset', entry: rows.map(resource => ({ resource: wire(resource) })) });
    }
    return f.data.has(key) ? Response.json(get(f, key)) : Response.json({}, { status: 404 });
  };
  return { fetch, writes, lost: () => lost };
}
async function withEditor(f: World, action: (http: ReturnType<typeof fetchFor>) => Promise<any>, loss?: Parameters<typeof fetchFor>[1]) {
  const originalFetch = globalThis.fetch;
  const http = fetchFor(f, loss);
  globalThis.fetch = http.fetch;
  try { return await action(http); } finally { globalThis.fetch = originalFetch; }
}
async function snapshot() {
  const loaded = await editor.loadGuarantor('r1');
  assert.equal(loaded.kind, 'editable');
  return (loaded as any).snapshot;
}
function summarizeEditor(result: any) {
  return { status: result.status, children: result.children.map((c: any) => ({ id: c.relatedPersonId, classification: c.classification, writeStatus: c.writeStatus })) };
}

export { registrationInput, world, input, journal, withEditor, snapshot };
async function registerExisting(loss: 'none' | 'registration' | 'attach', change?: 'refusal' | 'telecom') {
  const f = await world(false, true);
  let initialChild: any, lost = 0;
  const serviceFhir: any = {
    ...f.deps.serviceFhir,
    search: async () => ({ resourceType: 'Bundle', type: 'searchset', entry: [] }),
    read: async (type: string, id: string) => get(f, `${type}/${id}`),
    create: async (r: any) => store(f, { ...r, id: 'registration-account' }),
    executeTransactionAsActor: async (bundle: any, _actor: any, _headers: any, options: any) => {
      bundle = wire(bundle);
      initialChild = wire(bundle.entry.find((e: any) => e.resource.resourceType === 'RelatedPerson').resource);
      const refs = new Map<string, string>();
      bundle.entry.forEach((e: any, i: number) => { if (e.fullUrl) refs.set(e.fullUrl, `${e.resource.resourceType}/registered-${i}`); });
      function remap(v: any): any { if (Array.isArray(v)) return v.map(remap); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, k === 'reference' && refs.has(val as string) ? refs.get(val as string) : remap(val)])); return v; }
      const entry = bundle.entry.map((e: any, i: number) => {
        const id = e.resource.id ?? `registered-${i}`;
        const accepted = store(f, wire({ ...remap(e.resource), id, meta: { ...e.resource.meta, versionId: e.resource.resourceType === 'Account' ? '2' : '1' } }));
        return { resource: accepted, response: { status: e.request.method === 'PUT' ? '200 OK' : '201 Created', location: `${accepted.resourceType}/${id}/_history/${accepted.meta!.versionId}` } };
      });
      if (loss === 'registration') {
        lost++;
        if (change) f.compete('RelatedPerson/registered-1', (r: any) => change === 'refusal' ? setRefusal(r, !refused(r)) : wire({ ...r, telecom: [{ system: 'phone', value: '864-555-0188' }] }));
        return wire(await options.reconcileError(new Error('registration reply lost')));
      }
      return wire({ resourceType: 'Bundle', type: 'transaction-response', entry });
    },
  };
  if (loss === 'attach') f.afterWrite = async (w: any) => { if (!lost && w.actor.actionReason === 'guarantor.link projecting RelatedPerson/registered-1' && w.status === 200) { lost++; throw new Error('registration attach reply lost'); } };
  const result: any = await registerPatientFromDemographics(registrationInput('existing'), staff, { serviceFhir, now: () => '2026-09-15T12:00:00.000Z', grantRegistrationAccess: async () => {}, attachRegistrationGuarantor: async (_staff: any, body: any) => run(f, 'create', body) });
  f.afterWrite = undefined;
  const link = result.body.guarantorLinks[0];
  const completed = link.taskId && link.status === 'pending' ? await run(f, 'complete', undefined, link.taskId) : undefined;
  return { status: result.status, lost, initialRefusal: refused(initialChild), initialRoles: otherExtensions(initialChild), linkStatus: link.status, relatedIdRecovered: link.relatedPersonId === 'registered-1', completed, finalRefusal: refused(get(f, 'RelatedPerson/registered-1')), owners: f.owners('registered-1') };
}

export { registerExisting };
