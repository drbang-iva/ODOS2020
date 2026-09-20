import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const composeProjectLabel = 'com.docker.compose.project';
const anonymousVolumeLabel = 'com.docker.volume.anonymous';

function docker(args, allowFailure = false) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8' }).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw new Error(error.stderr?.toString().trim() || `docker ${args.join(' ')} failed`);
  }
}

function ids(args) {
  return docker(args).split(/\s+/).filter(Boolean);
}

function inspect(kind, resourceIds) {
  return resourceIds.length ? JSON.parse(docker([kind, 'inspect', ...resourceIds])) : [];
}

function parseDuration(value) {
  const match = /^(\d+)([mhd])$/.exec(value);
  if (!match) throw new Error(`Invalid --min-age ${JSON.stringify(value)}; use a whole number followed by m, h, or d.`);
  return Number(match[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]);
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!['reap', 'list', 'down'].includes(command)) throw new Error('Usage: stack-lifecycle.mjs <reap|list|down> [project] [--yes] [--force] [--only prefix] [--min-age 24h] [--protect project]');
  const options = { command, yes: false, force: false, only: undefined, minAge: '24h', protect: [], project: undefined };
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--yes') options.yes = true;
    else if (arg === '--force') options.force = true;
    else if (['--only', '--min-age', '--protect'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--only') options.only = value;
      if (arg === '--min-age') options.minAge = value;
      if (arg === '--protect') options.protect.push(value);
    } else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (command === 'down') {
    if (positional.length !== 1) throw new Error('stack:down requires exactly one compose project name.');
    options.project = positional[0];
  } else if (positional.length) throw new Error(`${command} does not accept a project name.`);
  options.minAgeMs = parseDuration(options.minAge);
  if (command === 'reap' && options.minAgeMs < 3_600_000 && (!options.only || options.only.length < 12)) throw new Error('Refusing --min-age below 1h without --only <name-prefix> of at least 12 characters.');
  return options;
}

function sizeBytes(value) {
  const match = /^(\d+(?:\.\d+)?)(B|kB|MB|GB|TB)$/.exec(value ?? '0B');
  return match ? Math.round(Number(match[1]) * ({ B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[match[2]])) : 0;
}

function formatBytes(bytes) {
  for (const [suffix, divisor] of [['TB', 1e12], ['GB', 1e9], ['MB', 1e6], ['kB', 1e3]]) {
    if (bytes >= divisor) return `${(bytes / divisor).toFixed(bytes % divisor === 0 ? 0 : 1)}${suffix}`;
  }
  return `${bytes}B`;
}

export function projectNameForDirectory(directory) {
  return basename(resolve(directory)).toLowerCase().replace(/[^a-z0-9_-]+/g, '');
}

export function dockerTimestamp(value) {
  if (!value || value.startsWith('0001-01-01')) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function inventory() {
  const sizeReport = JSON.parse(docker(['system', 'df', '-v', '--format', '{{json .}}']));
  const volumeSizes = new Map((sizeReport.Volumes ?? []).map((volume) => [volume.Name, sizeBytes(volume.Size)]));
  const containers = inspect('container', ids(['ps', '-aq'])).map((item) => ({
    id: item.Id,
    name: item.Name.slice(1),
    labels: item.Config.Labels ?? {},
    createdAt: dockerTimestamp(item.Created),
    running: item.State.Running,
    startedAt: dockerTimestamp(item.State.StartedAt),
    finishedAt: dockerTimestamp(item.State.FinishedAt),
    volumeNames: item.Mounts.filter((mount) => mount.Type === 'volume').map((mount) => mount.Name),
  }));
  const volumes = inspect('volume', ids(['volume', 'ls', '-q'])).map((item) => ({
    name: item.Name,
    labels: item.Labels ?? {},
    createdAt: dockerTimestamp(item.CreatedAt),
    size: volumeSizes.get(item.Name) ?? 0,
  }));
  const networks = inspect('network', ids(['network', 'ls', '-q'])).map((item) => ({
    id: item.Id,
    name: item.Name,
    labels: item.Labels ?? {},
    createdAt: dockerTimestamp(item.Created),
  }));
  return { containers, volumes, networks };
}

function projectsFrom(current) {
  const projects = new Map();
  for (const [kind, resources] of Object.entries(current)) {
    for (const resource of resources) {
      const project = resource.labels[composeProjectLabel];
      if (!project) continue;
      if (!projects.has(project)) projects.set(project, { name: project, containers: [], volumes: [], networks: [] });
      projects.get(project)[kind].push(resource);
    }
  }
  return [...projects.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function protectedProjects(options, directory = process.cwd()) {
  return new Set([projectNameForDirectory(directory), 'visionforge', ...(options.protect ?? [])].map((project) => project.toLowerCase()));
}

export function projectRecency(project) {
  const timestamps = [
    ...[...project.containers, ...project.volumes, ...project.networks].map((resource) => resource.createdAt),
    ...project.containers.flatMap((container) => [container.startedAt, container.finishedAt]),
  ].filter((timestamp) => Number.isFinite(timestamp));
  return timestamps.length ? Math.max(...timestamps) : undefined;
}

function recencyDescription(project) {
  const timestamp = projectRecency(project);
  if (!Number.isFinite(timestamp)) return 'unavailable';
  return `${new Date(timestamp).toISOString()} (${Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))}m ago)`;
}

export function refusalReasons(project, options, current) {
  const reasons = [];
  if (protectedProjects(options).has(project.name.toLowerCase())) reasons.push('protected project');
  if (project.containers.some((container) => container.running) && !(options.command === 'down' && options.force)) reasons.push('running container');
  if (options.command !== 'down') {
    const recency = projectRecency(project);
    if (!Number.isFinite(recency)) reasons.push('resource age unavailable');
    else if (Date.now() - recency < options.minAgeMs) reasons.push(`most recent activity is younger than ${options.minAge}`);
  }
  const projectVolumes = new Set(project.volumes.map((volume) => volume.name));
  const foreignContainer = current.containers.find((container) => container.labels[composeProjectLabel] !== project.name && container.volumeNames.some((name) => projectVolumes.has(name)));
  if (foreignContainer) reasons.push(`volume mounted by foreign container ${foreignContainer.name}`);
  return reasons;
}

function unmanagedCounts(current) {
  const unlabelledContainers = current.containers.filter((container) => !container.labels[composeProjectLabel]).length;
  const anonymousVolumes = current.volumes.filter((volume) => !volume.labels[composeProjectLabel] && Object.hasOwn(volume.labels, anonymousVolumeLabel)).length;
  const otherUnlabelledNamedVolumes = current.volumes.filter((volume) => !volume.labels[composeProjectLabel] && !Object.hasOwn(volume.labels, anonymousVolumeLabel)).length;
  return { unlabelledContainers, anonymousVolumes, otherUnlabelledNamedVolumes };
}

function printUnmanaged(current) {
  const counts = unmanagedCounts(current);
  console.log(`Unmanaged resources: ${counts.unlabelledContainers} unlabelled container(s); ${counts.anonymousVolumes} anonymous volume(s); ${counts.otherUnlabelledNamedVolumes} other unlabelled named volume(s).`);
}

function printPlan(project) {
  console.log(`REMOVE ${project.name} (last activity ${recencyDescription(project)}):`);
  for (const container of project.containers) console.log(`  container ${container.name} (${container.id.slice(0, 12)})`);
  for (const network of project.networks) console.log(`  network ${network.name} (${network.id.slice(0, 12)})`);
  for (const volume of project.volumes) console.log(`  volume ${volume.name} (${formatBytes(volume.size)})`);
}

function remove(project, { forceContainers = false } = {}) {
  for (const container of project.containers) docker(['rm', ...(forceContainers ? ['-f'] : []), container.id]);
  for (const network of project.networks) docker(['network', 'rm', network.id]);
  for (const volume of project.volumes) {
    const current = inspect('volume', [volume.name])[0];
    if (current.Labels?.[composeProjectLabel] !== project.name) throw new Error(`Refusing volume ${volume.name}: its compose-project label changed.`);
    docker(['volume', 'rm', volume.name]);
  }
}

function projectSummary(project) {
  const size = project.volumes.reduce((total, volume) => total + volume.size, 0);
  return `${project.name}: ${project.containers.length} container(s), ${project.containers.filter((container) => container.running).length} running, last activity ${recencyDescription(project)}, volumes ${formatBytes(size)}`;
}

function reap(options) {
  const current = inventory();
  const removable = [];
  for (const project of projectsFrom(current).filter((candidate) => !options.only || candidate.name.startsWith(options.only))) {
    const reasons = refusalReasons(project, options, current);
    if (reasons.length) console.log(`SKIP ${project.name}: ${reasons.join(', ')}.`);
    else {
      printPlan(project);
      removable.push(project);
    }
  }
  printUnmanaged(current);
  if (!options.yes) {
    console.log(`DRY RUN: ${removable.length} project(s) would be removed; nothing was removed.`);
    return;
  }
  const removed = [];
  const skipped = [];
  const failures = [];
  for (const planned of removable) {
    const fresh = inventory();
    const project = projectsFrom(fresh).find((candidate) => candidate.name === planned.name);
    if (!project) {
      skipped.push(`${planned.name}: no compose-labelled resources remain`);
      console.log(`SKIP ${planned.name}: no compose-labelled resources remain.`);
      continue;
    }
    const reasons = refusalReasons(project, options, fresh);
    if (reasons.length) {
      skipped.push(`${project.name}: ${reasons.join(', ')}`);
      console.log(`SKIP ${project.name}: ${reasons.join(', ')}.`);
      continue;
    }
    try {
      remove(project);
      removed.push(project);
    } catch (error) {
      const afterFailure = inventory();
      const changedProject = projectsFrom(afterFailure).find((candidate) => candidate.name === planned.name);
      const changedReasons = changedProject ? refusalReasons(changedProject, options, afterFailure) : [];
      if (changedReasons.length) {
        skipped.push(`${planned.name}: ${changedReasons.join(', ')}`);
        console.log(`SKIP ${planned.name}: ${changedReasons.join(', ')}.`);
      } else {
        failures.push(`${planned.name}: ${error.message}`);
        console.error(`FAILED ${planned.name}: ${error.message}`);
      }
    }
  }
  const reclaimed = removed.reduce((total, project) => total + project.volumes.reduce((volumeTotal, volume) => volumeTotal + volume.size, 0), 0);
  console.log(`REMOVED ${removed.length} project(s); SKIPPED ${skipped.length}; FAILED ${failures.length}; reclaimed ${formatBytes(reclaimed)} from named volumes.`);
  return failures.length ? 1 : 0;
}

function list(options) {
  const current = inventory();
  for (const project of projectsFrom(current)) {
    const reasons = refusalReasons(project, { ...options, command: 'reap' }, current);
    console.log(`${projectSummary(project)}; ${reasons.length ? `skip: ${reasons.join(', ')}` : 'ready to reap'}`);
  }
  printUnmanaged(current);
}

function down(options) {
  const current = inventory();
  const project = projectsFrom(current).find((candidate) => candidate.name === options.project);
  if (!project) throw new Error(`No compose-labelled resources found for project ${options.project}.`);
  const reasons = refusalReasons(project, options, current);
  if (reasons.length) throw new Error(`Refusing ${project.name}: ${reasons.join(', ')}.`);
  printPlan(project);
  remove(project, { forceContainers: options.force });
  const reclaimed = project.volumes.reduce((total, volume) => total + volume.size, 0);
  console.log(`REMOVED ${project.name}; reclaimed ${formatBytes(reclaimed)} from named volumes.`);
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.command === 'reap') return reap(options) ?? 0;
    if (options.command === 'list') return list(options) ?? 0;
    if (options.command === 'down') return down(options) ?? 0;
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (!process.argv[1]) {
  console.error('Cannot run stack lifecycle tool: invoked script path is unavailable.');
  process.exitCode = 1;
} else {
  try {
    if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main();
  } catch (error) {
    console.error(`Cannot run stack lifecycle tool: ${error.message}`);
    process.exitCode = 1;
  }
}
