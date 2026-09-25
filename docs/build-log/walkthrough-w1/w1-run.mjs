import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
assert.ok(root && existsSync(join(root, 'mcp/src/index.ts')), 'Run from the ODOS worktree');
assert.ok(!existsSync(join(root, '.env')), 'Use a disposable worktree without a real .env');
const scripts = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(root, '.odos'), { recursive: true });
const runtime = mkdtempSync(join(root, '.odos', 'w1-runtime-'));
const prefix = `odos-w1-${randomBytes(6).toString('hex')}`;
const base = 'http://localhost:18103/';
const secret = () => `W1-${randomBytes(24).toString('hex')}!`;
const postgresPassword = secret();
const testPassword = secret();
const redisPassword = secret();
const passphrase = secret();
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase },
  publicKeyEncoding: { type: 'spki', format: 'pem' } });
const superEmail = `${prefix}-super@example.test`;
const superPassword = secret();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MEDPLUM_|ODOS_|GITHUB_ACTIONS$|GITHUB_ENV$)/.test(key)));
Object.assign(env, {
  MEDPLUM_BASE_URL: base, MEDPLUM_ADMIN_EMAIL: `${prefix}-admin@example.test`, MEDPLUM_ADMIN_PASSWORD: secret(),
  MEDPLUM_SUPER_EMAIL: superEmail, MEDPLUM_SUPER_PASSWORD: superPassword, MEDPLUM_CONTRACT_BOOTSTRAP: '1',
  ODOS_POSTGRES_URL: `postgresql://medplum:${testPassword}@127.0.0.1:5433/medplum`,
  W1_MEDPLUM_POSTGRES_URL: `postgresql://medplum:${postgresPassword}@127.0.0.1:15432/medplum`,
  GITHUB_ENV: join(runtime, 'project.env'), W1_RUNTIME_DIR: runtime,
});
const config = JSON.parse(readFileSync(join(root, 'medplum.dr-drill.config.json'), 'utf8'));
Object.assign(config, { defaultSuperAdminEmail: superEmail, defaultSuperAdminPassword: superPassword,
  signingKeyId: randomUUID(), signingKey: privateKey, signingKeyPassphrase: passphrase });
config.database.password = postgresPassword;
config.redis.password = redisPassword;
assert.equal(env.MEDPLUM_BASE_URL, config.baseUrl, 'byte-identical Medplum baseUrl');
writeFileSync(join(runtime, 'medplum.json'), JSON.stringify(config), { mode: 0o644 });
const postgres = (password, port, volume) => ({ image: 'postgres:16-alpine', environment: {
  POSTGRES_DB: 'medplum', POSTGRES_USER: 'medplum', POSTGRES_PASSWORD: password },
  ports: [`127.0.0.1:${port}:5432`], volumes: [`${volume}:/var/lib/postgresql/data`],
  healthcheck: { test: ['CMD-SHELL', 'pg_isready -U medplum -d medplum'], interval: '2s', timeout: '3s', retries: 30 } });
const compose = { services: {
  postgres: postgres(postgresPassword, 15432, 'postgres'),
  'test-postgres': postgres(testPassword, 5433, 'test-postgres'),
  redis: { image: 'redis:7-alpine', command: ['redis-server', '--requirepass', redisPassword],
    healthcheck: { test: ['CMD', 'redis-cli', '--pass', redisPassword, 'ping'], interval: '2s', timeout: '3s', retries: 30 } },
  'binary-init': { image: 'alpine:3.21', user: '0:0', command: ['chown', '-R', '1000:1000', '/data/binary'], volumes: ['binary:/data/binary'] },
  'medplum-server': { image: 'medplum/medplum-server:5.1.8', depends_on: {
    postgres: { condition: 'service_healthy' }, redis: { condition: 'service_healthy' }, 'binary-init': { condition: 'service_completed_successfully' } },
    volumes: [`${join(runtime, 'medplum.json')}:/config/medplum.config.json:ro`, 'binary:/data/binary'],
    ports: ['127.0.0.1:18103:8103'], command: ['file:/config/medplum.config.json'] },
}, volumes: { postgres: {}, 'test-postgres': {}, binary: {} } };
for (const [name, service] of Object.entries(compose.services)) service.container_name = `${prefix}-${name}`;
const composePath = join(runtime, 'compose.json');
writeFileSync(composePath, JSON.stringify(compose), { mode: 0o600 });
const dockerArgs = ['-p', prefix, '-f', composePath];
const unitEnv = () => Object.fromEntries(Object.entries(env).filter(([key]) => !/^(MEDPLUM_|ODOS_OPERATOR_|GITHUB_ENV$)/.test(key)));
const results = [];
let mcp;
let mcpLog;
const mutations = new Map();
const operatorNames = ['operator.env', 'operator-identity.json'];
mkdirSync(join(root, '.odos'), { recursive: true });
for (const name of operatorNames) {
  const path = join(root, '.odos', name);
  if (existsSync(path)) renameSync(path, join(runtime, `original-${name}`));
}

async function command(label, cmd, args, options = {}) {
  const log = join(runtime, `${label}.log`);
  const fd = openSync(log, 'w', 0o600);
  const code = await new Promise((done, reject) => {
    const child = spawn(cmd, args, { cwd: root, env: options.env ?? env, stdio: ['ignore', fd, fd] });
    child.once('error', reject); child.once('exit', value => done(value ?? 1));
  }).finally(() => closeSync(fd));
  const output = readFileSync(log, 'utf8');
  const summary = output.split(/\r?\n/).filter(line => /^(# (tests|suites|pass|fail|cancelled|skipped|todo)|not ok |provider[: ]|composite[: ]|Browser G5:)/.test(line));
  results.push({ label, code, summary });
  console.log(`${label}: exit=${code}${summary.length ? '\n' + summary.join('\n') : ''}`);
  if (options.red) {
    assert.notEqual(code, 0, `${label}: mutant must fail`);
    const expected = {
      'g2-red': 'WENO search storages in the registered server use ODOS_POSTGRES_URL',
      'g3-red': "blank self-party mailing address uses the patient's home address",
      'g4-red': 'self-pay registration without a home mailing address refuses before writes',
      'g5-red': 'registration failure is shown directly above Create patient',
      'g6-red': 'Accept write failure says acceptance failed and logs one safe step',
    }[label];
    if (expected) assert.deepEqual(summary.filter(line => line.startsWith('not ok ')).map(line => line.replace(/^not ok \d+ - /, '')), [expected], 'only the intended new guard may fail');
  }
  else assert.equal(code, 0, `${label}: see private run log`);
  return output;
}
async function freePort(port) {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  await new Promise(done => server.close(done));
}
async function stopMcp() {
  if (!mcp) return;
  const child = mcp;
  mcp = undefined;
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(done => child.once('exit', done));
    child.kill('SIGTERM');
    await Promise.race([stopped, delay(10000).then(() => child.kill('SIGKILL'))]);
  }
}
async function startMcp(label, inject = false) {
  await stopMcp();
  mcpLog = join(runtime, `${label}-server.log`);
  const fd = openSync(mcpLog, 'w', 0o600);
  const args = ['--import', 'tsx', ...(inject ? ['--import', join(scripts, 'w1-order-failure.mjs')] : []), 'mcp/src/index.ts'];
  mcp = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  for (let attempt = 1; attempt <= 90; attempt++) {
    assert.equal(mcp.exitCode, null, 'MCP must stay running');
    try {
      const response = await fetch('http://127.0.0.1:3334/', { signal: AbortSignal.timeout(1000) });
      if (response.status === 404) { console.log(`${label}: MCP ready attempt=${attempt}`); return; }
    } catch {}
    await delay(1000);
  }
  throw new Error('MCP startup timeout');
}
function mutate(path, before, after) {
  const file = join(root, path);
  const source = readFileSync(file, 'utf8');
  assert.ok(source.includes(before), `mutation target: ${path}`);
  assert.ok(!mutations.has(file));
  mutations.set(file, source);
  writeFileSync(file, source.replaceAll(before, after));
  assert.ok(!readFileSync(file, 'utf8').includes(before), 'mutant landed');
}
function restore() {
  for (const [file, source] of mutations) { writeFileSync(file, source); assert.equal(readFileSync(file, 'utf8'), source); }
  mutations.clear();
}
async function live(label, red = false) {
  const output = await command(label, process.execPath, ['--import', 'tsx', join(scripts, 'w1-live.ts')], { red });
  if (!red) await command(`${label}-persisted`, process.execPath, ['--import', 'tsx', join(scripts, 'w1-verify.ts')]);
  return output;
}
async function weno(label, expectedPharmacyStatus = 200, expectedDrugStatus = 200) {
  const token = readFileSync(join(runtime, 'w1-provider-token'), 'utf8');
  for (const [name, query, expected] of [['pharmacies', 'searchType=local-retail&state=SC&zip=29646&all=true', expectedPharmacyStatus], ['drugs', 'q=latanoprost', expectedDrugStatus]]) {
    const response = await fetch(`http://127.0.0.1:3334/weno/${name}/search?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    console.log(`${label}: ${name} search=${response.status}`);
    results.push({ label: `${label}-${name}`, status: response.status });
    assert.equal(response.status, expected);
  }
}
const mcpTests = (label, files, red = false) => command(label, 'npm', ['--prefix', 'mcp', 'test', '--', ...files], { env: unitEnv(), red });
try {
  for (const directory of ['', 'mcp', 'ui']) if (!existsSync(join(root, directory, 'node_modules/tsx'))) {
    await command(`dependencies-${directory || 'root'}`, 'npm', [...(directory ? ['--prefix', directory] : []), 'ci']);
  }
  for (const port of [18103, 15432, 5433, 3334]) await freePort(port);
  await command('stack-up', 'docker-compose', [...dockerArgs, 'up', '-d']);
  let healthy = false;
  for (let attempt = 1; attempt <= 90; attempt++) {
    try { healthy = (await fetch(`${base}healthcheck`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
    if (healthy) { console.log(`healthcheck: PASS attempt=${attempt}/90 interval=2s baseUrl-byte-identical=true`); results.push({ label: 'healthcheck', attempt }); break; }
    await delay(2000);
  }
  assert.ok(healthy, 'fresh Medplum healthcheck gate');
  await command('live-integration', 'npm', ['--prefix', 'mcp', 'run', 'test:live-integration']);
  env.MEDPLUM_PROJECT_ID = readFileSync(env.GITHUB_ENV, 'utf8').trim().split('\n').filter(line => line.startsWith('MEDPLUM_PROJECT_ID=')).at(-1).split('=')[1];
  await command('operator-identity', 'npm', ['run', 'operator-identity', '--', '--project', env.MEDPLUM_PROJECT_ID], { env: { ...env, ODOS_POSTGRES_URL: env.W1_MEDPLUM_POSTGRES_URL } });
  for (const line of readFileSync(join(root, '.odos/operator.env'), 'utf8').trim().split('\n')) {
    const i = line.indexOf('='); env[line.slice(0, i)] = line.slice(i + 1);
  }
  await command('role-repair', 'npm', ['run', 'repair-practice-roles', '--', '--project', env.MEDPLUM_PROJECT_ID, '--email', env.MEDPLUM_ADMIN_EMAIL], { env: { ...env, GITHUB_ACTIONS: 'true', ODOS_POSTGRES_URL: env.W1_MEDPLUM_POSTGRES_URL } });
  await command('live-authz', 'npm', ['--prefix', 'mcp', 'run', 'test:live-authz']);
  await command('runtime-service', process.execPath, ['--import', 'tsx', join(scripts, 'w1-service.ts')]);
  for (const line of readFileSync(join(runtime, 'w1-service.env'), 'utf8').trim().split('\n')) {
    const i = line.indexOf('='); env[line.slice(0, i)] = line.slice(i + 1);
  }
  writeFileSync(join(runtime, 'smart.pem'), generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
  Object.assign(env, { ODOS_MCP_TRANSPORT: 'sse', ODOS_MCP_HTTP_HOST: '127.0.0.1', ODOS_MCP_HTTP_PORT: '3334',
    ODOS_AUDIT_DISABLED: '1', ODOS_SMART_SIGNING_KEY_PATH: join(runtime, 'smart.pem') });
  await startMcp('g7-baseline');
  await live('g7-baseline');
  await startMcp('g7-red', true);
  const redOutput = await live('g7-red', true);
  assert.match(redOutput, /provider accept=502 code=accept-failed/);
  const lines = readFileSync(mcpLog, 'utf8').split('\n').filter(line => line.startsWith('follow-up accept failed:'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /step=order status=503 message=W1 injected order write failure$/);
  console.log(lines[0]); results.push({ label: 'g7-log', line: lines[0] });
  await startMcp('g7-restored');
  await live('g7-restored');
  await weno('g1-baseline');
  for (const [name, constructor] of [['pharmacy', 'PostgresWenoPharmacyDirectoryStorage'], ['drug', 'PostgresWenoDrugDatabaseStorage']]) {
    mutate('mcp/src/index.ts', `new ${constructor}({ postgresUrl: process.env.ODOS_POSTGRES_URL })`, `new ${constructor}()`);
    try { await startMcp(`g1-${name}-red`); await weno(`g1-${name}-red`, name === 'pharmacy' ? 500 : 200, name === 'drug' ? 500 : 200); }
    finally { restore(); }
    await startMcp(`g1-${name}-restored`); await weno(`g1-${name}-restored`);
  }
  await stopMcp();
  for (const name of operatorNames) {
    const file = join(root, '.odos', name);
    if (existsSync(file)) renameSync(file, join(runtime, `generated-${name}`));
  }
  console.log('Unit suites: .odos/operator.env and operator-identity.json moved aside');
  const registrationPath = 'mcp/src/clinic/patient-registration-endpoint.ts';
  const derivation = readFileSync(join(root, registrationPath), 'utf8').match(/  const selfResolvedInput = \{[\s\S]*?\n  \};/)[0];
  mutate(registrationPath, derivation, derivation.replace('address: input.demographics.address, city: input.demographics.city,', "address: input.demographics.address || '1 Synthetic Way', city: input.demographics.city || 'Greenville',")
    .replace('state: input.demographics.state, postalCode: input.demographics.postalCode', "state: input.demographics.state || 'SC', postalCode: input.demographics.postalCode || '29601'"));
  try { await mcpTests('g4-red', ['tests/walkthroughSelfRegistration.test.ts'], true); } finally { restore(); }
  await mcpTests('g4-restored', ['tests/walkthroughSelfRegistration.test.ts', 'tests/patientRegistrationAuthz.test.ts', 'tests/guarantorRegistrationAttach.test.ts']);
  mutate('mcp/src/clinical-graph/protocol-endpoint.ts', 'return acceptFailure(step, error);', 'return loadFailure;');
  try { await mcpTests('g6-red', ['tests/walkthroughFollowUpAcceptFailure.test.ts'], true); } finally { restore(); }
  await mcpTests('g6-restored', ['tests/walkthroughFollowUpAcceptFailure.test.ts']);
  console.log('A3 G7, both G1 constructors, G4 and registered-route G6 complete');
  await startMcp('browser');
  await command('browser', process.execPath, ['--import', 'tsx', join(scripts, 'w1-browser.ts')]);
  await stopMcp();
  mutate('mcp/src/index.ts', 'new PostgresWenoDrugDatabaseStorage({ postgresUrl: process.env.ODOS_POSTGRES_URL })', 'new PostgresWenoDrugDatabaseStorage()');
  try { await mcpTests('g2-red', ['tests/wenoIndexPostgresWiring.test.ts'], true); } finally { restore(); }
  await mcpTests('g2-restored', ['tests/wenoIndexPostgresWiring.test.ts', 'tests/diagnosisWriteGate.test.ts', 'tests/r10A3McpGuards.test.ts']);
  mutate(registrationPath, derivation, '  const selfResolvedInput = input;');
  try { await mcpTests('g3-red', ['tests/walkthroughSelfRegistration.test.ts'], true); } finally { restore(); }
  await mcpTests('g3-restored', ['tests/walkthroughSelfRegistration.test.ts']);
  const patientPath = 'ui/src/scenes/NewPatient.tsx';
  const bottomAlert = readFileSync(join(root, patientPath), 'utf8').match(/^          \{saveError && <div role="alert".*\n/m)[0];
  mutate(patientPath, bottomAlert, '');
  try { await command('g5-red', 'npm', ['--prefix', 'ui', 'test'], { env: unitEnv(), red: true }); } finally { restore(); }
  await command('g5-restored', 'npm', ['--prefix', 'ui', 'test'], { env: unitEnv() });
  await mcpTests('related-mcp', ['tests/followUpAccept.test.ts', 'tests/guarantorRegistrationAttach.test.ts', 'tests/wenoSearchRoutes.test.ts', 'tests/diagnosisWriteGate.test.ts', 'tests/r10A3McpGuards.test.ts']);
  await mcpTests('accept-and-queue', ['tests/walkthroughFollowUpAcceptFailure.test.ts', 'tests/followUpAccept.test.ts', 'tests/followUpQueueEndpoint.test.ts']);
  await command('mcp-build', 'npm', ['--prefix', 'mcp', 'run', 'build'], { env: unitEnv() });
  await command('ui-build', 'npm', ['--prefix', 'ui', 'run', 'build'], { env: unitEnv() });
} finally {
  restore();
  await stopMcp();
  const down = spawnSync('docker-compose', [...dockerArgs, 'down', '-v'], { encoding: 'utf8' });
  console.log(`stack-down: exit=${down.status}`);
  for (const name of operatorNames) {
    rmSync(join(root, '.odos', name), { force: true });
    if (existsSync(join(runtime, `original-${name}`))) renameSync(join(runtime, `original-${name}`), join(root, '.odos', name));
  }
  writeFileSync(join(root, '.odos', 'w1-summary.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(root, '.odos', 'w1-private-run-path'), runtime, { mode: 0o600 });
  for (const name of ['medplum.json', 'compose.json', 'smart.pem', 'w1-service.env', 'w1-provider-token', 'w1-composite-token', ...operatorNames.map(name => `generated-${name}`)]) rmSync(join(runtime, name), { force: true });
  console.log(spawnSync('docker', ['ps', '--format', 'table {{.Names}}\t{{.Status}}'], { encoding: 'utf8' }).stdout.trimEnd());
  assert.equal(down.status, 0, 'W1 cleanup');
}
