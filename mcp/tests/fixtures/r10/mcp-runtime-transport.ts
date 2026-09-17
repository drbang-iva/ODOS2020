import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Binary, Bundle, Observation, Resource } from '@medplum/fhirtypes';
import { createWriteRecorder } from './write-path-recorder.js';

const failure = (status: number) => Object.assign(new Error(`Synthetic HTTP ${status}`), { status });
export function createMcpRuntimeTransport(initial: Resource[], scenarioId: string) {
  const resources = new Map(initial.map(resource => [`${resource.resourceType}/${resource.id}`, structuredClone(resource)]));
  const recorder = createWriteRecorder({ snapshot: () => [...resources.values()], scenarioId });
  const transactions: Bundle[] = [];
  const patchProjections: Array<{ reference: string; resource: Observation; before: Observation }> = [];
  const matches = (resource: any, params: Record<string, string>) => Object.entries(params).every(([key, value]) => {
    if (['_count', '_sort', '_include', '_revinclude'].includes(key)) return true;
    if (key === '_id') return resource.id === value;
    if (key === 'patient' || key === 'subject') return (resource.subject ?? resource.patient)?.reference === value;
    if (key === 'encounter') return resource.encounter?.reference === value;
    let tokens: Array<{ system?: string; code?: string; value?: string }>;
    if (key === 'identifier') tokens = resource.identifier ?? [];
    else if (key === '_tag') tokens = resource.meta?.tag ?? [];
    else if (key === 'code') tokens = resource.code?.coding ?? [];
    else if (key === 'location') tokens = resource.location?.coding ?? [];
    else throw new Error(`Unsupported synthetic search ${key}`);
    return value.split(',').some(query => tokens.some(token => query.includes('|')
      ? `${token.system}|${token.code ?? token.value}` === query
      : (token.code ?? token.value) === query));
  });
  const find = (map: Map<string, Resource>, type: string, query: string) => [...map.values()].filter(resource => resource.resourceType === type && matches(resource, Object.fromEntries(new URLSearchParams(query))));
  const save = (map: Map<string, Resource>, resource: Resource, id = resource.id ?? randomUUID()) => {
    const stored = { ...structuredClone(resource), id, meta: { ...resource.meta, versionId: randomUUID() } };
    map.set(`${resource.resourceType}/${id}`, stored);
    return structuredClone(stored);
  };
  const put = (map: Map<string, Resource>, type: string, id: string, resource: Resource, headers: Record<string, string> = {}) => {
    assert.equal(resource.resourceType, type);
    const current = map.get(`${type}/${id}`);
    if (headers['If-Match'] && (!current || headers['If-Match'] !== `W/"${current.meta?.versionId}"`)) throw failure(412);
    return save(map, resource, id);
  };
  const post = (map: Map<string, Resource>, resource: Resource, headers: Record<string, string> = {}) => {
    const existing = headers['If-None-Exist'] ? find(map, resource.resourceType, headers['If-None-Exist']) : [];
    if (existing.length > 1) throw failure(412);
    return existing.length ? { resource: structuredClone(existing[0]), created: false } : { resource: save(map, resource), created: true };
  };
  const rewrite = (value: unknown, references: Map<string, string>): any => {
    if (typeof value === 'string') return references.get(value) ?? value;
    if (Array.isArray(value)) return value.map(item => rewrite(item, references));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, references)]));
    return value;
  };
  const client = {
    baseUrl: 'http://localhost:8103/',
    async read<T extends Resource>(type: string, id: string): Promise<T> {
      const found = resources.get(`${type}/${id}`); if (!found) throw failure(404); return structuredClone(found) as T;
    },
    async search<T extends Resource>(type: string, params: Record<string, string> = {}): Promise<Bundle<T>> {
      return { resourceType: 'Bundle', type: 'searchset', entry: [...resources.values()].filter(resource => resource.resourceType === type && matches(resource, params)).map(resource => ({ resource: structuredClone(resource) as T })) };
    },
    async searchUrl<T extends Resource>(url: string, type: string): Promise<Bundle<T>> {
      return client.search<T>(type, Object.fromEntries(new URL(url, client.baseUrl).searchParams));
    },
    async create<T extends Resource>(resource: T, headers: Record<string, string> = {}): Promise<T> { return post(resources, resource, headers).resource as T; },
    async createWithOutcome<T extends Resource>(resource: T, headers: Record<string, string> = {}) { return post(resources, resource, headers) as { resource: T; created: boolean }; },
    async update<T extends Resource>(type: string, id: string, resource: T, headers: Record<string, string> = {}): Promise<T> { return put(resources, type, id, resource, headers) as T; },
    async executeTransaction(bundle: Bundle): Promise<Bundle> {
      assert.equal(bundle.type, 'transaction'); transactions.push(structuredClone(bundle));
      const staging = new Map([...resources].map(([key, resource]) => [key, structuredClone(resource)]));
      const references = new Map<string, string>();
      for (const entry of bundle.entry ?? []) {
        if (entry.request?.method !== 'POST' || !entry.resource) continue;
        const type = entry.request.url!.split('?')[0]; assert.equal(type, entry.resource.resourceType);
        const query = entry.request.ifNoneExist ?? entry.request.url!.split('?')[1];
        const existing = query ? find(staging, type, query) : [];
        if (existing.length > 1) throw failure(412);
        if (entry.fullUrl) references.set(entry.fullUrl, `${type}/${existing[0]?.id ?? entry.resource.id ?? randomUUID()}`);
      }
      const response: NonNullable<Bundle['entry']> = [];
      for (const [index, entry] of (bundle.entry ?? []).entries()) {
        assert.ok(entry.request && entry.resource, 'Synthetic transaction requires a write resource and request');
        const { method, url, ifMatch, ifNoneExist } = entry.request;
        assert.ok(url);
        const headers = { ...(ifMatch ? { 'If-Match': ifMatch } : {}), ...(ifNoneExist ? { 'If-None-Exist': ifNoneExist } : {}) };
        let stored: Resource; let created = false;
        if (method === 'PATCH') {
          const binary = entry.resource as Binary;
          assert.equal(binary.resourceType, 'Binary'); assert.equal(binary.contentType, 'application/json-patch+json'); assert.ok(binary.data);
          const current = staging.get(url); if (!current) throw failure(404);
          assert.equal(current.resourceType, 'Observation');
          if (!ifMatch || ifMatch !== `W/"${current.meta?.versionId}"`) throw failure(412);
          const patched = structuredClone(current) as Observation;
          for (const operation of JSON.parse(Buffer.from(binary.data, 'base64').toString('utf8'))) {
            if (operation.op === 'test' && operation.path === '/status') assert.equal(patched.status, operation.value);
            else if (operation.op === 'replace' && operation.path === '/status') patched.status = operation.value;
            else if (operation.op === 'add' && operation.path === '/note') patched.note = operation.value;
            else if (operation.op === 'add' && operation.path === '/note/-') { assert.ok(patched.note); patched.note.push(operation.value); }
            else throw new Error(`Unsupported synthetic JSON Patch ${operation.op} ${operation.path}`);
          }
          patchProjections.push({ reference: url, resource: structuredClone(patched), before: structuredClone(current) as Observation });
          stored = put(staging, 'Observation', current.id!, patched, headers);
        } else if (method === 'PUT') {
          const [type, id] = url.split('/'); assert.ok(id); assert.ok(!url.includes('?'));
          created = !staging.has(url); stored = put(staging, type, id, rewrite(entry.resource, references), headers);
        } else if (method === 'POST') {
          const resource = rewrite(entry.resource, references) as Resource;
          if (entry.fullUrl) resource.id = references.get(entry.fullUrl)!.split('/')[1];
          const result = post(staging, resource, { ...headers, ...(url.includes('?') && !ifNoneExist ? { 'If-None-Exist': url.split('?')[1] } : {}) });
          stored = result.resource; created = result.created;
        } else throw new Error(`Unsupported synthetic transaction method ${method}`);
        response.push({ resource: stored, response: { status: created ? '201 Created' : '200 OK', location: `${stored.resourceType}/${stored.id}/_history/${stored.meta!.versionId}` } });
      }
      resources.clear(); for (const [key, resource] of staging) resources.set(key, resource);
      return { resourceType: 'Bundle', type: 'transaction-response', entry: response };
    },
  };
  return { fhir: recorder.wrap(client), resources, recorder, transactions, patchProjections };
}
