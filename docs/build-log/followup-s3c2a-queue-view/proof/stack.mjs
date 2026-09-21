import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, readdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCaddyfile, assertCaddyParity } from '../../../../scripts/r10-served-route/caddy.mjs';
import { startResponseProxy } from '../../../../scripts/r10-served-route/response-proxy.mjs';
import { runReadinessChild } from '../../../../scripts/r10-served-route/readiness-child.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const project = 'odos-s3c2a-proof';
const baseServer = process.argv.includes('--base-server');
const runtime = join(root, baseServer ? '.odos/s3c2a-before-proof' : '.odos/s3c2a-proof');
const ports = { frontdoor: baseServer ? 35892 : 35891, medplum: 35904, postgres: 29866, redis: 30802, mcp: baseServer ? 29054 : 29044, proxy: baseServer ? 29055 : 29045, control: baseServer ? 29056 : 29046 };
const subnet = '10.249.198.0/24';
const composePath = join(runtime, 'compose.json');
const manifestPath = join(runtime, 'manifest.json');
const command = process.argv[2];
const appFlag = process.argv.indexOf('--app-root');
const appRoot = appFlag < 0 ? root : resolve(process.argv[appFlag + 1]);
const cleanEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, { cwd: root, env: cleanEnv, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${program} ${args.slice(0, 3).join(' ')} failed (${result.status}); ${result.stderr?.slice(-1000) ?? ''}`);
  return result.stdout;
};
const composeBinary = spawnSync('docker', ['compose', 'version'], { env: cleanEnv, stdio: 'ignore' }).status === 0 ? ['docker', 'compose'] : ['docker-compose'];
const compose = (...args) => run(composeBinary[0], [...composeBinary.slice(1), '-p', project, '-f', composePath, ...args]);
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
function cleanHead() {
  if (run('git', ['status', '--porcelain'], { cwd: appRoot }).trim()) throw new Error('Proof build/serve requires a clean worktree.');
  return run('git', ['rev-parse', 'HEAD'], { cwd: appRoot }).trim();
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitHealth(url, seconds = 120, accepted = [200]) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try { if (accepted.includes((await fetch(url)).status)) return; } catch {}
    await delay(1000);
  }
  throw new Error(`Health timeout at ${url}`);
}
async function freePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}
function stopContainers() {
  if (!existsSync(composePath)) return;
  const ids = compose('ps', '-aq').trim().split(/\s+/).filter(Boolean);
  if (ids.length) run('docker', ['stop', ...ids]);
  console.log(`Stopped containers belonging to ${project}; retained containers and volumes.`);
}

if (command === 'prepare') {
  if (existsSync(manifestPath)) throw new Error('Harness is already prepared. Reuse its isolated runtime; do not overwrite identity.');
  await Promise.all(Object.values(ports).map(freePort));
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const networks = JSON.parse(run('docker', ['network', 'inspect', ...run('docker', ['network', 'ls', '-q']).trim().split(/\s+/)]));
  if (networks.some(network => network.IPAM?.Config?.some(config => config.Subnet === subnet))) throw new Error('Harness subnet is already allocated.');
  const password = randomBytes(24).toString('base64url');
  const service = { email: 'r10-a3-2-service@example.test', password: `R10-${password}!` };
  const passphrase = randomUUID();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const config = { ...readJson(join(root, 'medplum.dr-drill.config.json')),
    baseUrl: `http://127.0.0.1:${ports.medplum}/`, appBaseUrl: `http://127.0.0.1:${ports.frontdoor}/`, storageBaseUrl: `http://127.0.0.1:${ports.medplum}/storage/`,
    signingKeyId: `r10-a3-2-${randomUUID()}`, signingKey: privateKey, signingKeyPassphrase: passphrase,
    defaultSuperAdminEmail: service.email, defaultSuperAdminPassword: service.password,
  };
  writeJson(join(runtime, 'medplum.config.json'), config);
  writeJson(join(runtime, 'service.json'), service);
  const composeConfig = { services: {
    postgres: { image: 'postgres:16-alpine', environment: { POSTGRES_DB: 'medplum', POSTGRES_USER: 'medplum', POSTGRES_PASSWORD: 'medplum' }, volumes: ['postgres:/var/lib/postgresql/data'], ports: [`127.0.0.1:${ports.postgres}:5432`], healthcheck: { test: ['CMD-SHELL', 'pg_isready -U medplum -d medplum'], interval: '2s', timeout: '3s', retries: 30 } },
    redis: { image: 'redis:7-alpine', command: ['redis-server', '--requirepass', 'medplum'], volumes: ['redis:/data'], ports: [`127.0.0.1:${ports.redis}:6379`], healthcheck: { test: ['CMD', 'redis-cli', '--pass', 'medplum', 'ping'], interval: '2s', timeout: '3s', retries: 30 } },
    'binary-init': { image: 'alpine:3.21', user: '0:0', command: ['chown', '-R', '1000:1000', '/data/binary'], volumes: ['binary:/data/binary'] },
    'medplum-server': { image: 'medplum/medplum-server:5.1.30', depends_on: { postgres: { condition: 'service_healthy' }, redis: { condition: 'service_healthy' }, 'binary-init': { condition: 'service_completed_successfully' } }, volumes: [`${runtime}/medplum.config.json:/config/medplum.config.json:ro`, 'binary:/data/binary'], ports: [`127.0.0.1:${ports.medplum}:8103`], command: ['file:/config/medplum.config.json'] },
  }, volumes: { postgres: {}, redis: {}, binary: {} }, networks: { default: { ipam: { config: [{ subnet }] } } } };
  writeJson(composePath, composeConfig);
  writeJson(manifestPath, { project, ports, runtime, subnet, root });
  console.log(`Prepared ${project}; isolated runtime ${runtime}`);
} else if (command === 'up') {
  try {
    compose('up', '-d');
    await waitHealth(`http://127.0.0.1:${ports.medplum}/healthcheck`, 180);
    const log = openSync(join(runtime, 'bootstrap.log'), 'a', 0o600);
    run(process.execPath, ['--import', 'tsx', join(root, 'docs/build-log/followup-s3c2a-queue-view/proof/bootstrap.ts'), runtime], { env: { ...cleanEnv, ODOS_SETUP_AUDIT_DISABLED: 'true', ODOS_POSTGRES_URL: `postgresql://medplum:medplum@127.0.0.1:${ports.postgres}/medplum` }, stdio: ['ignore', log, log] });
    console.log(`Synthetic stack and identities ready; credentials remain in ${runtime}/credentials.json`);
  } catch (error) { stopContainers(); throw error; }
} else if (command === 'build') {
  const head = cleanHead();
  const log = openSync(join(runtime, 'build.log'), 'a', 0o600);
  run('npm', ['--prefix', 'mcp', 'run', 'build'], { cwd: appRoot, stdio: ['ignore', log, log] });
  run('npm', ['--prefix', 'ui', 'run', 'build'], { cwd: appRoot, env: { ...cleanEnv, VITE_ODOS_MCP_BASE_URL: '' }, stdio: ['ignore', log, log] });
  cpSync(join(appRoot, 'data'), join(appRoot, 'mcp/dist/data'), { recursive: true });
  if (cleanHead() !== head) throw new Error('Commit changed during proof build.');
  writeJson(join(runtime, 'build.json'), { root: appRoot, head, dirty: false, mcpHash: createHash('sha256').update(readFileSync(join(appRoot, 'mcp/dist/mcp/src/index.js'))).digest('hex') });
  console.log(`Built MCP and UI from ${head}; ${appRoot}`);
} else if (command === 'serve') {
  const build = readJson(join(runtime, 'build.json'));
  if (build.dirty || cleanHead() !== build.head) throw new Error('Proof serve must use the same clean commit as build.');
  await waitHealth(`http://127.0.0.1:${ports.medplum}/healthcheck`, 180);
  await Promise.all([ports.frontdoor, ports.mcp, ports.proxy, ports.control].map(freePort));
  const smartKeyPath = join(runtime, 'smart-signing.pem');
  if (!existsSync(smartKeyPath)) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    writeFileSync(smartKeyPath, privateKey, { mode: 0o600 });
  }
  const credentials = readJson(join(runtime, 'credentials.json'));
  if (build.root !== appRoot) throw new Error('App root differs from recorded build. Build selected root first.');
  const source = readFileSync(join(appRoot, 'deploy/frontdoor/Caddyfile'), 'utf8');
  const generated = generateCaddyfile(source, ports);
  assertCaddyParity(source, generated, ports);
  writeFileSync(join(runtime, 'Caddyfile'), generated);
  const mcpLog = openSync(join(runtime, 'mcp.log'), 'a', 0o600);
  let mcp, proxy, caddy;
  let closing = false;
  const close = async (exitCode = 0, stopDatabase = true) => { if (closing) return; closing = true; mcp?.kill('SIGTERM'); caddy?.kill('SIGTERM'); await proxy?.close(); if (stopDatabase) stopContainers(); process.exit(exitCode); };
  process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
  process.once('SIGUSR2', () => void close(0, false));
  try {
    mcp = spawn(process.execPath, [join(appRoot, 'mcp/dist/mcp/src/index.js')], { cwd: appRoot, env: { ...cleanEnv, MEDPLUM_BASE_URL: `http://127.0.0.1:${ports.medplum}/`, MEDPLUM_PROJECT_ID: credentials.projectId, MEDPLUM_CLIENT_ID: credentials.runtimeService.clientId, MEDPLUM_CLIENT_SECRET: credentials.runtimeService.clientSecret, ODOS_POSTGRES_URL: `postgresql://medplum:medplum@127.0.0.1:${ports.postgres}/medplum`, ODOS_MCP_TRANSPORT: 'sse', ODOS_MCP_HTTP_PORT: String(ports.mcp), ODOS_MCP_HTTP_HOST: '127.0.0.1', ODOS_SMART_SIGNING_KEY_PATH: smartKeyPath }, stdio: ['ignore', mcpLog, mcpLog] });
    proxy = await startResponseProxy({ upstream: `http://127.0.0.1:${ports.mcp}`, port: ports.proxy, controlPort: ports.control, logPath: join(runtime, 'proxy.jsonl') });
    const caddyLog = openSync(join(runtime, 'caddy.log'), 'a', 0o600);
    caddy = spawn('caddy', ['run', '--config', join(runtime, 'Caddyfile'), '--adapter', 'caddyfile'], { cwd: root, env: { ...cleanEnv, ODOS_UI_DIST: join(appRoot, 'ui/dist') }, stdio: ['ignore', caddyLog, caddyLog] });
    writeJson(join(runtime, 'processes.json'), { supervisor: process.pid, mcp: mcp.pid, caddy: caddy.pid });
    mcp.once('exit', code => { if (!closing) { console.error(`MCP exited ${code}`); void close(1); } });
    caddy.once('exit', code => { if (!closing) { console.error(`Caddy exited ${code}`); void close(1); } });
    for (const child of [mcp, caddy]) child.once('error', error => { console.error(error.message); void close(1); });
    await waitHealth(`http://127.0.0.1:${ports.mcp}/clinical-graph/encounters/harness-readiness/findings`, 120, [401]);
    await waitHealth(`http://127.0.0.1:${ports.frontdoor}/`);
    await runReadinessChild(process.execPath, ['--import', 'tsx', join(root, 'docs/build-log/followup-s3c2a-queue-view/proof/verify-ready.ts'), runtime], { cwd: root, env: cleanEnv, stdio: ['ignore', mcpLog, mcpLog] });
    const index = await (await fetch(`http://127.0.0.1:${ports.frontdoor}/`)).text();
    const assets = [...index.matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)].map(match => match[1]);
    const hashes = {};
    for (const asset of assets) hashes[asset] = createHash('sha256').update(Buffer.from(await (await fetch(new URL(asset, `http://127.0.0.1:${ports.frontdoor}`))).arrayBuffer())).digest('hex');
    writeJson(join(runtime, 'identity.json'), { ...build, caddySourceHash: createHash('sha256').update(source).digest('hex'), servedAssets: hashes, medplumImageDigest: run('docker', ['image', 'inspect', 'medplum/medplum-server:5.1.30', '--format', '{{json .RepoDigests}}']).trim(), ports, project, mcpPid: mcp.pid, caddyPid: caddy.pid });
    console.log(`Served synthetic app: http://127.0.0.1:${ports.frontdoor}; drop control: http://127.0.0.1:${ports.control}; supervisor ${process.pid}`);
  } catch (error) { console.error(error.message); await close(1); }
} else if (command === 'stop-app') {
  const pids = readJson(join(runtime, 'processes.json'));
  process.kill(pids.supervisor, 'SIGUSR2');
  console.log('Stopping app processes only; containers remain running.');
} else if (command === 'stop') {
  if (existsSync(join(runtime, 'processes.json'))) {
    const pids = readJson(join(runtime, 'processes.json'));
    try { process.kill(pids.supervisor, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  stopContainers();
} else {
  throw new Error('Usage: node scripts/r10-served-route/stack.mjs prepare|up|build|serve|stop-app|stop [--app-root /absolute/checkout]');
}
