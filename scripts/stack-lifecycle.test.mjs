import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as lifecycle from './stack-lifecycle.mjs';

const prefix = `odos-stack-lifecycle-${process.pid}`;
const root = resolve('.');
const script = resolve('scripts/stack-lifecycle.mjs');
const dockerBinary = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
}

function docker(args) {
  return execFileSync('docker', args, { cwd: root, encoding: 'utf8' }).trim();
}

function listed(args) {
  return docker(args).split(/\s+/).filter(Boolean);
}

function count(args) {
  return listed(args).length;
}

function composeProject(project, { running = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), `${project}-`));
  const compose = join(directory, 'compose.yml');
  writeFileSync(compose, `services:\n  fixture:\n    image: alpine:3.21\n    command: [\"sh\", \"-c\", ${JSON.stringify(running ? 'sleep 600' : 'exit 0')}]\n    volumes:\n      - data:/data\nvolumes:\n  data:\n`);
  const result = run('docker-compose', ['-p', project, '-f', compose, 'up', '-d']);
  assert.equal(result.status, 0, result.stderr);
  return { directory, compose };
}

function cleanup(projects, directories = []) {
  for (const project of projects) {
    const containers = listed(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]);
    if (containers.length) run('docker', ['rm', '-f', ...containers]);
  }
  for (const project of projects) {
    for (const volume of listed(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])) run('docker', ['volume', 'rm', '-f', volume]);
    for (const network of listed(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])) run('docker', ['network', 'rm', network]);
  }
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
}

function reap(args) {
  return run(process.execPath, [script, 'reap', ...args]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(path, milliseconds = 10_000) {
  const deadline = Date.now() + milliseconds;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
    await delay(20);
  }
}

function runAsync(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, ...options });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function unmanagedCounts() {
  const containers = listed(['ps', '-aq']);
  const unlabelledContainers = containers.filter((id) => !JSON.parse(docker(['container', 'inspect', id, '--format', '{{json .Config.Labels}}']) || '{}')['com.docker.compose.project']).length;
  let anonymousVolumes = 0;
  let otherUnlabelledNamedVolumes = 0;
  for (const volume of listed(['volume', 'ls', '-q'])) {
    const labels = JSON.parse(docker(['volume', 'inspect', volume, '--format', '{{json .Labels}}']) || 'null') ?? {};
    if (labels['com.docker.compose.project']) continue;
    if (Object.hasOwn(labels, 'com.docker.volume.anonymous')) anonymousVolumes++;
    else otherUnlabelledNamedVolumes++;
  }
  return { unlabelledContainers, anonymousVolumes, otherUnlabelledNamedVolumes };
}

test('package scripts expose the reap, list, and explicit named teardown commands', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.equal(scripts['stack:reap'], 'node scripts/stack-lifecycle.mjs reap');
  assert.equal(scripts['stack:list'], 'node scripts/stack-lifecycle.mjs list');
  assert.equal(scripts['stack:down'], 'node scripts/stack-lifecycle.mjs down');
});

test('ephemeral override resolves restart=no for every persistent base service and exposes a missed service', () => {
  const environmentFiles = [join(root, '.env'), join(root, '.odos', 'medplum-signing.env')];
  const created = [];
  const environment = { ...process.env, MEDPLUM_DATABASE_PASSWORD: 'test', ODOS_REDIS_PASSWORD: 'test', MEDPLUM_ADMIN_EMAIL: 'test@example.test', MEDPLUM_ADMIN_PASSWORD: 'test', MEDPLUM_STORAGE_BASE_URL: 'http://localhost:8103/storage/' };
  const serviceMap = (result) => {
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed.services) ? Object.fromEntries(parsed.services.map((service) => [service.name, service])) : parsed.services;
  };
  const persistentNames = (services) => Object.entries(services).filter(([, service]) => service.restart === 'unless-stopped').map(([name]) => name);
  const assertOverridden = (base, resolved) => {
    const missing = persistentNames(base).filter((name) => resolved[name]?.restart !== 'no');
    assert.deepEqual(missing, [], `persistent services missing restart: no: ${missing.join(', ')}`);
  };
  try {
    for (const file of environmentFiles) {
      if (existsSync(file)) continue;
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, '');
      created.push(file);
    }
    const base = serviceMap(run('docker-compose', ['--profile', 'agentops', '-f', 'docker-compose.yml', 'config', '--format', 'json'], { env: environment }));
    const persistent = persistentNames(base);
    assert.ok(persistent.length > 0, 'base Compose must have persistent services to override');
    const merged = serviceMap(run('docker-compose', ['--profile', 'agentops', '-f', 'docker-compose.yml', '-f', 'docker-compose.ephemeral.yml', 'config', '--format', 'json'], { env: environment }));
    assertOverridden(base, merged);

    const temporary = mkdtempSync(join(tmpdir(), 'stack-lifecycle-persistent-service-'));
    try {
      const temporaryBase = join(temporary, 'docker-compose.yml');
      const contents = readFileSync('docker-compose.yml', 'utf8').replace('\nvolumes:\n', '\n  lifecycle-proof-sixth:\n    image: alpine:3.21\n    restart: unless-stopped\nvolumes:\n');
      assert.notEqual(contents, readFileSync('docker-compose.yml', 'utf8'), 'test fixture must add the sixth persistent service');
      writeFileSync(temporaryBase, contents);
      writeFileSync(join(temporary, '.env'), '');
      mkdirSync(join(temporary, '.odos'));
      writeFileSync(join(temporary, '.odos', 'medplum-signing.env'), '');
      const temporaryBaseServices = serviceMap(run('docker-compose', ['--profile', 'agentops', '-f', temporaryBase, 'config', '--format', 'json'], { env: environment, cwd: temporary }));
      const temporaryMerged = serviceMap(run('docker-compose', ['--profile', 'agentops', '-f', temporaryBase, '-f', join(root, 'docker-compose.ephemeral.yml'), 'config', '--format', 'json'], { env: environment, cwd: temporary }));
      assert.ok(persistentNames(temporaryBaseServices).includes('lifecycle-proof-sixth'));
      assert.throws(() => assertOverridden(temporaryBaseServices, temporaryMerged), /lifecycle-proof-sixth/);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } finally {
    for (const file of created) rmSync(file, { force: true });
  }
});

test('project recency uses creation, start, and finish timestamps while ignoring Docker zero timestamps', () => {
  assert.equal(lifecycle.dockerTimestamp('0001-01-01T00:00:00Z'), undefined);
  assert.equal(lifecycle.dockerTimestamp('not-a-timestamp'), undefined);
  assert.equal(lifecycle.projectRecency({ containers: [{ createdAt: Date.parse('2026-01-01T00:00:00Z'), startedAt: Date.parse('0001-01-01T00:00:00Z'), finishedAt: Date.parse('2026-01-01T00:10:00Z') }], volumes: [], networks: [] }), Date.parse('2026-01-01T00:10:00Z'));
  assert.equal(lifecycle.projectRecency({ containers: [{ createdAt: Date.parse('2026-01-01T00:00:00Z'), startedAt: Date.parse('2026-01-01T00:20:00Z'), finishedAt: Date.parse('0001-01-01T00:00:00Z') }], volumes: [], networks: [] }), Date.parse('2026-01-01T00:20:00Z'));
  assert.equal(lifecycle.projectRecency({ containers: [{ createdAt: Date.parse('2026-01-01T00:00:00Z'), startedAt: Number.NaN, finishedAt: Date.parse('2026-01-01T00:10:00Z') }, { createdAt: Date.parse('2026-01-01T00:05:00Z'), startedAt: Date.parse('2026-01-01T00:30:00Z'), finishedAt: Number.NaN }], volumes: [{ createdAt: Date.parse('2026-01-01T00:25:00Z') }], networks: [] }), Date.parse('2026-01-01T00:30:00Z'));
  assert.equal(lifecycle.projectRecency({ containers: [{ createdAt: Number.NaN, startedAt: Number.NaN, finishedAt: Number.NaN }], volumes: [], networks: [] }), undefined);
});

test('reap refuses a compose-labelled project with no usable resource age', () => {
  const project = { name: 'age-unavailable', containers: [{ labels: {}, createdAt: Number.NaN, startedAt: Number.NaN, finishedAt: Number.NaN, running: false, volumeNames: [] }], volumes: [], networks: [] };
  const options = { command: 'reap', force: false, minAge: '1h', minAgeMs: 3_600_000, protect: [] };
  assert.deepEqual(lifecycle.refusalReasons(project, options, { containers: project.containers }), ['resource age unavailable']);
});

test('reap refuses a project created before the threshold when it stopped within the threshold', async () => {
  const project = `${prefix}-finished-recently`;
  const fixture = composeProject(project);
  try {
    await delay(65_000);
    const restarted = run('docker-compose', ['-p', project, '-f', fixture.compose, 'start']);
    assert.equal(restarted.status, 0, restarted.stderr);
    const result = reap(['--yes', '--only', prefix, '--min-age', '1m']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`SKIP ${project}: .*younger than 1m`));
    assert.ok(docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]));
  } finally {
    cleanup([project], [fixture.directory]);
  }
});

test('reap refreshes inventory and spares a project restarted between its plan and removal', async () => {
  const project = `${prefix}-restart-race`;
  const fixture = composeProject(project, { running: true });
  const shimDirectory = mkdtempSync(join(tmpdir(), `${project}-shim-`));
  const ready = join(shimDirectory, 'ready');
  const resume = join(shimDirectory, 'resume');
  const shim = join(shimDirectory, 'docker');
  try {
    const stopped = run('docker-compose', ['-p', project, '-f', fixture.compose, 'stop']);
    assert.equal(stopped.status, 0, stopped.stderr);
    writeFileSync(shim, `#!/bin/sh\nif [ \"$1\" = rm ] && [ ! -e ${JSON.stringify(ready)} ]; then\n  : > ${JSON.stringify(ready)}\n  while [ ! -e ${JSON.stringify(resume)} ]; do sleep 0.02; done\nfi\nexec ${JSON.stringify(dockerBinary)} \"$@\"\n`);
    chmodSync(shim, 0o755);
    const reaping = runAsync(process.execPath, [script, 'reap', '--yes', '--only', prefix, '--min-age', '0m'], { env: { ...process.env, PATH: `${shimDirectory}:${process.env.PATH}` } });
    await waitFor(ready);
    const restarted = run('docker-compose', ['-p', project, '-f', fixture.compose, 'start']);
    assert.equal(restarted.status, 0, restarted.stderr);
    writeFileSync(resume, 'go\n');
    const result = await reaping;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`SKIP ${project}: .*running container`));
    assert.match(result.stdout, /REMOVED 0 project\(s\); SKIPPED 1; FAILED 0/);
    assert.ok(docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`]));
  } finally {
    cleanup([project], [fixture.directory]);
    rmSync(shimDirectory, { recursive: true, force: true });
  }
});

test('direct execution through a symlink and a path with spaces always runs main', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stack lifecycle entrypoint-'));
  try {
    const linkedDirectory = join(directory, 'linked-scripts');
    symlinkSync(resolve('scripts'), linkedDirectory, 'dir');
    const linked = join(linkedDirectory, 'stack-lifecycle.mjs');
    const spacedDirectory = join(directory, 'path with spaces');
    mkdirSync(spacedDirectory);
    const spaced = join(spacedDirectory, 'stack-lifecycle.mjs');
    writeFileSync(spaced, readFileSync(script));
    for (const entry of [linked, spaced]) {
      const missing = run(process.execPath, [entry, 'down', 'does-not-exist']);
      assert.equal(missing.status, 1, `${entry}: ${missing.stderr}`);
      assert.match(missing.stderr, /No compose-labelled resources found/);
      const list = run(process.execPath, [entry, 'list']);
      assert.equal(list.status, 0, list.stderr);
      assert.match(list.stdout, /Unmanaged resources:/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reap refuses a short --only prefix below one hour', () => {
  const result = reap(['--only', 'odos', '--min-age', '0m']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 12 characters/);
});

test('built-in protected names preserve Compose hyphens and underscores and down respects protection', () => {
  assert.deepEqual(lifecycle.protectedProjects({ protect: ['manual'] }, '/tmp/zzeval636-prot_dir'), new Set(['zzeval636-prot_dir', 'visionforge', 'manual']));
  const project = `${prefix}-protected-down`;
  const fixture = composeProject(project);
  try {
    const refused = run(process.execPath, [script, 'down', project, '--protect', project]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /protected project/);
    assert.ok(docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]));
  } finally {
    cleanup([project], [fixture.directory]);
  }
});

test('Compose default project names retain hyphens and underscores and protect the current directory stack', () => {
  const parent = mkdtempSync(join(tmpdir(), 'stack-lifecycle-project-name-'));
  const directory = join(parent, 'zzeval636-prot_dir');
  const project = 'zzeval636-prot_dir';
  mkdirSync(directory);
  const compose = join(directory, 'compose.yml');
  writeFileSync(compose, 'services:\n  fixture:\n    image: alpine:3.21\n    command: ["true"]\n    volumes:\n      - data:/data\nvolumes:\n  data:\n');
  try {
    const started = run('docker-compose', ['-f', compose, 'up', '-d'], { cwd: directory });
    assert.equal(started.status, 0, started.stderr);
    assert.ok(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]), 'Docker Compose default project label retained hyphen and underscore');
    const result = run(process.execPath, [script, 'reap', '--yes', '--only', project, '--min-age', '0m'], { cwd: directory });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`SKIP ${project}: protected project`));
  } finally {
    cleanup([project], [parent]);
  }
});

test('dry-run removes nothing even when a stopped compose project is eligible', () => {
  const project = `${prefix}-dry-run`;
  const fixture = composeProject(project);
  try {
    const volume = docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
    const before = {
      containers: count(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]),
      volumes: count(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]),
      networks: count(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]),
    };
    assert.ok(volume, 'fixture compose volume exists before dry run');
    const result = reap(['--only', prefix, '--min-age', '0m']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(project));
    assert.match(result.stdout, /DRY RUN/);
    assert.deepEqual({
      containers: count(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]),
      volumes: count(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]),
      networks: count(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]),
    }, before);
  } finally {
    cleanup([project], [fixture.directory]);
  }
});

test('reap with --yes removes compose-labelled containers, networks, and volumes', () => {
  const project = `${prefix}-remove`;
  const fixture = composeProject(project);
  try {
    const volume = docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
    assert.ok(volume, 'volume exists before removal');
    const result = reap(['--yes', '--only', prefix, '--min-age', '0m']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`REMOVE ${project}`));
    assert.match(result.stdout, /REMOVED 1 project/);
    assert.equal(docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
    assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]), '');
    assert.equal(docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
  } finally {
    cleanup([project], [fixture.directory]);
  }
});

test('reap refuses a compose project with a running container', () => {
  const project = `${prefix}-running`;
  const fixture = composeProject(project, { running: true });
  try {
    const result = reap(['--yes', '--only', prefix, '--min-age', '0m']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`SKIP ${project}: .*running container`));
    assert.ok(docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`]));
  } finally {
    cleanup([project], [fixture.directory]);
  }
});

test('reap refuses a compose project younger than the age threshold', () => {
  const project = `${prefix}-young`;
  const fixture = composeProject(project);
  try {
    const result = reap(['--yes', '--only', prefix, '--min-age', '1h']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`SKIP ${project}: .*younger than 1h`));
    assert.ok(docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]));
  } finally {
    cleanup([project], [fixture.directory]);
  }
});

test('reap refuses a project protected by --protect', () => {
  const project = `${prefix}-protected`;
  const fixture = composeProject(project);
  try {
    const result = reap(['--yes', '--only', prefix, '--min-age', '0m', '--protect', project]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`SKIP ${project}: protected project`));
    assert.ok(docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]));
  } finally {
    cleanup([project], [fixture.directory]);
  }
});

test('reap refuses a project whose volume is mounted by a foreign project container', () => {
  const project = `${prefix}-foreign-source`;
  const foreignProject = `${prefix}-foreign-user`;
  const fixture = composeProject(project);
  try {
    const volume = docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
    const before = {
      containers: count(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]),
      networks: count(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]),
      volumes: count(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]),
    };
    const foreign = `${prefix}-foreign-container`;
    const created = run('docker', ['create', '--name', foreign, '--label', `com.docker.compose.project=${foreignProject}`, '--mount', `type=volume,source=${volume},target=/data`, 'alpine:3.21', 'true']);
    assert.equal(created.status, 0, created.stderr);
    const result = reap(['--yes', '--only', prefix, '--min-age', '0m']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`SKIP ${project}: .*foreign container ${foreign}`));
    assert.ok(docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]));
    assert.deepEqual({
      containers: count(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]),
      networks: count(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]),
      volumes: count(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]),
    }, before);
  } finally {
    cleanup([project, foreignProject], [fixture.directory]);
  }
});

test('reap refuses an unsafe low age threshold without --only', () => {
  const result = reap(['--min-age', '0m']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /below 1h without --only/);
});

test('list shows compose project state, last activity, volume size, and unmanaged counts', () => {
  const project = `${prefix}-list`;
  const fixture = composeProject(project);
  try {
    const result = run(process.execPath, [script, 'list']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${project}: 1 container\\(s\\), 0 running, last activity \\d{4}-\\d{2}-\\d{2}T`));
    assert.match(result.stdout, new RegExp(`skip: most recent activity is younger than 24h`));
    assert.match(result.stdout, /Unmanaged resources:/);
  } finally {
    cleanup([project], [fixture.directory]);
  }
});

test('down removes a stopped named project and its compose-labelled volumes', () => {
  const project = `${prefix}-down`;
  const fixture = composeProject(project);
  try {
    const result = run(process.execPath, [script, 'down', project]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`REMOVED ${project}`));
    assert.equal(docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
  } finally {
    cleanup([project], [fixture.directory]);
  }
});

test('down refuses a running project until its caller supplies --force', () => {
  const project = `${prefix}-down-running`;
  const fixture = composeProject(project, { running: true });
  try {
    const refused = run(process.execPath, [script, 'down', project]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /running container/);
    assert.ok(docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`]));
    const forced = run(process.execPath, [script, 'down', project, '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
  } finally {
    cleanup([project], [fixture.directory]);
  }
});

test('reap reports and preserves non-compose containers and both non-compose volume kinds', () => {
  const project = `${prefix}-unmanaged-target`;
  const fixture = composeProject(project);
  const container = `${prefix}-plain-container`;
  const namedVolume = `${prefix}-plain-volume`;
  let anonymousVolume;
  const before = unmanagedCounts();
  try {
    assert.equal(run('docker', ['create', '--name', container, 'alpine:3.21', 'true']).status, 0);
    assert.equal(run('docker', ['create', '--name', `${prefix}-anonymous-owner`, '--mount', 'type=volume,target=/data', 'alpine:3.21', 'true']).status, 0);
    anonymousVolume = docker(['container', 'inspect', `${prefix}-anonymous-owner`, '--format', '{{(index .Mounts 0).Name}}']);
    assert.equal(run('docker', ['volume', 'create', namedVolume]).status, 0);
    const expected = unmanagedCounts();
    const result = reap(['--yes', '--only', prefix, '--min-age', '0m']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${expected.unlabelledContainers} unlabelled container\\(s\\)`));
    assert.match(result.stdout, new RegExp(`${expected.anonymousVolumes} anonymous volume\\(s\\)`));
    assert.match(result.stdout, new RegExp(`${expected.otherUnlabelledNamedVolumes} other unlabelled named volume\\(s\\)`));
    assert.ok(docker(['container', 'inspect', container]));
    assert.ok(docker(['volume', 'inspect', anonymousVolume]));
    assert.ok(docker(['volume', 'inspect', namedVolume]));
    assert.deepEqual(unmanagedCounts(), expected);
  } finally {
    run('docker', ['rm', '-f', container]);
    run('docker', ['rm', '-f', `${prefix}-anonymous-owner`]);
    if (anonymousVolume) run('docker', ['volume', 'rm', '-f', anonymousVolume]);
    run('docker', ['volume', 'rm', '-f', namedVolume]);
    cleanup([project], [fixture.directory]);
  }
});
