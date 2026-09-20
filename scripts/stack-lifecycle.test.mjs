import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const prefix = `odos-stack-lifecycle-${process.pid}`;
const root = resolve('.');
const script = resolve('scripts/stack-lifecycle.mjs');

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

test('ephemeral override resolves restart=no for every persistent base service', () => {
  const environmentFiles = [join(root, '.env'), join(root, '.odos', 'medplum-signing.env')];
  const created = [];
  try {
    for (const file of environmentFiles) {
      if (existsSync(file)) continue;
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, '');
      created.push(file);
    }
    const result = run('docker-compose', ['--profile', 'agentops', '-f', 'docker-compose.yml', '-f', 'docker-compose.ephemeral.yml', 'config', '--format', 'json'], {
      env: { ...process.env, MEDPLUM_DATABASE_PASSWORD: 'test', ODOS_REDIS_PASSWORD: 'test', MEDPLUM_ADMIN_EMAIL: 'test@example.test', MEDPLUM_ADMIN_PASSWORD: 'test', MEDPLUM_STORAGE_BASE_URL: 'http://localhost:8103/storage/' },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    const services = Array.isArray(parsed.services) ? Object.fromEntries(parsed.services.map((service) => [service.name, service])) : parsed.services;
    for (const name of ['postgres', 'redis', 'medplum-server', 'medplum-app', 'weasyprint']) {
      assert.ok(services[name], `resolved service ${name} is absent: ${JSON.stringify(parsed.services)}`);
      assert.equal(services[name].restart, 'no', name);
    }
  } finally {
    for (const file of created) rmSync(file, { force: true });
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
    const foreign = `${prefix}-foreign-container`;
    const created = run('docker', ['create', '--name', foreign, '--label', `com.docker.compose.project=${foreignProject}`, '--mount', `type=volume,source=${volume},target=/data`, 'alpine:3.21', 'true']);
    assert.equal(created.status, 0, created.stderr);
    const result = reap(['--yes', '--only', prefix, '--min-age', '0m']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`SKIP ${project}: .*foreign container ${foreign}`));
    assert.ok(docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]));
  } finally {
    cleanup([project, foreignProject], [fixture.directory]);
  }
});

test('reap refuses an unsafe low age threshold without --only', () => {
  const result = reap(['--min-age', '0m']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /below 1h without --only/);
});

test('list shows compose project state, newest-resource age, volume size, and unmanaged counts', () => {
  const project = `${prefix}-list`;
  const fixture = composeProject(project);
  try {
    const result = run(process.execPath, [script, 'list']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${project}: 1 container\\(s\\), 0 running, newest \\d+m, volumes \\d+B`));
    assert.match(result.stdout, new RegExp(`skip: newest resource is younger than 24h`));
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
