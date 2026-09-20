import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';

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
  if (command === 'reap' && options.minAgeMs < 3_600_000 && !options.only) throw new Error('Refusing --min-age below 1h without --only <name-prefix>.');
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

function projectNameForDirectory(directory) {
  return basename(resolve(directory)).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function inventory() {
  const sizeReport = JSON.parse(docker(['system', 'df', '-v', '--format', '{{json .}}']));
  const volumeSizes = new Map((sizeReport.Volumes ?? []).map((volume) => [volume.Name, sizeBytes(volume.Size)]));
  const containers = inspect('container', ids(['ps', '-aq'])).map((item) => ({
    id: item.Id,
    name: item.Name.slice(1),
    labels: item.Config.Labels ?? {},
    createdAt: Date.parse(item.Created),
    running: item.State.Running,
    volumeNames: item.Mounts.filter((mount) => mount.Type === 'volume').map((mount) => mount.Name),
  }));
  const volumes = inspect('volume', ids(['volume', 'ls', '-q'])).map((item) => ({
    name: item.Name,
    labels: item.Labels ?? {},
    createdAt: Date.parse(item.CreatedAt),
    size: volumeSizes.get(item.Name) ?? 0,
  }));
  const networks = inspect('network', ids(['network', 'ls', '-q'])).map((item) => ({
    id: item.Id,
    name: item.Name,
    labels: item.Labels ?? {},
    createdAt: Date.parse(item.Created),
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

function protectedProjects(options) {
  return new Set([projectNameForDirectory(process.cwd()), 'visionforge', ...options.protect].map((project) => project.toLowerCase()));
}

function newest(project) {
  const dates = [...project.containers, ...project.volumes, ...project.networks].map((resource) => resource.createdAt);
  return dates.length ? Math.max(...dates) : Number.NaN;
}

function refusalReasons(project, options, current) {
  const reasons = [];
  if (protectedProjects(options).has(project.name.toLowerCase())) reasons.push('protected project');
  if (project.containers.some((container) => container.running) && !(options.command === 'down' && options.force)) reasons.push('running container');
  if (options.command !== 'down') {
    const createdAt = newest(project);
    if (!Number.isFinite(createdAt)) reasons.push('resource age unavailable');
    else if (Date.now() - createdAt < options.minAgeMs) reasons.push(`newest resource is younger than ${options.minAge}`);
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
  console.log(`REMOVE ${project.name}:`);
  for (const container of project.containers) console.log(`  container ${container.name} (${container.id.slice(0, 12)})`);
  for (const network of project.networks) console.log(`  network ${network.name} (${network.id.slice(0, 12)})`);
  for (const volume of project.volumes) console.log(`  volume ${volume.name} (${formatBytes(volume.size)})`);
}

function remove(project) {
  for (const container of project.containers) docker(['rm', '-f', container.id]);
  for (const network of project.networks) docker(['network', 'rm', network.id]);
  for (const volume of project.volumes) {
    const current = inspect('volume', [volume.name])[0];
    if (current.Labels?.[composeProjectLabel] !== project.name) throw new Error(`Refusing volume ${volume.name}: its compose-project label changed.`);
    docker(['volume', 'rm', volume.name]);
  }
}

function projectSummary(project) {
  const newestAt = newest(project);
  const age = Number.isFinite(newestAt) ? `${Math.max(0, Math.floor((Date.now() - newestAt) / 60_000))}m` : 'unknown';
  const size = project.volumes.reduce((total, volume) => total + volume.size, 0);
  return `${project.name}: ${project.containers.length} container(s), ${project.containers.filter((container) => container.running).length} running, newest ${age}, volumes ${formatBytes(size)}`;
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
  const reclaimed = removable.reduce((total, project) => total + project.volumes.reduce((volumeTotal, volume) => volumeTotal + volume.size, 0), 0);
  for (const project of removable) remove(project);
  console.log(`REMOVED ${removable.length} project(s); reclaimed ${formatBytes(reclaimed)} from named volumes.`);
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
  remove(project);
  const reclaimed = project.volumes.reduce((total, volume) => total + volume.size, 0);
  console.log(`REMOVED ${project.name}; reclaimed ${formatBytes(reclaimed)} from named volumes.`);
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.command === 'reap') reap(options);
    if (options.command === 'list') list(options);
    if (options.command === 'down') down(options);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
