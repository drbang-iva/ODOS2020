import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loginForLocalRepair } from '../../scripts/repair-practice-roles.ts';
import { buildMedplumAccessPolicy, buildProjectMembershipAccess, getRoleDeclaration } from '../src/authz/roles.ts';
import { buildProvenance } from '../src/fhir/ophthalmology/provenance.ts';
import { buildEncounterDiagnosisCondition } from '../src/fhir/condition.ts';
import { currentFindingIdentifier, parseCurrentFindingEnvelope, findingQualifiers, SUPPORTS_DIAGNOSIS_URL } from '../src/clinical-graph/current-finding-identity.ts';
import { ODOS_EXTENSION_URLS, odosConcept, lateralityConcept } from '../src/fhir/ophthalmology/extensions.ts';
import { catalog, definitions, comp, lens, lensField, nuclear } from '../tests/fixtures/r10/factories.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const privateDir = resolve(root, '.odos/r10-a2a');
const evidenceDir = resolve(root, 'docs/evidence/r10-a2a');
const projectName = 'odos-r10-a2a';
const port = 29023;
const baseUrl = `http://127.0.0.1:${port}`;
const image = 'medplum/medplum-server@sha256:358ab425b29390067b6cb82bfbaeee48580a703f7cc5b730bed2b2ba7184c1de';
const operationSystem = 'urn:odos:finding-operation:v1';
const events = [];
const results = [];
let scenario = 'bootstrap';
let fixture;

function privateJson(name, value) {
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(privateDir, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function sanitizePublishedText(text) {
  return text.replaceAll(root, '<repo-root>').replaceAll(homedir(), '<repo-root>')
    .replaceAll(basename(homedir()), '<local-account>');
}

function sanitizeEvidence(directory = evidenceDir) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) sanitizeEvidence(path);
    else writeFileSync(path, sanitizePublishedText(readFileSync(path, 'utf8')));
  }
}

function evidence(name, value) {
  mkdirSync(evidenceDir, { recursive: true });
  let text = JSON.stringify(value, null, 2) + '\n';
  for (const principal of [fixture, ...Object.values(fixture?.principals ?? {})]) {
    for (const [key, secret] of Object.entries(principal ?? {})) {
      if (/password|token|passphrase/i.test(key) && typeof secret === 'string' && secret) {
        text = text.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]');
      }
    }
  }
  writeFileSync(resolve(evidenceDir, name), sanitizePublishedText(text));
}

function command(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

function load() {
  fixture = JSON.parse(readFileSync(resolve(privateDir, 'fixture.json'), 'utf8'));
  assert.equal(fixture.baseUrl, baseUrl);
  assert.equal(fixture.projectName, projectName);
  return fixture;
}

async function request(role, method, path, body, headers = {}) {
  assert.equal(new URL(path, baseUrl).origin, baseUrl);
  const principal = role === 'seeder' ? fixture : fixture.principals[role];
  const start = new Date().toISOString();
  const sequence = events.length + 1;
  const event = { sequence, scenario, role, login: principal.email, start, method, path, requestHeaders: headers };
  events.push(event);
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { Authorization: `Bearer ${principal.token}`, 'Content-Type': 'application/fhir+json', 'X-Medplum': 'extended', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  const resource = raw ? JSON.parse(raw) : undefined;
  Object.assign(event, { end: new Date().toISOString(), status: response.status, etag: response.headers.get('etag'), location: response.headers.get('location'),
    ...(path.startsWith('/fhir/') ? { request: body, response: resource } : {}) });
  return { status: response.status, body: resource };
}

async function ok(role, method, path, body, headers) {
  const response = await request(role, method, path, body, headers);
  assert.ok(response.status >= 200 && response.status < 300, `${role} ${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}

async function refresh() {
  for (const principal of [fixture, ...Object.values(fixture.principals)]) {
    if (principal.token) {
      const session = await fetch(new URL('/auth/me', baseUrl), { headers: { Authorization: `Bearer ${principal.token}` }, signal: AbortSignal.timeout(30000) });
      if (session.ok) continue;
    }
    principal.token = await loginForLocalRepair({ baseUrl, email: principal.email, password: principal.password });
  }
  privateJson('fixture.json', fixture);
}

async function up() {
  assert.ok(!existsSync(resolve(privateDir, 'fixture.json')), 'Refusing to replace an existing fixture.');
  assert.equal(command('docker', ['ps', '-aq', '--filter', `name=^${projectName}-`]), '', 'Project already exists.');
  await new Promise((done, fail) => {
    const server = createServer(); server.once('error', fail);
    server.listen(port, '127.0.0.1', () => server.close(done));
  });
  const password = () => randomBytes(30).toString('base64url') + '!Aa1';
  fixture = { projectName, baseUrl, sourceHead: command('git', ['rev-parse', 'HEAD']), email: 'r10-a2a-seeder@example.invalid',
    password: password(), databasePassword: password(), redisPassword: password(), signingPassphrase: password(), principals: {} };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: fixture.signingPassphrase },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  privateJson('fixture.json', fixture);
  privateJson('medplum.json', {
    port: 8103, baseUrl: `${baseUrl}/`, appBaseUrl: `${baseUrl}/`, storageBaseUrl: `${baseUrl}/storage/`, binaryStorage: 'file:/tmp/r10-binary/',
    signingKeyId: randomUUID(), signingKey: privateKey, signingKeyPassphrase: fixture.signingPassphrase,
    database: { host: 'postgres', port: 5432, dbname: 'medplum', username: 'medplum', password: fixture.databasePassword },
    redis: { host: 'redis', port: 6379, password: fixture.redisPassword }, registerEnabled: true,
    defaultSuperAdminEmail: fixture.email, defaultSuperAdminPassword: fixture.password, supportEmail: 'r10-support@example.invalid', maxJsonSize: '10mb',
  });
  privateJson('compose.json', { name: projectName, services: {
    postgres: { image: 'postgres:16-alpine', environment: { POSTGRES_DB: 'medplum', POSTGRES_USER: 'medplum', POSTGRES_PASSWORD: fixture.databasePassword },
      volumes: ['postgres-data:/var/lib/postgresql/data'], healthcheck: { test: ['CMD-SHELL', 'pg_isready -U medplum -d medplum'], interval: '1s', timeout: '3s', retries: 30 } },
    redis: { image: 'redis:7-alpine', command: ['redis-server', '--requirepass', fixture.redisPassword],
      healthcheck: { test: ['CMD', 'redis-cli', '--no-auth-warning', '-a', fixture.redisPassword, 'ping'], interval: '1s', timeout: '3s', retries: 30 } },
    medplum: { image, depends_on: { postgres: { condition: 'service_healthy' }, redis: { condition: 'service_healthy' } },
      environment: { NODE_OPTIONS: '--max-old-space-size=384' }, mem_limit: '768m', command: ['file:/config/medplum.json'],
      ports: [`127.0.0.1:${port}:8103`], volumes: [`${resolve(privateDir, 'medplum.json')}:/config/medplum.json:ro`] },
  }, volumes: { 'postgres-data': {} }, networks: { default: { ipam: { config: [{ subnet: '10.248.0.0/24' }] } } } });
  await start();
}

async function start() {
  load();
  const standalone = spawnSync('docker-compose', ['version'], { encoding: 'utf8' }).status === 0;
  const startup = spawnSync(standalone ? 'docker-compose' : 'docker', [...(standalone ? [] : ['compose']), '-p', projectName, '-f', resolve(privateDir, 'compose.json'), 'up', '-d'], { cwd: root, encoding: 'utf8' });
  privateJson('startup.json', { status: startup.status, stdout: startup.stdout, stderr: startup.stderr });
  assert.equal(startup.status, 0, 'Disposable stack startup failed; inspect private startup.json.');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const health = await fetch(`${baseUrl}/healthcheck`).then(r => r.ok ? r.json() : undefined).catch(() => undefined);
    if (health) {
      assert.equal(health.version, '5.1.30-9b1bd92');
      fixture.health = health; privateJson('fixture.json', fixture);
      evidence('runtime.json', { projectName, baseUrl, image, health, sourceHead: fixture.sourceHead,
        containers: command('docker', ['ps', '--filter', `name=^${projectName}-`, '--format', '{{.Names}} {{.Image}} {{.Ports}}']).split('\n') });
      console.log(JSON.stringify({ stage: 'up', projectName, baseUrl, health })); return;
    }
    await new Promise(done => setTimeout(done, 1000));
  }
  throw new Error('Disposable Medplum did not become healthy; containers retained.');
}

async function seed() {
  load(); assert.equal(fixture.projectId, undefined, 'Fixture already seeded.'); await refresh();
  const project = await ok('seeder', 'POST', '/fhir/R4/Project', { resourceType: 'Project', name: 'R10 A2a synthetic preflight', features: [], link: [] });
  fixture.projectId = project.id;
  const patient = await ok('seeder', 'POST', '/fhir/R4/Patient', { resourceType: 'Patient', meta: { project: project.id }, name: [{ family: 'Synthetic', given: ['R10'] }] });
  fixture.patientReference = `Patient/${patient.id}`;
  const encounter = await ok('seeder', 'POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', meta: { project: project.id }, status: 'in-progress', class: { code: 'synthetic' }, subject: { reference: fixture.patientReference } });
  fixture.encounterReference = `Encounter/${encounter.id}`;
  for (const role of ['provider', 'staff']) {
    const compiled = buildMedplumAccessPolicy(getRoleDeclaration(role));
    const policy = await ok('seeder', 'POST', '/fhir/R4/AccessPolicy', { ...compiled, meta: { ...compiled.meta, project: project.id } });
    const email = `r10-a2a-${role}@example.invalid`;
    const password = randomBytes(30).toString('base64url') + '!Aa1';
    const invite = await ok('seeder', 'POST', `/admin/projects/${project.id}/invite`, { resourceType: 'Practitioner', email, firstName: 'Synthetic', lastName: `R10 ${role}`, sendEmail: false });
    const member = await ok('seeder', 'GET', `/fhir/R4/ProjectMembership/${invite.id}`);
    await ok('seeder', 'POST', '/admin/super/setpassword', { email, password });
    const access = buildProjectMembershipAccess({ policyReference: `AccessPolicy/${policy.id}`, parameters: {
      patientCompartmentReference: fixture.patientReference, ...(role === 'provider' ? { providerProfileReference: member.profile.reference } : {}),
    } });
    const { accessPolicy: _old, ...membership } = member;
    await ok('seeder', 'PUT', `/fhir/R4/ProjectMembership/${member.id}`, { ...membership, admin: false, access }, { 'If-Match': `W/"${member.meta.versionId}"` });
    fixture.principals[role] = { email, password, profileReference: member.profile.reference, membershipId: member.id, policyId: policy.id, policyVersion: policy.meta.versionId };
  }
  privateJson('fixture.json', fixture); await refresh();
  const principals = {};
  for (const [role, principal] of Object.entries(fixture.principals)) {
    const me = await ok(role, 'GET', '/auth/me');
    assert.equal(me.membership.admin, false); assert.equal(me.project.id, fixture.projectId);
    assert.equal(me.profile.resourceType, 'Practitioner');
    const policy = await ok('seeder', 'GET', `/fhir/R4/AccessPolicy/${principal.policyId}`);
    assert.deepEqual(policy.resource, buildMedplumAccessPolicy(getRoleDeclaration(role)).resource);
    principals[role] = { email: principal.email, profileReference: principal.profileReference, membershipId: principal.membershipId,
      membershipAccess: me.membership.access, policy };
  }
  evidence('principals.json', { projectId: fixture.projectId, features: project.features, patientReference: fixture.patientReference, encounterReference: fixture.encounterReference,
    seeder: { email: fixture.email, use: 'Synthetic bootstrap and fixture preparation only; never a gated write control.' }, principals });
  evidence('bootstrap-http.json', { events });
  console.log(JSON.stringify({ stage: 'seed', projectId: fixture.projectId, roles: Object.keys(principals), policiesMatchSource: true }));
}

async function search(role, type, params) {
  const bundle = await ok(role, 'GET', `/fhir/R4/${type}?${new URLSearchParams({ ...params, _count: '1000', _total: 'accurate' })}`);
  assert.ok(!bundle.link?.some(link => link.relation === 'next'), 'Capability search unexpectedly paginated.');
  return bundle.entry?.flatMap(entry => entry.resource ? [entry.resource] : []) ?? [];
}

async function recompilePolicies() {
  load(); await refresh();
  scenario = 'recompile-policies';
  const principals = {};
  for (const [role, principal] of Object.entries(fixture.principals)) {
    const compiled = buildMedplumAccessPolicy(getRoleDeclaration(role));
    const policy = await ok('seeder', 'POST', '/fhir/R4/AccessPolicy', { ...compiled, meta: { ...compiled.meta, project: fixture.projectId } });
    const member = await ok('seeder', 'GET', `/fhir/R4/ProjectMembership/${principal.membershipId}`);
    const access = buildProjectMembershipAccess({ policyReference: `AccessPolicy/${policy.id}`, parameters: {
      patientCompartmentReference: fixture.patientReference,
      ...(role === 'provider' ? { providerProfileReference: member.profile.reference } : {}),
    } });
    const { accessPolicy: _old, ...membership } = member;
    await ok('seeder', 'PUT', `/fhir/R4/ProjectMembership/${member.id}`, { ...membership, admin: false, access }, { 'If-Match': `W/"${member.meta.versionId}"` });
    principal.policyId = policy.id; principal.policyVersion = policy.meta.versionId;
    delete principal.token;
    privateJson('fixture.json', fixture);
    await refresh();
    const me = await ok(role, 'GET', '/auth/me');
    assert.equal(me.membership.admin, false); assert.equal(me.project.id, fixture.projectId);
    const stored = await ok('seeder', 'GET', `/fhir/R4/ProjectMembership/${principal.membershipId}`);
    assert.deepEqual(stored.access, access);
    assert.deepEqual(policy.resource, compiled.resource);
    principals[role] = { email: principal.email, profileReference: principal.profileReference,
      membershipId: principal.membershipId, membershipAccess: stored.access, policy };
  }
  fixture.sourceHead = command('git', ['rev-parse', 'HEAD']);
  privateJson('fixture.json', fixture);
  evidence('principals.json', { sourceHead: fixture.sourceHead, projectId: fixture.projectId,
    patientReference: fixture.patientReference, encounterReference: fixture.encounterReference,
    seeder: { email: fixture.email, use: 'Synthetic bootstrap and fixture preparation only; never a gated write control.' }, principals });
  evidence('recompile-http.json', { sourceHead: fixture.sourceHead, events });
  evidence('runtime.json', { projectName, baseUrl, image, health: fixture.health, sourceHead: fixture.sourceHead,
    containers: command('docker', ['ps', '--filter', `name=^${projectName}-`, '--format', '{{.Names}} {{.Image}} {{.Ports}}']).split('\n') });
  console.log(JSON.stringify({ stage: 'recompile-policies', sourceHead: fixture.sourceHead, policiesMatchSource: true,
    principals: Object.fromEntries(Object.entries(principals).map(([role, p]) => [role, { login: p.email, policyId: p.policy.id }])) }));
}

async function probe(role, name, execute) {
  scenario = `${role}/${name}`;
  const firstEvent = events.length + 1;
  let failure;
  try {
    const detail = await execute();
    results.push({ role, login: fixture.principals[role].email, policyId: fixture.principals[role].policyId, policyVersion: fixture.principals[role].policyVersion, probe: name, status: 'PASS', firstEvent, lastEvent: events.length, detail });
  } catch (error) {
    failure = error;
    results.push({ role, login: fixture.principals[role].email, policyId: fixture.principals[role].policyId, policyVersion: fixture.principals[role].policyVersion, probe: name, status: 'FAIL', firstEvent, lastEvent: events.length, error: error.message });
  }
  evidence('gate-http.json', { events });
  evidence('gate-results.json', { sourceHead: fixture.sourceHead, server: fixture.health, results, stop: Boolean(failure) });
  console.log(JSON.stringify(results.at(-1)));
  if (failure) throw failure;
}

function audit(role, code) {
  return { ...buildProvenance({ targetReferences: [fixture.patientReference, fixture.encounterReference], recorded: new Date().toISOString(),
    activityCode: 'CREATE', agents: [{ whoReference: fixture.principals[role].profileReference, typeCode: 'author' }] }),
    meta: { tag: [{ system: operationSystem, code }] } };
}

async function gateA(role) {
  const code = createHash('sha256').update(randomUUID()).digest('hex');
  const tag = `${operationSystem}|${code}`;
  const headers = { 'If-None-Exist': `_tag=${tag}` };
  const payload = audit(role, code);
  const responses = await Promise.all([
    request(role, 'POST', '/fhir/R4/Provenance', payload, headers),
    request(role, 'POST', '/fhir/R4/Provenance', payload, headers),
  ]);
  const third = await request(role, 'POST', '/fhir/R4/Provenance', payload, headers);
  const persisted = await search(role, 'Provenance', { _tag: tag });
  const detail = { code, concurrentStatuses: responses.map(r => r.status), concurrentIds: responses.map(r => r.body?.id),
    thirdStatus: third.status, thirdCreated: third.status === 201, thirdId: third.body?.id, persistedCount: persisted.length,
    persistedIds: persisted.map(r => r.id) };
  evidence(`gate-a-${role}.json`, detail);
  assert.ok(responses.every(r => [200, 201].includes(r.status)), 'Concurrent conditional create response failed.');
  assert.equal(persisted.length, 1, 'Concurrent conditional creates must persist exactly one Provenance.');
  assert.equal(third.status, 200, 'Third conditional create must return the existing Provenance.');
  assert.equal(third.body.id, persisted[0].id);
  assert.ok(responses.every(r => r.body.id === persisted[0].id));
  fixture.principals[role].gateTag = tag;
  privateJson('fixture.json', fixture);
  return detail;
}


async function gateB(role) {
  const encounter = await ok(role, 'POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'in-progress',
    class: { code: 'synthetic' }, subject: { reference: fixture.patientReference } });
  const encounterReference = `Encounter/${encounter.id}`;
  const home = await ok('provider', 'POST', '/fhir/R4/Condition', buildEncounterDiagnosisCondition({
    patientReference: fixture.patientReference, encounterReference, code: { text: 'Synthetic gate home' }, verificationStatus: 'confirmed' }));
  const key = { v: 1, patientId: fixture.patientReference.slice(8), encounterId: encounter.id,
    stableKey: lens.stableKey, fieldCode: lensField, optionCode: nuclear.optionCode, eye: 'OD' };
  const identifier = currentFindingIdentifier(key);
  const marker = { commandId: randomUUID(), target: `finding:${identifier.value}`, digest: createHash('sha256').update('synthetic-gate-state').digest('hex'),
    audit: { kind: 'mutation', actor: fixture.principals[role].profileReference, recorded: new Date().toISOString(), activity: 'CREATE',
      targetReferences: ['self', fixture.patientReference] } };
  const payload = { resourceType: 'Observation', identifier: [identifier], status: 'preliminary', effectiveDateTime: marker.audit.recorded, code: odosConcept(nuclear.atomicFindingId),
    subject: { reference: fixture.patientReference }, encounter: { reference: encounterReference }, valueBoolean: true,
    extension: [ { url: ODOS_EXTENSION_URLS.eyeLaterality, valueCodeableConcept: lateralityConcept('OD') },
      { url: SUPPORTS_DIAGNOSIS_URL, valueReference: { reference: `Condition/${home.id}` } } ],
    component: [comp('R10_CURRENT_META', JSON.stringify(key)), comp('R10_OPERATION', JSON.stringify(marker)),
      { code: odosConcept(`${lensField}::${nuclear.optionCode}::grade`), valueCodeableConcept: odosConcept('2+') }] };
  const headers = { 'If-None-Exist': `identifier=${identifier.system}|${identifier.value}` };
  const first = await request(role, 'POST', '/fhir/R4/Observation', payload, headers);
  assert.equal(first.status, 201);
  for (const field of Object.keys(payload)) assert.deepEqual(first.body[field], payload[field], `round-trip ${field}`);
  assert.equal(parseCurrentFindingEnvelope(first.body).status, 'valid');
  assert.deepEqual(findingQualifiers(first.body, lens, nuclear, ''), { grade: '2+' });
  const second = await request(role, 'POST', '/fhir/R4/Observation', { ...payload, valueBoolean: false }, headers);
  assert.equal(second.status, 200); assert.deepEqual(second.body, first.body);
  const replacementMarker = { ...marker, commandId: randomUUID(), digest: createHash('sha256').update('synthetic-gate-updated').digest('hex'),
    audit: { ...marker.audit, activity: 'UPDATE', targetReferences: [`Observation/${first.body.id}`, fixture.patientReference] } };
  const replacement = { ...first.body, extension: payload.extension.filter(e => e.url !== SUPPORTS_DIAGNOSIS_URL),
    component: payload.component.map(c => c.code.coding?.some(v => v.code === 'R10_OPERATION') ? comp('R10_OPERATION', JSON.stringify(replacementMarker)) : c) };
  const match = { 'If-Match': `W/"${first.body.meta.versionId}"` };
  const updated = await request(role, 'PUT', `/fhir/R4/Observation/${first.body.id}`, replacement, match);
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.component, replacement.component);
  assert.deepEqual(updated.body.extension, replacement.extension);
  const stale = await request(role, 'PUT', `/fhir/R4/Observation/${first.body.id}`, { ...replacement, valueBoolean: false }, match);
  assert.equal(stale.status, 412);
  const after = await ok(role, 'GET', `/fhir/R4/Observation/${first.body.id}`);
  assert.deepEqual(after, updated.body);
  const owners = await search(role, 'Observation', { identifier: `${identifier.system}|${identifier.value}` });
  assert.equal(owners.length, 1);
  return { firstStatus: first.status, secondStatus: second.status, secondCreated: false, reference: `Observation/${first.body.id}`,
    initialVersion: first.body.meta.versionId, updatedVersion: updated.body.meta.versionId, updateStatus: updated.status, staleStatus: stale.status,
    markerAndExtensionsRoundTrip: true, staleRecordUnchanged: true, persistedCount: owners.length };
}

async function gateC(role) {
  const tag = fixture.principals[role].gateTag;
  assert.ok(tag, 'Run G-a first.');
  const records = await search(role, 'Provenance', { _tag: tag });
  assert.equal(records.length, 1);
  assert.ok(records[0].meta.tag.some(t => `${t.system}|${t.code}` === tag));
  return { tag, count: records.length, reference: `Provenance/${records[0].id}` };
}

async function gateD(role) {
  const firstTag = fixture.principals[role].gateTag;
  const secondCode = createHash('sha256').update(randomUUID()).digest('hex');
  const secondTag = `${operationSystem}|${secondCode}`;
  const absent = `${operationSystem}|${createHash('sha256').update(randomUUID()).digest('hex')}`;
  const second = await ok(role, 'POST', '/fhir/R4/Provenance', audit(role, secondCode), { 'If-None-Exist': `_tag=${secondTag}` });
  const records = await search(role, 'Provenance', { _tag: `${firstTag},${secondTag},${absent}` });
  assert.equal(records.length, 2);
  assert.ok(records.some(r => r.id === second.id));
  assert.deepEqual(records.flatMap(r => r.meta.tag.map(t => `${t.system}|${t.code}`)).sort(), [firstTag, secondTag].sort());
  return { query: `${firstTag},${secondTag},${absent}`, count: records.length, references: records.map(r => `Provenance/${r.id}`) };
}

function liveClient(role, hooks = {}) {
  const checked = async (method, path, body, headers) => {
    const response = await request(role, method, path, body, headers);
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Synthetic FHIR HTTP ${response.status}`), { status: response.status });
    return response;
  };
  return {
    baseUrl,
    async read(type, id) { await hooks.beforeRead?.(type, id); return (await checked('GET', `/fhir/R4/${type}/${id}`)).body; },
    async search(type, params = {}) { await hooks.beforeSearch?.(type, params); return (await checked('GET', `/fhir/R4/${type}?${new URLSearchParams(params)}`)).body; },
    async searchUrl(url, type) { await hooks.beforeSearch?.(type, {}); return (await checked('GET', url)).body; },
    async createWithOutcome(resource, headers = {}) {
      const write = { method: 'POST', resource, headers };
      await hooks.beforeWrite?.(write);
      const response = await checked('POST', `/fhir/R4/${resource.resourceType}`, resource, headers);
      await hooks.afterWrite?.(write, response.body);
      return { resource: response.body, created: response.status === 201 };
    },
    async update(type, id, resource, headers = {}) {
      const write = { method: 'PUT', resource, headers };
      await hooks.beforeWrite?.(write);
      const response = await checked('PUT', `/fhir/R4/${type}/${id}`, resource, headers);
      await hooks.afterWrite?.(write, response.body);
      return response.body;
    },
  };
}

async function writerProofs(filter) {
  load(); await refresh();
  const { executeFindingCommand } = await import('../src/clinical-graph/current-finding-writer.ts');
  const { loadEncounterFindingState, projectCurrentFindings } = await import('../src/clinical-graph/current-finding-reader.ts');
  const writerResults = [];
  const state = (extra = {}) => ({ status: 'live', presence: 'present', qualifiers: {}, homes: [], ...extra });
  const proof = async (role, name, test) => {
    if (filter && name !== filter) return;
    scenario = `${role}/${name}`;
    const start = events.length + 1;
    try {
      const encounter = await ok(role, 'POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'in-progress', class: { code: 'synthetic' }, subject: { reference: fixture.patientReference } });
      const key = (eye = 'OD') => ({ v: 1, patientId: fixture.patientReference.slice(8), encounterId: encounter.id, stableKey: lens.stableKey, fieldCode: lensField, optionCode: nuclear.optionCode, eye });
      const fact = (eye = 'OD', baseline = { kind: 'absent', key: key(eye) }, value = state()) => ({ kind: 'fact', key: key(eye), baseline, state: value });
      const command = targets => ({ commandId: randomUUID(), patientReference: fixture.patientReference, encounterReference: `Encounter/${encounter.id}`, surface: 'r10-live-proof', targets });
      const deps = (hooks = {}) => ({ fhir: liveClient(role, hooks), definitions, catalog, staffReference: fixture.principals[role].profileReference });
      const owner = async (eye = 'OD') => {
        const identifier = currentFindingIdentifier(key(eye));
        return search(role, 'Observation', { identifier: `${identifier.system}|${identifier.value}` });
      };
      const baseline = observation => ({ kind: 'canonical', reference: `Observation/${observation.id}`, versionId: observation.meta.versionId });
      const allAudits = async () => {
        const owners = [...await owner('OD'), ...await owner('OS')];
        const rows = await Promise.all(owners.map(o => search(role, 'Provenance', { target: `Observation/${o.id}` })));
        return [...new Map(rows.flat().map(r => [r.id, r])).values()];
      };
      const detail = await test({ key, fact, command, deps, owner, baseline, allAudits, encounter, role, execute: executeFindingCommand });
      writerResults.push({ role, login: fixture.principals[role].email, policyId: fixture.principals[role].policyId, probe: name, status: 'PASS', firstEvent: start, lastEvent: events.length, detail });
    } catch (error) {
      writerResults.push({ role, login: fixture.principals[role].email, policyId: fixture.principals[role].policyId, probe: name, status: 'FAIL', firstEvent: start, lastEvent: events.length, error: error.message });
      throw error;
    } finally {
      const suffix = filter ? `-${filter}` : '';
      evidence(`writer-results${suffix}.json`, { sourceHead: command('git', ['rev-parse', 'HEAD']), server: fixture.health,
        sourceHashes: Object.fromEntries(['identity', 'reader', 'writer'].map(part => [part, createHash('sha256').update(readFileSync(resolve(root, `mcp/src/clinical-graph/current-finding-${part}.ts`))).digest('hex')])), results: writerResults });
      evidence(`writer-http${suffix}.json`, { events });
      console.log(JSON.stringify(writerResults.at(-1)));
    }
  };
  for (const role of ['provider', 'staff']) {
    await proof(role, 'W1', async ({ fact, command, deps, owner, baseline, execute }) => {
      await execute(deps(), command([fact()]));
      const original = (await owner())[0]; let injected = false;
      const result = await execute(deps({ beforeWrite: async w => {
        if (w.method === 'PUT' && w.resource.resourceType === 'Observation' && !injected) {
          injected = true;
          await ok(role, 'PUT', `/fhir/R4/Observation/${original.id}`, { ...original, valueBoolean: false }, { 'If-Match': `W/"${original.meta.versionId}"` });
        }
      } }), command([fact('OD', baseline(original), state({ qualifiers: { grade: '2+' } }))]));
      assert.equal(injected, true); assert.equal(result.outcomes[0].status, 'conflict');
      assert.equal((await owner())[0].valueBoolean, false);
      return { result, concurrentEditPreserved: true };
    });
    for (const name of ['W2', 'W23']) await proof(role, name, async ({ fact, command, deps, owner, allAudits, execute }) => {
      let release; let arrivals = 0;
      const barrier = new Promise(resolve => { release = resolve; });
      const hooks = { beforeWrite: async w => {
        if (w.method !== 'POST' || w.resource.resourceType !== 'Observation') return;
        if (++arrivals === 2) release();
        let timer;
        try { await Promise.race([barrier, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Writer create barrier did not receive both calls.')), 10000); })]); }
        finally { clearTimeout(timer); }
      } };
      const first = command([fact()]); const second = name === 'W2' ? first : command([{ ...fact(), state: state({ presence: 'absent' }) }]);
      const results = await Promise.all([execute(deps(hooks), first), execute(deps(hooks), second)]);
      const owners = await owner(); const audits = await allAudits();
      assert.equal(owners.length, 1); assert.equal(audits.length, 1);
      assert.deepEqual(results.map(r => r.outcomes[0].status).sort(), name === 'W2' ? ['already-applied', 'applied'] : ['applied', 'conflict']);
      return { results, ownerCount: owners.length, auditCount: audits.length, synchronizedCreates: arrivals };
    });
    await proof(role, 'W13', async ({ fact, command, deps, owner, execute }) => {
      const c = command([fact()]); await execute(deps(), c);
      const original = (await owner())[0];
      await ok(role, 'PUT', `/fhir/R4/Observation/${original.id}`, { ...original, status: 'entered-in-error' }, { 'If-Match': `W/"${original.meta.versionId}"` });
      const replay = await execute(deps(), c);
      assert.equal(replay.outcomes[0].status, 'conflict');
      return { replay, editPreserved: (await owner())[0].status === 'entered-in-error' };
    });
    await proof(role, 'W19', async ({ fact, command, deps, allAudits, execute }) => {
      const c = command([fact()]); await execute(deps(), c); const replay = await execute(deps(), c);
      const audits = await allAudits();
      assert.equal(replay.outcomes[0].status, 'already-applied'); assert.equal(audits.length, 1);
      return { replay, auditCount: audits.length };
    });
    await proof(role, 'W20', async ({ fact, command, deps, owner, baseline, allAudits, execute }) => {
      const frozenTime = '2026-09-16T12:00:00.000Z';
      const first = await execute({ ...deps({ beforeWrite: w => { if (w.resource.resourceType === 'Provenance') {
        events.push({ scenario, role, fault: 'Definitive synthetic audit refusal before transport', status: 403 });
        throw Object.assign(new Error('Synthetic audit refusal'), { status: 403 });
      } } }), now: () => frozenTime }, command([fact()]));
      assert.equal(first.outcomes[0].status, 'applied'); assert.equal(first.outcomes[0].auditPending, true);
      const o = (await owner())[0];
      const second = await execute({ ...deps(), now: () => '2026-09-16T13:00:00.000Z' }, command([fact('OD', baseline(o), state({ presence: 'absent' }))]));
      const audits = await allAudits(); const repaired = audits.filter(a => a.recorded === frozenTime);
      assert.equal(second.complete, true); assert.equal(repaired.length, 1); assert.equal(audits.length, 2);
      assert.ok(repaired[0].target.some(t => t.reference === `Observation/${o.id}`));
      assert.ok(!repaired[0].target.some(t => t.reference === 'self'));
      return { first, second, repairedAudit: repaired[0], auditCount: audits.length };
    });
    await proof(role, 'lost-second-response', async ({ fact, command, deps, owner, allAudits, execute }) => {
      let lost = false;
      const unavailable = type => { if (lost && type === 'Observation') {
        events.push({ scenario, role, fault: 'Synthetic recovery read unavailable' }); throw new Error('Synthetic read unavailable');
      } };
      const faulted = deps({ beforeRead: unavailable, beforeSearch: unavailable, afterWrite: w => {
        if (w.resource.resourceType === 'Observation' && parseCurrentFindingEnvelope(w.resource).key?.eye === 'OS') {
          lost = true; events.push({ scenario, role, fault: 'Second Observation response discarded after server committed' }); throw new Error('Synthetic lost response');
        }
      } });
      const c = command([fact(), fact('OS')]); const first = await execute(faulted, c);
      assert.deepEqual(first.outcomes.map(o => o.status), ['applied', 'unconfirmed']); assert.equal(first.complete, false);
      const replay = await execute(deps(), c);
      assert.deepEqual(replay.outcomes.map(o => o.status), ['already-applied', 'already-applied']);
      assert.equal(replay.complete, true); assert.equal((await owner()).length, 1); assert.equal((await owner('OS')).length, 1);
      assert.equal((await allAudits()).length, 2);
      return { first, replay, ownerCount: 2, auditCount: 2 };
    });
  }
  await proof('staff', 'staff-unlink', async ({ key, fact, command, deps, encounter, execute }) => {
    const source = await ok('staff', 'POST', '/fhir/R4/Observation', { resourceType: 'Observation', status: 'preliminary', code: odosConcept(lens.stableKey),
      subject: { reference: fixture.patientReference }, encounter: { reference: `Encounter/${encounter.id}` }, effectiveDateTime: new Date().toISOString(),
      extension: [{ url: ODOS_EXTENSION_URLS.eyeLaterality, valueCodeableConcept: lateralityConcept('OD') }],
      component: [comp(`OD_${lensField}::nuclear-sclerosis`, true), comp(`OD_${lensField}::cortical-cataract`, true)] });
    const condition = await ok('provider', 'POST', '/fhir/R4/Condition', { ...buildEncounterDiagnosisCondition({ patientReference: fixture.patientReference,
      encounterReference: `Encounter/${encounter.id}`, code: { text: 'Synthetic unlink home' }, verificationStatus: 'confirmed' }), evidence: [{ detail: [{ reference: `Observation/${source.id}` }] }] });
    const input = { patientReference: fixture.patientReference, encounterReference: `Encounter/${encounter.id}`, definitions, catalog };
    const before = projectCurrentFindings(await loadEncounterFindingState(deps().fhir, input));
    const addressed = before.currentFacts.find(f => f.key.optionCode === key().optionCode);
    let conditionAttempts = 0; let observationAttempts = 0;
    const result = await execute(deps({ beforeWrite: w => { if (w.resource.resourceType === 'Condition') conditionAttempts++; if (w.resource.resourceType === 'Observation') observationAttempts++; } }), command([fact('OD', addressed.baseline, state())]));
    const after = projectCurrentFindings(await loadEncounterFindingState(deps().fhir, input));
    assert.equal(result.complete, true); assert.equal(conditionAttempts, 0); assert.equal(observationAttempts, 1);
    assert.deepEqual(after.currentFacts.find(f => f.key.optionCode === key().optionCode).homes, []);
    assert.deepEqual(after.currentFacts.find(f => f.key.optionCode === 'cortical-cataract').homes, [`Condition/${condition.id}`]);
    assert.deepEqual(await ok('provider', 'GET', `/fhir/R4/Condition/${condition.id}`), condition);
    assert.deepEqual(await ok('staff', 'GET', `/fhir/R4/Observation/${source.id}`), source);
    return { result, attemptedConditionWrites: conditionAttempts, observationWrites: observationAttempts, siblingHomePreserved: true };
  });
}

try {
  const action = process.argv[2];
  if (action === 'up') await up();
  else if (action === 'start') await start();
  else if (action === 'seed') await seed();
  else if (action === 'recompile-policies') await recompilePolicies();
  else if (action === 'writer') await writerProofs(process.argv[3]);
  else if (action === 'gate-a') {
    load(); await refresh();
    for (const role of ['provider', 'staff']) await probe(role, 'G-a', () => gateA(role));
  } else if (action === 'gate-rest') {
    load(); await refresh();
    const prior = JSON.parse(readFileSync(resolve(evidenceDir, 'gate-results.json'), 'utf8'));
    assert.equal(prior.stop, false); results.push(...prior.results);
    events.push(...JSON.parse(readFileSync(resolve(evidenceDir, 'gate-http.json'), 'utf8')).events);
    for (const role of ['provider', 'staff']) {
      await probe(role, 'G-b', () => gateB(role));
      await probe(role, 'G-c', () => gateC(role));
      await probe(role, 'G-d', () => gateD(role));
    }
  } else throw new Error('Usage: node --import tsx mcp/scripts/r10-a2a-preflight.mjs up|start|seed|recompile-policies|gate-a|gate-rest');
} catch (error) {
  console.error(sanitizePublishedText(error.message));
  process.exitCode = 1;
}
