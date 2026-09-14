import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COMPOSE_PROJECT = 'g2b1-build-live';
export const PRIVATE_SUBNET = '10.249.60.0/24';
export const MEDPLUM_IMAGE = 'medplum/medplum-server@sha256:358ab425b29390067b6cb82bfbaeee48580a703f7cc5b730bed2b2ba7184c1de';
export const PORTS = { medplum: 28760, postgres: 28761, redis: 28762, odos: 28763, ui: 28764 };
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const sourceRoot = resolve(process.env.G2B1_SOURCE_ROOT ?? fixtureRoot);
export const privateDirectory = resolve(process.env.G2B1_LIVE_DIR ?? `${fixtureRoot}/.odos/g2b1-build-live`);
export const evidenceDirectory = resolve(process.env.G2B1_EVIDENCE_DIR ?? `${fixtureRoot}/docs/build-log/guarantor-g2b1`);
const baseUrl = `http://127.0.0.1:${PORTS.medplum}`;
const trace = [];

export function redact(value, key = '') {
  if (/password|secret|authorization|token|signingkey|verifier|postgresurl/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

function privateJson(name, value) {
  mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
  const path = resolve(privateDirectory, name);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function writeEvidence(name, value) {
  mkdirSync(evidenceDirectory, { recursive: true });
  let serialized = JSON.stringify(redact(value), null, 2) + '\n';
  if (existsSync(resolve(privateDirectory, 'fixture-private.json'))) {
    const removeSecrets = (object) => {
      for (const [key, item] of Object.entries(object)) {
        if (item && typeof item === 'object') removeSecrets(item);
        else if (typeof item === 'string' && /password|secret|token|signing|postgresurl/i.test(key)) {
          serialized = serialized.replaceAll(item, '[REDACTED]').replaceAll(encodeURIComponent(item), '[REDACTED]');
        }
      }
    };
    removeSecrets(loadPrivateFixture());
  }
  serialized = serialized.replaceAll(sourceRoot, '<source-root>').replaceAll(fixtureRoot, '<fixture-root>');
  writeFileSync(resolve(evidenceDirectory, name), serialized);
}

export function loadPrivateFixture() {
  const value = JSON.parse(readFileSync(resolve(privateDirectory, 'fixture-private.json'), 'utf8'));
  assert.equal(value.baseUrl, baseUrl);
  assert.equal(value.composeProject, COMPOSE_PROJECT);
  return value;
}

export function resourceEvidence(resource) {
  if (resource?.resourceType !== 'AccessPolicy') return redact(resource);
  return {
    resourceType: resource.resourceType, id: resource.id, meta: resource.meta, name: resource.name,
    evidenceProjection: 'Person and Task rules only; digest covers the full resource',
    fullResourceSha256: createHash('sha256').update(JSON.stringify(resource)).digest('hex'),
    resource: resource.resource?.filter((rule) => ['Person', 'Task'].includes(rule.resourceType)),
  };
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', cwd: sourceRoot, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${program} failed (${result.status ?? result.error?.code ?? 'unknown'}). See the private runtime log.`);
  return result.stdout;
}

function repositoryHead() {
  return command('git', ['rev-parse', 'HEAD']).trim();
}

async function assertPortFree(port) {
  await new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => server.close(done));
  });
}

export async function http(fixture, method, path, { body, token = fixture.serviceToken, headers = {}, principal = 'service', scenario = 'fixture' } = {}) {
  assert.equal(new URL(path, fixture.baseUrl).origin, baseUrl);
  const response = await fetch(new URL(path, fixture.baseUrl), {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Medplum': 'extended', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  const resource = raw ? JSON.parse(raw) : undefined;
  trace.push({
    sequence: trace.length + 1, scenario, principal, method, path, status: response.status,
    ...(headers['If-Match'] ? { ifMatch: headers['If-Match'] } : {}),
    ...(path.startsWith('/fhir/') ? { request: resourceEvidence(body), response: resourceEvidence(resource) } : {}),
  });
  return { status: response.status, body: resource };
}

export async function successfulHttp(fixture, method, path, options) {
  const result = await http(fixture, method, path, options);
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${path}: HTTP ${result.status}`);
  return result.body;
}

export async function refreshFixtureTokens(fixture = loadPrivateFixture()) {
  const { loginForLocalRepair } = await import(pathToFileURL(resolve(sourceRoot, 'scripts/repair-practice-roles.ts')).href);
  const usable = (token) => {
    if (!token) return false;
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.exp * 1000 > Date.now() + 60_000;
  };
  if (!usable(fixture.serviceToken)) fixture.serviceToken = await loginForLocalRepair({ baseUrl, email: fixture.serviceEmail, password: fixture.servicePassword });
  for (const principal of Object.values(fixture.principals ?? {})) {
    if (!usable(principal.token)) principal.token = await loginForLocalRepair({ baseUrl, email: principal.email, password: principal.password });
  }
  privateJson('fixture-private.json', fixture);
  return fixture;
}

export async function grantPatients(fixture, principalName, patientIds) {
  const principal = fixture.principals[principalName];
  const membership = await successfulHttp(fixture, 'GET', `/fhir/R4/ProjectMembership/${principal.membershipId}`);
  const access = patientIds.map((id) => {
    const parameter = principal.roles.map((role) => ({
      name: principal.roles.length === 1 ? 'patient_compartment' : `${role}_patient_compartment`,
      valueString: `Patient/${id}`,
    }));
    if (principal.roles.includes('provider')) parameter.push({
      name: principal.roles.length === 1 ? 'provider_profile' : 'provider_provider_profile',
      valueReference: { reference: principal.profileReference },
    });
    return { policy: { reference: `AccessPolicy/${principal.policyId}` }, parameter };
  });
  const { accessPolicy, ...envelope } = membership;
  await successfulHttp(fixture, 'PUT', `/fhir/R4/ProjectMembership/${membership.id}`, {
    body: { ...envelope, admin: false, access },
    headers: { 'If-Match': `W/"${membership.meta.versionId}"` },
  });
}

export async function createLiveClients(fixture = loadPrivateFixture()) {
  const { createMedplumClient } = await import(pathToFileURL(resolve(sourceRoot, 'mcp/src/fhir-client.ts')).href);
  const { createLiveOdosAuditRuntime } = await import(pathToFileURL(resolve(sourceRoot, 'mcp/src/authz/liveAudit.ts')).href);
  const audit = createLiveOdosAuditRuntime({
    postgresUrl: fixture.postgresUrl,
    medplumBaseUrl: baseUrl,
    medplumAccessToken: fixture.serviceToken,
    medplumProjectId: fixture.projectA,
  });
  const serviceFhir = createMedplumClient({ baseUrl, accessToken: fixture.serviceToken, extendedMode: true, audit, auditContext: { actorId: fixture.serviceReference, actorRole: 'system' } });
  return { audit, serviceFhir };
}

async function up() {
  if (existsSync(resolve(privateDirectory, 'fixture-private.json'))) throw new Error('Fixture already exists. Use status or refresh; this command never replaces it.');
  for (const port of Object.values(PORTS)) await assertPortFree(port);
  const password = () => randomBytes(30).toString('base64url') + '!Aa1';
  const fixture = {
    composeProject: COMPOSE_PROJECT, baseUrl, createdAt: new Date().toISOString(), baseHead: repositoryHead(),
    serviceEmail: 'g2b1-service@example.invalid', servicePassword: password(),
    databasePassword: password(), redisPassword: password(), signingPassphrase: password(),
    principals: {},
  };
  fixture.postgresUrl = `postgresql://medplum:${encodeURIComponent(fixture.databasePassword)}@127.0.0.1:${PORTS.postgres}/medplum`;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: fixture.signingPassphrase },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  privateJson('fixture-private.json', fixture);
  privateJson('medplum.json', {
    port: 8103, baseUrl: `${baseUrl}/`, appBaseUrl: `${baseUrl}/`, storageBaseUrl: `${baseUrl}/storage/`, binaryStorage: 'file:/tmp/g2b1-binary/',
    signingKeyId: randomUUID(), signingKey: privateKey, signingKeyPassphrase: fixture.signingPassphrase,
    database: { host: 'postgres', port: 5432, dbname: 'medplum', username: 'medplum', password: fixture.databasePassword },
    redis: { host: 'redis', port: 6379, password: fixture.redisPassword },
    registerEnabled: true, defaultSuperAdminEmail: fixture.serviceEmail, defaultSuperAdminPassword: fixture.servicePassword,
    supportEmail: 'g2b1-support@example.invalid', maxJsonSize: '10mb', allowedOrigins: `${baseUrl},http://127.0.0.1:${PORTS.odos},http://127.0.0.1:${PORTS.ui}`,
  });
  privateJson('compose.json', {
    name: COMPOSE_PROJECT,
    services: {
      postgres: {
        image: 'postgres:16-alpine', environment: { POSTGRES_DB: 'medplum', POSTGRES_USER: 'medplum', POSTGRES_PASSWORD: fixture.databasePassword },
        ports: [`127.0.0.1:${PORTS.postgres}:5432`], volumes: ['postgres-data:/var/lib/postgresql/data'],
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U medplum -d medplum'], interval: '1s', timeout: '3s', retries: 30 },
      },
      redis: {
        image: 'redis:7-alpine', command: ['redis-server', '--requirepass', fixture.redisPassword], ports: [`127.0.0.1:${PORTS.redis}:6379`],
        healthcheck: { test: ['CMD', 'redis-cli', '--no-auth-warning', '-a', fixture.redisPassword, 'ping'], interval: '1s', timeout: '3s', retries: 30 },
      },
      medplum: {
        image: MEDPLUM_IMAGE, depends_on: { postgres: { condition: 'service_healthy' }, redis: { condition: 'service_healthy' } },
        environment: { NODE_OPTIONS: '--max-old-space-size=384' }, mem_limit: '768m',
        command: ['file:/config/medplum.json'], ports: [`127.0.0.1:${PORTS.medplum}:8103`],
        volumes: [`${resolve(privateDirectory, 'medplum.json')}:/config/medplum.json:ro`],
      },
    },
    volumes: { 'postgres-data': {} },
    networks: { default: { ipam: { config: [{ subnet: PRIVATE_SUBNET }] } } },
  });
  await start();
}

async function start() {
  const fixture = loadPrivateFixture();
  const standalone = spawnSync('docker-compose', ['version'], { encoding: 'utf8' }).status === 0;
  const result = spawnSync(standalone ? 'docker-compose' : 'docker', [...(standalone ? [] : ['compose']), '-p', COMPOSE_PROJECT, '-f', resolve(privateDirectory, 'compose.json'), 'up', '-d'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(resolve(privateDirectory, 'startup.log'), `${result.stdout}\n${result.stderr}`, { mode: 0o600 });
  assert.equal(result.status, 0, 'Disposable compose startup failed; inspect private startup.log.');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthcheck`);
      if (response.ok) {
        const health = await response.json();
        assert.equal(health.version, '5.1.30-9b1bd92');
        writeEvidence('live-runtime.json', { composeProject: COMPOSE_PROJECT, ports: PORTS, image: MEDPLUM_IMAGE, health, baseHead: fixture.baseHead });
        console.log(JSON.stringify({ composeProject: COMPOSE_PROJECT, baseUrl, health }));
        return;
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error('Medplum did not become healthy within 60 seconds. The isolated containers remain for inspection.');
}

async function seed() {
  const fixture = await refreshFixtureTokens();
  assert.equal(fixture.projectA, undefined, 'Fixture is already seeded; never create duplicate subjects.');
  const { buildMedplumAccessPolicy, buildMedplumCompositeAccessPolicy, getRoleDeclaration } = await import(pathToFileURL(resolve(sourceRoot, 'mcp/src/authz/roles.ts')).href);
  const service = await successfulHttp(fixture, 'GET', '/auth/me');
  fixture.serviceReference = `${service.profile.resourceType}/${service.profile.id}`;
  fixture.serviceProject = service.project.id;
  for (const key of ['A', 'B']) {
    const project = await successfulHttp(fixture, 'POST', '/fhir/R4/Project', { body: { resourceType: 'Project', name: `G2b1 build synthetic ${key}`, features: [], link: [] } });
    fixture[`project${key}`] = project.id;
  }
  privateJson('fixture-private.json', fixture);
  const patient = await successfulHttp(fixture, 'POST', '/fhir/R4/Patient', { body: { resourceType: 'Patient', meta: { project: fixture.projectA }, name: [{ family: 'Synthetic', given: ['G2b1', 'Bootstrap'] }] } });
  fixture.patientId = patient.id;
  fixture.policies = {};
  for (const name of ['staff', 'provider', 'admin', 'composite']) {
    const compiled = name === 'composite' ? buildMedplumCompositeAccessPolicy(['staff', 'provider', 'admin']) : buildMedplumAccessPolicy(getRoleDeclaration(name));
    const policy = await successfulHttp(fixture, 'POST', '/fhir/R4/AccessPolicy', { body: { ...compiled, meta: { ...compiled.meta, project: fixture.projectA } } });
    fixture.policies[name] = policy.id;
  }
  for (const name of ['staff', 'composite']) {
    const email = `g2b1-${name}@example.invalid`;
    const password = randomBytes(30).toString('base64url') + '!Aa1';
    const invited = await successfulHttp(fixture, 'POST', `/admin/projects/${fixture.projectA}/invite`, { body: { resourceType: 'Practitioner', email, firstName: 'Synthetic', lastName: `G2b1 ${name}`, sendEmail: false } });
    assert.equal(invited.resourceType, 'ProjectMembership');
    const membership = await successfulHttp(fixture, 'GET', `/fhir/R4/ProjectMembership/${invited.id}`);
    await successfulHttp(fixture, 'POST', '/admin/super/setpassword', { body: { email, password } });
    fixture.principals[name] = { email, password, roles: name === 'staff' ? ['staff'] : ['staff', 'provider', 'admin'], profileReference: membership.profile.reference, membershipId: membership.id, policyId: fixture.policies[name] };
    await grantPatients(fixture, name, [patient.id]);
    privateJson('fixture-private.json', fixture);
  }
  await refreshFixtureTokens(fixture);
  writeEvidence('live-bootstrap-http.json', { sourceHead: repositoryHead(), events: trace });
  await status(fixture);
}

async function sync() {
  const fixture = await refreshFixtureTokens();
  const logPath = resolve(privateDirectory, 'policy-sync.log');
  const result = spawnSync(process.execPath, ['--import', resolve(fixtureRoot, 'node_modules/tsx/dist/loader.mjs'), 'scripts/sync-practice-role-policy-rules.ts', '--project', fixture.projectA, '--bootstrap-service-identity', '--apply'], {
    cwd: sourceRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, MEDPLUM_ACCESS_TOKEN: '', MEDPLUM_BASE_URL: baseUrl, MEDPLUM_ADMIN_EMAIL: fixture.serviceEmail, MEDPLUM_ADMIN_PASSWORD: fixture.servicePassword },
  });
  writeFileSync(logPath, `${result.stdout}\n${result.stderr}`, { mode: 0o600 });
  assert.equal(result.status, 0, 'Repository policy sync failed; inspect private policy-sync.log.');
  writeEvidence('live-policy-sync.json', { sourceHead: repositoryHead(), command: 'node --import tsx scripts/sync-practice-role-policy-rules.ts --project <synthetic-project-A> --bootstrap-service-identity --apply', output: result.stdout, diagnostics: result.stderr });
  for (const principal of Object.values(fixture.principals)) delete principal.token;
  await refreshFixtureTokens(fixture);
  await status(fixture);
}

async function status(fixture = loadPrivateFixture()) {
  const health = await (await fetch(`${baseUrl}/healthcheck`)).json();
  assert.equal(health.version, '5.1.30-9b1bd92');
  const projects = [];
  for (const id of [fixture.serviceProject, fixture.projectA, fixture.projectB].filter(Boolean)) {
    const project = await successfulHttp(fixture, 'GET', `/fhir/R4/Project/${id}`);
    assert.equal((project.features ?? []).includes('transaction-bundles'), false);
    projects.push({ id, name: project.name, features: project.features ?? [] });
  }
  const principals = {};
  for (const [name, principal] of Object.entries(fixture.principals)) {
    const me = await successfulHttp(fixture, 'GET', '/auth/me', { token: principal.token, principal: name });
    assert.equal(me.profile.resourceType, 'Practitioner');
    assert.equal(me.project.id, fixture.projectA);
    assert.equal(me.membership.admin, false);
    const membership = await successfulHttp(fixture, 'GET', `/fhir/R4/ProjectMembership/${principal.membershipId}`);
    const policy = await successfulHttp(fixture, 'GET', `/fhir/R4/AccessPolicy/${principal.policyId}`);
    principals[name] = { profileReference: principal.profileReference, membershipId: principal.membershipId, roles: principal.roles, access: membership.access, policyId: principal.policyId, relevantRules: policy.resource.filter((rule) => ['Person', 'Task'].includes(rule.resourceType)) };
  }
  const report = { sourceHead: repositoryHead(), composeProject: COMPOSE_PROJECT, ports: PORTS, image: MEDPLUM_IMAGE, health, projects, serviceReference: fixture.serviceReference, patientId: fixture.patientId, principals };
  writeEvidence('live-fixture-state.json', report);
  console.log(JSON.stringify({ health, projectCount: projects.length, serviceReference: fixture.serviceReference, staffPrincipals: Object.keys(principals), sourceHead: report.sourceHead }));
}

async function auditSmoke() {
  const fixture = await refreshFixtureTokens();
  const { buildOdosAuditEventRow } = await import(pathToFileURL(resolve(sourceRoot, 'mcp/src/authz/odosAudit.ts')).href);
  const { audit } = await createLiveClients(fixture);
  try {
    const row = buildOdosAuditEventRow({ eventType: 'noop', actorReference: fixture.principals.staff.profileReference, actorRole: 'staff', patientId: fixture.patientId, actionReason: 'Synthetic G2b1 fixture audit connectivity proof', outcome: 'success' });
    await audit.record(row, () => undefined);
    const rows = await audit.queryRows({ patientId: fixture.patientId, eventTypes: ['noop'] });
    assert.ok(rows.some((found) => found.id === row.id));
    writeEvidence('live-audit-bootstrap.json', { sourceHead: repositoryHead(), rows });
    console.log(JSON.stringify({ auditRowsPersisted: rows.length, eventType: 'noop' }));
  } finally {
    await audit.close();
  }
}

async function authSmoke() {
  const fixture = await refreshFixtureTokens();
  const { authenticateStaffRoute } = await import(pathToFileURL(resolve(sourceRoot, 'mcp/src/payments/payment-endpoint.ts')).href);
  const { audit, serviceFhir } = await createLiveClients(fixture);
  const results = [];
  try {
    for (const [name, principal] of Object.entries(fixture.principals)) {
      const staff = await authenticateStaffRoute({ baseUrl, authHeader: `Bearer ${principal.token}`, serviceClient: serviceFhir, audit });
      assert.equal(staff?.staffReference, principal.profileReference);
      assert.equal(staff.project.reference, `Project/${fixture.projectA}`);
      assert.deepEqual([...staff.roles].sort(), [...principal.roles].sort());
      results.push({ principal: name, staffReference: staff.staffReference, roles: staff.roles, project: staff.project, guarantorLinkAuthorized: staff.businessActions.includes('guarantor.link') });
    }
    writeEvidence('live-staff-auth.json', { sourceHead: repositoryHead(), results });
    console.log(JSON.stringify({ authenticatedStaffPrincipals: results.length, results }));
  } finally {
    await audit.close();
  }
}

async function schemaCheck() {
  const fixture = loadPrivateFixture();
  const result = spawnSync(process.execPath, ['--import', resolve(fixtureRoot, 'node_modules/tsx/dist/loader.mjs'), '--test', 'mcp/tests/liveAuditSchema.test.ts'], {
    cwd: sourceRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ODOS_POSTGRES_URL: fixture.postgresUrl },
  });
  writeEvidence('live-audit-schema-tests.json', { sourceHead: repositoryHead(), command: 'node --import tsx --test mcp/tests/liveAuditSchema.test.ts (ODOS_POSTGRES_URL is the disposable fixture)', exitCode: result.status, output: result.stdout, diagnostics: result.stderr });
  console.log(result.stdout.split('\n').filter((line) => /^# (tests|pass|fail|skipped)|^(not ok|ok) /.test(line)).join('\n'));
  assert.equal(result.status, 0, 'Existing live audit schema test failed; sanitized evidence is retained.');
}

export function saveHttpTrace(name = 'live-http.json') {
  writeEvidence(name, { sourceHead: repositoryHead(), events: trace });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const actions = { up, start, seed, sync, status, refresh: refreshFixtureTokens, 'audit-smoke': auditSmoke, 'auth-smoke': authSmoke, 'schema-check': schemaCheck };
  const action = actions[process.argv[2]];
  if (!action) throw new Error('Choose up, start, seed, sync, status, refresh, audit-smoke, auth-smoke, or schema-check.');
  await action();
}
