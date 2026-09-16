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
import { handleDiagnosisFindingsMutationRequest, materializeAtomicFindingCatalog } from '../src/clinical-graph/diagnosis-findings-endpoint.ts';
import { buildAnteriorOcularHealthDefinitions } from '../src/clinical-graph/ocular-health-definition.ts';
import { buildEncounterDiagnosisCondition } from '../src/fhir/condition.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const privateDir = resolve(root, '.odos/r10-a1');
const evidenceDir = resolve(root, 'docs/evidence/r10-a1');
const projectName = 'odos-r10-a1';
const port = 29013;
const baseUrl = `http://127.0.0.1:${port}`;
const image = 'medplum/medplum-server@sha256:358ab425b29390067b6cb82bfbaeee48580a703f7cc5b730bed2b2ba7184c1de';
const identifierSystem = 'urn:odos:current-finding:v1';
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
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { Authorization: `Bearer ${principal.token}`, 'Content-Type': 'application/fhir+json', 'X-Medplum': 'extended', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  const resource = raw ? JSON.parse(raw) : undefined;
  const event = { sequence: events.length + 1, scenario, role, login: principal.email, start, method, path, status: response.status,
    requestHeaders: headers, etag: response.headers.get('etag'), location: response.headers.get('location'),
    ...(path.startsWith('/fhir/') ? { request: body, response: resource } : {}) };
  events.push(event);
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
  fixture = { projectName, baseUrl, sourceHead: command('git', ['rev-parse', 'HEAD']), email: 'r10-seeder@example.invalid',
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
  }, volumes: { 'postgres-data': {} }, networks: { default: { ipam: { config: [{ subnet: '10.249.83.0/24' }] } } } });
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
  const project = await ok('seeder', 'POST', '/fhir/R4/Project', { resourceType: 'Project', name: 'R10 synthetic preflight', features: [], link: [] });
  fixture.projectId = project.id;
  const patient = await ok('seeder', 'POST', '/fhir/R4/Patient', { resourceType: 'Patient', meta: { project: project.id }, name: [{ family: 'Synthetic', given: ['R10'] }] });
  fixture.patientReference = `Patient/${patient.id}`;
  const encounter = await ok('seeder', 'POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', meta: { project: project.id }, status: 'in-progress', class: { code: 'synthetic' }, subject: { reference: fixture.patientReference } });
  fixture.encounterReference = `Encounter/${encounter.id}`;
  for (const role of ['provider', 'staff']) {
    const compiled = buildMedplumAccessPolicy(getRoleDeclaration(role));
    const policy = await ok('seeder', 'POST', '/fhir/R4/AccessPolicy', { ...compiled, meta: { ...compiled.meta, project: project.id } });
    const email = `r10-${role}@example.invalid`;
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

function observation(key, value = true) {
  return { resourceType: 'Observation', status: 'preliminary', identifier: [{ system: identifierSystem, value: key }],
    code: { text: 'Synthetic R10 preflight finding' }, subject: { reference: fixture.patientReference }, encounter: { reference: fixture.encounterReference },
    valueBoolean: value, component: [{ code: { text: 'Synthetic retained qualifier' }, valueString: 'retained' }] };
}

async function search(role, params) {
  const bundle = await ok(role, 'GET', `/fhir/R4/Observation?${new URLSearchParams({ ...params, _count: '1000', _total: 'accurate' })}`);
  assert.ok(!bundle.link?.some(link => link.relation === 'next'), 'Preflight search unexpectedly paginated.');
  return bundle.entry?.flatMap(entry => entry.resource ? [entry.resource] : []) ?? [];
}

async function probe(role, name, execute) {
  scenario = `${role}/${name}`;
  const start = events.length + 1;
  try {
    const detail = await execute(); results.push({ role, probe: name, status: name === 'P4' ? 'INFORMATIONAL' : 'PASS', firstEvent: start, lastEvent: events.length, detail });
  } catch (error) {
    results.push({ role, probe: name, status: 'FAIL', firstEvent: start, lastEvent: events.length, error: error.message });
  }
  evidence('preflight-http.json', { events });
  evidence('preflight-results.json', { sourceHead: fixture.sourceHead, results, stop: results.some(result => result.status === 'FAIL' && result.probe !== 'P4') });
  console.log(JSON.stringify(results.at(-1)));
}

function transport(role) {
  return {
    baseUrl,
    read: (type, id) => ok(role, 'GET', `/fhir/R4/${type}/${id}`),
    search: (type, params = {}) => ok(role, 'GET', `/fhir/R4/${type}?${new URLSearchParams(params)}`),
    searchUrl: url => ok(role, 'GET', url),
    create: (resource, headers) => ok(role, 'POST', `/fhir/R4/${resource.resourceType}`, resource, headers),
    update: (type, id, resource, headers) => ok(role, 'PUT', `/fhir/R4/${type}/${id}`, resource, headers),
  };
}

async function lostResponse(role) {
  const other = role === 'provider' ? 'staff' : 'provider';
  const encounter = await ok(role, 'POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'in-progress', class: { code: 'synthetic' }, subject: { reference: fixture.patientReference } });
  const encounterReference = `Encounter/${encounter.id}`;
  const condition = await ok('provider', 'POST', '/fhir/R4/Condition', buildEncounterDiagnosisCondition({
    patientReference: fixture.patientReference, encounterReference, code: { text: 'Synthetic R10 writer witness' }, verificationStatus: 'confirmed',
  }));
  const definitions = buildAnteriorOcularHealthDefinitions({ source: 'manual', recordedAt: new Date().toISOString(), actorReference: fixture.principals[role].profileReference });
  const row = materializeAtomicFindingCatalog(definitions)[0];
  assert.ok(row);
  const auth = {};
  for (const principalRole of [role, other]) {
    const me = await ok(principalRole, 'GET', '/auth/me');
    assert.equal(me.profile.reference ?? `${me.profile.resourceType}/${me.profile.id}`, fixture.principals[principalRole].profileReference);
    assert.equal(me.membership.admin, false);
    auth[principalRole] = { staffReference: fixture.principals[principalRole].profileReference, actorRole: principalRole, fhir: transport(principalRole) };
  }
  const mutate = async (principalRole, presence) => {
    const result = await handleDiagnosisFindingsMutationRequest({ fhirBaseUrl: baseUrl,
      authenticate: async header => header === `Bearer ${fixture.principals[principalRole].token}` ? auth[principalRole] : null,
      findingDefinitions: () => definitions,
    }, { authHeader: `Bearer ${fixture.principals[principalRole].token}`, params: { encounterId: encounter.id },
      body: { action: 'assert', patientReference: fixture.patientReference, conditionReference: `Condition/${condition.id}`, atomicFindingId: row.atomicFindingId, presence, laterality: 'OD' } });
    events.push({ sequence: events.length + 1, scenario, role: principalRole, seam: 'handleDiagnosisFindingsMutationRequest', status: result.status, response: result.body });
    return result;
  };
  const countWrites = () => events.filter(e => e.scenario === scenario && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method) && e.path?.startsWith('/fhir/')).length;
  const command = { presence: 'present', expectedVersion: undefined };
  const initialResult = await mutate(role, command.presence);
  const reloaded = await search(role, { encounter: encounterReference, code: row.atomicFindingId });
  assert.equal(reloaded.length, 1); assert.equal(reloaded[0].valueBoolean, true);
  const baseline = reloaded[0];
  const staffRefusal = role === 'staff' && events.some(e => e.scenario === scenario && e.method === 'PUT' && e.path === `/fhir/R4/Condition/${condition.id}` && e.status === 403);
  if (role === 'provider') assert.equal(initialResult.status, 200, JSON.stringify(initialResult.body));
  else assert.ok(staffRefusal, 'Staff Condition refusal must be observed, not assumed.');
  // This is the diagnostic client's recovery path, not an A2 application writer.
  const retry = async (originalCommand) => {
    const rows = await search(role, { encounter: encounterReference, code: row.atomicFindingId });
    const home = await ok(role, 'GET', `/fhir/R4/Condition/${condition.id}`);
    assert.equal(rows.length, 1);
    const current = rows[0];
    const linked = home.evidence?.some(e => e.detail?.some(d => d.reference === `Observation/${current.id}`)) === true;
    if (current.valueBoolean === (originalCommand.presence === 'present')) {
      return { outcome: linked ? 'already-applied' : 'partial-refused' };
    }
    if (current.meta.versionId !== originalCommand.expectedVersion) return { outcome: 'conflict' };
    return mutate(role, originalCommand.presence);
  };
  const beforeRetry = countWrites();
  const retried = await retry(command);
  const retryWrites = countWrites() - beforeRetry;
  assert.equal(retryWrites, 0, 'Executing the lost-response retry must not issue a second FHIR write.');
  assert.equal(retried.outcome, role === 'provider' ? 'already-applied' : 'partial-refused');
  assert.deepEqual(await ok(role, 'GET', `/fhir/R4/Observation/${baseline.id}`), baseline);
  await ok(other, 'PUT', `/fhir/R4/Observation/${baseline.id}`, { ...baseline, valueBoolean: false }, { 'If-Match': `W/"${baseline.meta.versionId}"` });
  const intervening = await ok(role, 'GET', `/fhir/R4/Observation/${baseline.id}`);
  assert.notEqual(intervening.meta.versionId, baseline.meta.versionId); assert.equal(intervening.valueBoolean, false);
  const beforeConflictRetry = countWrites();
  const conflicted = await retry(command);
  const conflictRetryWrites = countWrites() - beforeConflictRetry;
  assert.equal(conflictRetryWrites, 0, 'Retry after an intervening edit must not overwrite it.');
  assert.equal(conflicted.outcome, 'conflict');
  assert.deepEqual(await ok(role, 'GET', `/fhir/R4/Observation/${baseline.id}`), intervening);
  const stale = await request(role, 'PUT', `/fhir/R4/Observation/${baseline.id}`, baseline, { 'If-Match': `W/"${baseline.meta.versionId}"` });
  assert.equal(stale.status, 412);
  assert.deepEqual(await ok(role, 'GET', `/fhir/R4/Observation/${baseline.id}`), intervening);
  assert.equal((await search(role, { encounter: encounterReference, code: row.atomicFindingId })).length, 1);
  return { id: baseline.id, retryOutcome: retried.outcome, retryWrites, conflictRetryOutcome: conflicted.outcome, conflictRetryWrites,
    baselineVersion: baseline.meta.versionId, interveningRole: other, interveningVersion: intervening.meta.versionId,
    staleStatus: stale.status, staffConditionRefusal: staffRefusal,
    scope: 'Executed diagnostic client retry against real endpoint writes and HTTP reads; not an implemented A2 application retry protocol.' };

}

async function run() {
  load(); await refresh();
  for (const role of ['provider', 'staff']) {
    const unique = label => createHash('sha256').update(`${randomUUID()}:${role}:${label}`).digest('hex');
    await probe(role, 'P1', async () => {
      const key = unique('race'); const query = `identifier=${encodeURIComponent(`${identifierSystem}|${key}`)}`;
      const responses = await Promise.all([true, false].map(value => request(role, 'POST', '/fhir/R4/Observation', observation(key, value), { 'If-None-Exist': query })));
      const rows = await search(role, { identifier: `${identifierSystem}|${key}` });
      assert.equal(rows.length, 1, 'Concurrent conditional creates duplicated one identifier.');
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
      assert.ok(responses.every(r => r.body.id === rows[0].id));
      const existing = await request(role, 'POST', '/fhir/R4/Observation', observation(key, !rows[0].valueBoolean), { 'If-None-Exist': query });
      assert.equal(existing.status, 200); assert.equal(existing.body.meta.versionId, rows[0].meta.versionId);
      const retired = await ok(role, 'PUT', `/fhir/R4/Observation/${rows[0].id}`, { ...rows[0], status: 'entered-in-error' }, { 'If-Match': `W/"${rows[0].meta.versionId}"` });
      const rematch = await request(role, 'POST', '/fhir/R4/Observation', observation(key), { 'If-None-Exist': query });
      assert.equal(rematch.status, 200); assert.equal(rematch.body.id, retired.id); assert.equal(rematch.body.status, 'entered-in-error');
      assert.equal((await search(role, { identifier: `${identifierSystem}|${key}` })).length, 1);
      const duplicateKey = unique('duplicate');
      await ok(role, 'POST', '/fhir/R4/Observation', observation(duplicateKey));
      await ok(role, 'POST', '/fhir/R4/Observation', observation(duplicateKey));
      const duplicate = await request(role, 'POST', '/fhir/R4/Observation', observation(duplicateKey), { 'If-None-Exist': `identifier=${encodeURIComponent(`${identifierSystem}|${duplicateKey}`)}` });
      assert.equal(duplicate.status, 412); assert.equal((await search(role, { identifier: `${identifierSystem}|${duplicateKey}` })).length, 2);
      return { concurrentStatuses: responses.map(r => r.status), id: rows[0].id, existingStatus: existing.status, retiredStatus: rematch.status, duplicateStatus: duplicate.status };
    });
    await probe(role, 'P2', async () => {
      const initial = await ok(role, 'POST', '/fhir/R4/Observation', observation(unique('update')));
      const fresh = await request(role, 'PUT', `/fhir/R4/Observation/${initial.id}`, { ...initial, valueBoolean: false }, { 'If-Match': `W/"${initial.meta.versionId}"` });
      assert.equal(fresh.status, 200);
      const stale = await request(role, 'PUT', `/fhir/R4/Observation/${initial.id}`, { ...initial, valueBoolean: true }, { 'If-Match': `W/"${initial.meta.versionId}"` });
      const persisted = await ok(role, 'GET', `/fhir/R4/Observation/${initial.id}`);
      assert.equal(stale.status, 412); assert.deepEqual(persisted, fresh.body);
      const races = [];
      for (let i = 0; i < 5; i++) {
        const baseline = await ok(role, 'GET', `/fhir/R4/Observation/${initial.id}`);
        const race = await Promise.all(['left', 'right'].map(value => request(role, 'PUT', `/fhir/R4/Observation/${initial.id}`,
          { ...baseline, component: [{ code: { text: 'Synthetic race value' }, valueString: `${value}-${i}` }] }, { 'If-Match': `W/"${baseline.meta.versionId}"` })));
        races.push(race.map(r => r.status));
        const after = await ok(role, 'GET', `/fhir/R4/Observation/${initial.id}`);
        assert.deepEqual(race.map(r => r.status).sort(), [200, 412], 'Same-version concurrent updates must have exactly one winner.');
        assert.deepEqual(after, race.find(r => r.status === 200).body);
      }
      const count = (await search(role, { identifier: `${identifierSystem}|${initial.identifier[0].value}` })).length;
      assert.equal(count, 1); return { freshStatus: fresh.status, staleStatus: stale.status, races, count };
    });
    await probe(role, 'P3', async () => {
      const observed = [];
      for (const status of ['entered-in-error', 'cancelled']) {
        const key = unique(status);
        const row = await ok('seeder', 'POST', '/fhir/R4/Observation', { ...observation(key), status, meta: { project: fixture.projectId } });
        const identifier = await search(role, { identifier: `${identifierSystem}|${key}` });
        const encounter = await search(role, { encounter: fixture.encounterReference });
        assert.ok(identifier.some(r => r.id === row.id)); assert.ok(encounter.some(r => r.id === row.id));
        observed.push({ status, id: row.id, identifierCount: identifier.length, encounterCount: encounter.length });
      }
      return observed;
    });
    await probe(role, 'P4', async () => {
      const original = await ok(role, 'POST', '/fhir/R4/Observation', observation(unique('history')));
      await ok(role, 'PUT', `/fhir/R4/Observation/${original.id}`, { ...original, valueBoolean: false }, { 'If-Match': `W/"${original.meta.versionId}"` });
      const response = await request(role, 'GET', `/fhir/R4/Observation/${original.id}/_history`);
      const old = response.body?.entry?.find(e => e.resource?.meta?.versionId === original.meta.versionId)?.resource;
      return { status: response.status, oldVersionReturned: !!old, olderComponentsRetained: JSON.stringify(old?.component) === JSON.stringify(original.component),
        count: (await search(role, { identifier: `${identifierSystem}|${original.identifier[0].value}` })).length };
    });
    await probe(role, 'P5', async () => {
      const original = await ok(role, 'POST', '/fhir/R4/Observation', observation(unique('restore')));
      let current = original; const versions = [current.meta.versionId];
      for (const status of ['entered-in-error', 'preliminary', 'preliminary']) {
        current = await ok(role, 'PUT', `/fhir/R4/Observation/${original.id}`, { ...current, status, valueBoolean: !current.valueBoolean }, { 'If-Match': `W/"${current.meta.versionId}"` });
        assert.equal(current.id, original.id); assert.deepEqual(current.identifier, original.identifier); assert.deepEqual(current.component, original.component);
        versions.push(current.meta.versionId);
      }
      const count = (await search(role, { identifier: `${identifierSystem}|${original.identifier[0].value}` })).length;
      assert.equal(count, 1); return { id: original.id, versions, count };
    });
    await probe(role, 'P6', async () => {
      const unrelated = await ok(role, 'POST', '/fhir/R4/Observation', observation(unique('unrelated')));
      const added = await ok(role, 'POST', '/fhir/R4/Observation', observation(unique('added')));
      const original = await ok('provider', 'POST', '/fhir/R4/Condition', { resourceType: 'Condition', code: { text: 'Synthetic R10 evidence condition' },
        subject: { reference: fixture.patientReference }, encounter: { reference: fixture.encounterReference }, evidence: [{ detail: [{ reference: `Observation/${unrelated.id}` }] }] });
      const update = await request(role, 'PUT', `/fhir/R4/Condition/${original.id}`, { ...original, evidence: [...original.evidence, { detail: [{ reference: `Observation/${added.id}` }] }] }, { 'If-Match': `W/"${original.meta.versionId}"` });
      const stale = await request(role, 'PUT', `/fhir/R4/Condition/${original.id}`, original, { 'If-Match': `W/"${original.meta.versionId}"` });
      const persisted = await ok(role, 'GET', `/fhir/R4/Condition/${original.id}`);
      const provenance = await request(role, 'POST', '/fhir/R4/Provenance', { resourceType: 'Provenance', recorded: new Date().toISOString(),
        target: [{ reference: `Condition/${original.id}` }, { reference: fixture.patientReference }], agent: [{ who: { reference: fixture.principals[role].profileReference } }] });
      assert.equal(provenance.status, 201);
      const counts = await ok(role, 'GET', `/fhir/R4/Condition?_id=${original.id}&_total=accurate`);
      assert.equal(counts.entry?.length, 1);
      assert.equal(update.status, 200, 'Condition evidence update must be permitted under the named role.');
      assert.equal(stale.status, 412); assert.deepEqual(persisted.evidence, update.body.evidence);
      return { id: original.id, updateStatus: update.status, staleStatus: stale.status, evidence: persisted.evidence, provenanceId: provenance.body.id, conditionCount: counts.entry.length };
    });
    await probe(role, 'P7', () => lostResponse(role));
  }
  process.exitCode = results.some(result => result.status === 'FAIL' && result.probe !== 'P4') ? 2 : 0;
}

async function staffLinkAmendment() {
  load();
  const previous = JSON.parse(readFileSync(resolve(evidenceDir, 'preflight-results.json'), 'utf8'));
  assert.equal(previous.sourceHead, fixture.sourceHead);
  assert.ok(!previous.results.some(result => result.probe === 'P6-finding-link'), 'Amendment already recorded.');
  events.push(...JSON.parse(readFileSync(resolve(evidenceDir, 'preflight-http.json'), 'utf8')).events);
  results.push(...previous.results);
  const ruling = 'performance-od/decisions/2026-09-15-odos-staff-finding-links-on-the-finding-record.md';
  for (const name of ['P6', 'P7']) {
    const result = results.find(result => result.role === 'staff' && result.probe === name);
    assert.equal(result.status, 'FAIL');
    assert.ok(events.some(event => event.scenario === `staff/${name}` && event.method === 'PUT' &&
      event.path.startsWith('/fhir/R4/Condition/') && event.status === 403));
    Object.assign(result, { previousStatus: result.status, status: 'EXPECTED_UNDER_RULING', ruling,
      interpretation: name === 'P6' ? 'Staff must not update Condition. Finding-side link capability is proved separately.' :
        'Existing writer partial-write refusal retained as evidence; P7 is provider-only under revision 2.1.' });
  }
  await refresh();
  await probe('staff', 'P6-finding-link', async () => {
    const conditionEvent = events.find(event => event.scenario === 'staff/P6' && event.method === 'POST' && event.path === '/fhir/R4/Condition');
    const conditionReference = `Condition/${conditionEvent.response.id}`;
    const conditionBefore = await ok('staff', 'GET', `/fhir/R4/${conditionReference}`);
    const key = createHash('sha256').update(randomUUID()).digest('hex');
    const baseline = await ok('staff', 'POST', '/fhir/R4/Observation', observation(key));
    const extension = { url: 'https://odos2020.com/fhir/StructureDefinition/supports-diagnosis', valueReference: { reference: conditionReference } };
    const fresh = await request('staff', 'PUT', `/fhir/R4/Observation/${baseline.id}`, { ...baseline, extension: [...(baseline.extension ?? []), extension] },
      { 'If-Match': `W/"${baseline.meta.versionId}"` });
    assert.equal(fresh.status, 200);
    const stale = await request('staff', 'PUT', `/fhir/R4/Observation/${baseline.id}`, baseline, { 'If-Match': `W/"${baseline.meta.versionId}"` });
    assert.equal(stale.status, 412);
    const persisted = await ok('staff', 'GET', `/fhir/R4/Observation/${baseline.id}`);
    assert.deepEqual(persisted, fresh.body);
    assert.deepEqual(persisted.extension, [extension]);
    assert.deepEqual(persisted.component, baseline.component);
    assert.deepEqual(await ok('staff', 'GET', `/fhir/R4/${conditionReference}`), conditionBefore);
    const count = (await search('staff', { identifier: `${identifierSystem}|${key}` })).length;
    assert.equal(count, 1);
    return { id: baseline.id, baselineVersion: baseline.meta.versionId, updatedVersion: persisted.meta.versionId,
      freshStatus: fresh.status, staleStatus: stale.status, conditionReference, conditionUnchanged: true, count };
  });
  evidence('preflight-results.json', { sourceHead: fixture.sourceHead, revision: '2.1', ruling,
    amendment: 'Only P6-finding-link executed; original P1–P7 evidence retained.', results,
    stop: results.some(result => result.status === 'FAIL') });
  writeFileSync(resolve(evidenceDir, 'preflight-amendment-output.txt'), JSON.stringify(results.at(-1)) + '\n');
  process.exitCode = results.at(-1).status === 'PASS' ? 0 : 2;
}

async function rerunP7() {
  load();
  const previous = JSON.parse(readFileSync(resolve(evidenceDir, 'preflight-results.json'), 'utf8'));
  events.push(...JSON.parse(readFileSync(resolve(evidenceDir, 'preflight-http.json'), 'utf8')).events);
  results.push(...previous.results.filter(result => result.probe !== 'P7'));
  await refresh();
  for (const role of ['provider', 'staff']) {
    await probe(role, 'P7', () => lostResponse(role));
    const result = results.at(-1);
    if (role === 'staff' && result.status === 'PASS') {
      result.status = 'EXPECTED_UNDER_RULING';
      result.interpretation = 'Observed Condition 403; executed retry reports partial-refused with zero writes; intervening edit reports conflict with zero writes.';
    }
  }
  evidence('preflight-results.json', { ...previous, amendment: 'P7 re-executed for both roles after F2; P1-P6 evidence unchanged.',
    supersededP7: previous.results.filter(result => result.probe === 'P7'), results, stop: results.some(result => result.status === 'FAIL') });
  process.exitCode = results.some(result => result.status === 'FAIL') ? 2 : 0;
}

const action = process.argv[2];
if (action === 'up') await up();
else if (action === 'start') await start();
else if (action === 'seed') await seed();
else if (action === 'run') await run();
else if (action === 'sanitize-evidence') sanitizeEvidence();
else if (action === 'p7') await rerunP7();
else if (action === 'staff-link') await staffLinkAmendment();
else throw new Error('Usage: node --import tsx mcp/scripts/r10-preflight.mjs up|start|seed|run|staff-link|p7|sanitize-evidence');
