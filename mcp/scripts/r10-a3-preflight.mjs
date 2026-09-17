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
const privateDir = resolve(root, '.odos/r10-a3-1');
const evidenceDir = resolve(root, 'docs/evidence/r10-a3-1');
const projectName = 'odos-r10-a3-1';
const port = 29131;
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
  fixture = { projectName, baseUrl, sourceHead: command('git', ['rev-parse', 'HEAD']), email: 'r10-a3-1-seeder@example.invalid',
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
  }, volumes: { 'postgres-data': {} }, networks: { default: { ipam: { config: [{ subnet: '10.249.142.0/24' }] } } } });
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
  const project = await ok('seeder', 'POST', '/fhir/R4/Project', { resourceType: 'Project', name: 'R10 A3.1 synthetic preflight', features: [], link: [] });
  fixture.projectId = project.id;
  const patient = await ok('seeder', 'POST', '/fhir/R4/Patient', { resourceType: 'Patient', meta: { project: project.id }, name: [{ family: 'Synthetic', given: ['R10'] }] });
  fixture.patientReference = `Patient/${patient.id}`;
  const encounter = await ok('seeder', 'POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', meta: { project: project.id }, status: 'in-progress', class: { code: 'synthetic' }, subject: { reference: fixture.patientReference } });
  fixture.encounterReference = `Encounter/${encounter.id}`;
  for (const role of ['provider', 'staff']) {
    const compiled = buildMedplumAccessPolicy(getRoleDeclaration(role));
    const policy = await ok('seeder', 'POST', '/fhir/R4/AccessPolicy', { ...compiled, meta: { ...compiled.meta, project: project.id } });
    const email = `r10-a3-1-${role}@example.invalid`;
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

async function gateE() {
  const system = 'urn:odos:carry-diagnosis:v1';
  const value = createHash('sha256').update(randomUUID()).digest('hex');
  const commands = [randomUUID(), randomUUID()];
  const payload = buildEncounterDiagnosisCondition({patientReference: fixture.patientReference, encounterReference: fixture.encounterReference,
    code: {text: 'Synthetic carry capability'}, verificationStatus: 'confirmed'});
  payload.identifier = [{system, value}];
  const headers = {'If-None-Exist': `identifier=${system}|${value}`};
  const concurrent = await Promise.all(commands.map(commandId => request('provider', 'POST', '/fhir/R4/Condition',
    {...payload, meta: {tag: [{system:'urn:odos:carry-command:v1',code:commandId}]}}, headers)));
  const third = await request('provider', 'POST', '/fhir/R4/Condition', payload, headers);
  const persisted = await search('provider','Condition',{identifier:`${system}|${value}`});
  const detail = {commands, concurrent:concurrent.map(r=>({status:r.status,id:r.body?.id,created:r.status===201})),
    third:{status:third.status,id:third.body?.id,created:third.status===201},persistedCount:persisted.length};
  evidence('gate-e.json',detail);
  assert.equal(persisted.length,1);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,201]);
  assert.ok(concurrent.every(r=>r.body.id===persisted[0].id));
  assert.equal(third.status,200); assert.equal(third.body.id,persisted[0].id);
  return detail;
}
async function gateF(role) {
  const code=randomUUID();
  const payload=audit(role,code);
  const json=JSON.stringify({v:1,commandId:code,values:['synthetic',1],spacing:' retained '});
  payload.extension=[{url:'urn:odos:carry-plan',valueString:json}];
  const headers={'If-None-Exist':`_tag=${operationSystem}|${code}`};
  const concurrent=await Promise.all([request(role,'POST','/fhir/R4/Provenance',payload,headers),request(role,'POST','/fhir/R4/Provenance',payload,headers)]);
  const replay=await request(role,'POST','/fhir/R4/Provenance',payload,headers);
  const persisted=await search(role,'Provenance',{_tag:`${operationSystem}|${code}`});
  const detail={concurrent:concurrent.map(r=>({status:r.status,id:r.body?.id})),replayStatus:replay.status,persistedCount:persisted.length,json};
  evidence(`gate-f-${role}.json`,detail);
  assert.equal(persisted.length,1); assert.equal(replay.status,200);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,201]);
  for(const r of [...concurrent,replay]) {assert.equal(r.body.id,persisted[0].id);assert.equal(r.body.extension[0].valueString,json);}
  return detail;
}
async function freshEncounter() {
  const encounter = await ok('provider', 'POST', '/fhir/R4/Encounter', {
    resourceType: 'Encounter', status: 'in-progress', class: { code: 'synthetic' },
    subject: { reference: fixture.patientReference },
  });
  assert.equal(encounter.status, 'in-progress');
  assert.ok(encounter.meta?.versionId);
  assert.notEqual(`Encounter/${encounter.id}`, fixture.encounterReference);
  return encounter;
}
async function gateG() {
  const before = await freshEncounter();
  const reference = `Encounter/${before.id}`;
  const updated = await ok('provider', 'PUT', `/fhir/R4/${reference}`,
    {...before, period: {start: new Date().toISOString()}}, {'If-Match': `W/"${before.meta.versionId}"`});
  assert.equal(updated.status, 'in-progress');
  assert.notEqual(updated.meta.versionId, before.meta.versionId, 'Stale-write setup must advance the version');
  const stale = await request('provider', 'PUT', `/fhir/R4/${reference}`,
    {...before, status: 'finished'}, {'If-Match': `W/"${before.meta.versionId}"`});
  assert.equal(stale.status, 412);
  assert.deepEqual(await ok('provider', 'GET', `/fhir/R4/${reference}`), updated);
  return {reference, startingStatus: before.status, beforeVersion: before.meta.versionId,
    updatedVersion: updated.meta.versionId, staleStatus: stale.status, unchanged: true};
}
async function serviceIdentity() {
  const { createMcpServiceAuthentication } = await import('../src/service-auth-options.ts');
  const { authenticateMedplumService, createOperatorScriptFhirClient } = await import('../src/fhir-client.ts');
  const client = createOperatorScriptFhirClient({baseUrl, reason: 'Disposable R10 G-h capability probe'});
  const authentication = createMcpServiceAuthentication({
    MEDPLUM_ADMIN_EMAIL: fixture.email, MEDPLUM_ADMIN_PASSWORD: fixture.password,
  }, fixture.projectId, authenticateMedplumService);
  const mode = await authentication.authenticate(client);
  assert.equal(mode, 'password');
  const principalReference = await client.getAuthenticatedProfileReference();
  const principal = {email:fixture.email, profileReference:principalReference, policyId:null,
    mode, reason:'No service ClientApplication was provisioned in this disposable bootstrap; admin password fallback.'};
  fixture.principals.service = principal;
  return {client, principal};
}
async function gateH() {
  const {buildAmendmentTransaction}=await import('../src/fhir/scribeAttestation.ts');
  const {client, principal} = await serviceIdentity();
  const encounter = await freshEncounter();
  const encounterReference = `Encounter/${encounter.id}`;
  const key={v:1,patientId:fixture.patientReference.slice(8),encounterId:encounter.id,stableKey:lens.stableKey,fieldCode:lensField,optionCode:nuclear.optionCode,eye:'OD'};
  const identifier = currentFindingIdentifier(key);
  const marker={commandId:randomUUID(),target:`finding:${identifier.value}`,digest:createHash('sha256').update('synthetic').digest('hex'),audit:{kind:'mutation',actor:fixture.principals.provider.profileReference,recorded:new Date().toISOString(),activity:'CREATE',targetReferences:['self',fixture.patientReference]}};
  const initial=await ok('seeder','POST','/fhir/R4/Observation',{resourceType:'Observation',meta:{project:fixture.projectId},status:'preliminary',identifier:[identifier],code:odosConcept(nuclear.atomicFindingId),subject:{reference:fixture.patientReference},encounter:{reference:encounterReference},valueBoolean:true,
    component:[comp('R10_CURRENT_META',JSON.stringify(key)),comp('R10_OPERATION',JSON.stringify(marker)),comp('synthetic-detail','unchanged')],extension:[{url:ODOS_EXTENSION_URLS.eyeLaterality,valueCodeableConcept:lateralityConcept('OD')}]});
  assert.equal(initial.status, 'preliminary');
  const observation=await ok('seeder','PUT',`/fhir/R4/Observation/${initial.id}`,{...initial,status:'final'}, {'If-Match':`W/"${initial.meta.versionId}"`});
  assert.equal(observation.status,'final');
  assert.notEqual(observation.meta.versionId, initial.meta.versionId);
  assert.equal(parseCurrentFindingEnvelope(observation).status,'valid');
  const transaction=buildAmendmentTransaction({observation,clinicianId:fixture.principals.provider.profileReference,targetStatus:'amended',amendmentText:'Synthetic gate amendment',signatureDataBase64:Buffer.from('synthetic-signature').toString('base64')});
  const originalFetch = globalThis.fetch;
  let outerStatus;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const path = new URL(String(input)).pathname;
    if(path.startsWith('/fhir/')) {
      const body = await response.clone().json();
      events.push({sequence:events.length+1,scenario,role:'service',login:principal.email,
        principalReference:principal.profileReference,method:init?.method??'GET',path,status:response.status,
        request:init?.body?JSON.parse(String(init.body)):undefined,response:body});
      if(path.replace(/\/$/,'')==='/fhir/R4' && init?.method==='POST')outerStatus=response.status;
    }
    return response;
  };
  try {
    const response=await client.executeTransaction(transaction.bundle, {'X-ODOS-Source':'mcp/amend_observation'});
    assert.equal(outerStatus,200);
    assert.equal(response.entry.length,2);
    assert.ok(response.entry.every(e=>/^2\d\d/.test(e.response.status)));
    const after=await client.read('Observation',observation.id);
    assert.equal(after.status,'amended');
    assert.notEqual(after.meta.versionId, observation.meta.versionId);
    for(const field of ['identifier','component','extension'])assert.equal(JSON.stringify(after[field]),JSON.stringify(observation[field]),field);
    const provenance=await client.read('Provenance',transaction.provenance.id);
    assert.ok(provenance.target.some(t=>t.reference===`Observation/${observation.id}`));
    return {principal,encounterReference,startingEncounterStatus:encounter.status,
      reference:`Observation/${observation.id}`,setupVersions:[initial.meta.versionId,observation.meta.versionId],
      before:observation.status,after:after.status,afterVersion:after.meta.versionId,outerStatus,
      entryStatuses:response.entry.map(e=>e.response.status),provenanceReference:`Provenance/${provenance.id}`,
      provenanceTargets:provenance.target,patchOperations:transaction.patchOperations,identityComponentsExtensionsByteIdentical:true};
  } finally {globalThis.fetch=originalFetch;}
}

try {
  const action=process.argv[2];
  if(action==='up')await up();
  else if(action==='start')await start();
  else if(action==='seed')await seed();
  else if(action==='service-gate') {
    load();await refresh();
    const prior=JSON.parse(readFileSync(resolve(evidenceDir,'rev22-gate-results.json'),'utf8'));
    results.push(...prior.results.filter(row=>row.status==='PASS'));
    fixture.principals.service={email:fixture.email,policyId:null};
    await probe('service','G-h',gateH);
  }
  else if(action==='resume-gate') {
    load();await refresh();
    const prior = JSON.parse(readFileSync(resolve(evidenceDir, 'pre-rev22-gate-results.json'), 'utf8'));
    results.push(...prior.results.filter(row => ['G-e','G-f'].includes(row.probe)));
    await probe('provider','G-g',gateG);
    await probe('provider','G-h',gateH);
  }
  else if(action==='gate') {
    load();await refresh();
    await probe('provider','G-e',gateE);
    for(const role of ['provider','staff'])await probe(role,'G-f',()=>gateF(role));
    await probe('provider','G-g',gateG);
    await probe('provider','G-h',gateH);
  } else throw Error('Usage: up|start|seed|gate|resume-gate|service-gate');
} catch(error) {console.error(sanitizePublishedText(error.message));process.exitCode=1;}
