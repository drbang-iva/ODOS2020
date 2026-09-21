import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const project = 'odos-s3c1-proof';
const runtime = join(root, '.odos/s3c1-proof');
const ports = { frontdoor: 34891, medplum: 34904, postgres: 29846, redis: 30792, mcp: 28944, proxy: 28945, control: 28946 };
const subnet = '10.249.188.0/24';
const composePath = join(runtime, 'compose.json');
const manifestPath = join(runtime, 'manifest.json');
const command = process.argv[2];
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
  const service = { email: 's3c1-service@example.test', password: `S3c1-${password}!` };
  const passphrase = randomUUID();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const config = { ...readJson(join(root, 'medplum.dr-drill.config.json')),
    baseUrl: `http://127.0.0.1:${ports.medplum}/`, appBaseUrl: `http://127.0.0.1:${ports.frontdoor}/`, storageBaseUrl: `http://127.0.0.1:${ports.medplum}/storage/`,
    signingKeyId: `s3c1-${randomUUID()}`, signingKey: privateKey, signingKeyPassphrase: passphrase,
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
    console.log('Synthetic Medplum stack ready.');
  } catch (error) { stopContainers(); throw error; }
} else if (command === 'stop') {
  stopContainers();
} else { throw new Error('Use prepare, up, or stop.'); }
