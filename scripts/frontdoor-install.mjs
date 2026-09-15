#!/usr/bin/env node
import { constants, chmodSync, openSync, closeSync, fsyncSync, renameSync, linkSync, realpathSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export function renderFrontdoor(template, uiDist) {
  if (!isAbsolute(uiDist) || /[{}\r\n\0]/.test(uiDist)) throw new Error('--ui-dist must be an absolute path without Caddy placeholders or control characters');
  const pathToken = /[\s"#\\]/.test(uiDist) ? JSON.stringify(uiDist) : uiDist;
  const rendered = template.replaceAll('{$ODOS_UI_DIST}', pathToken);
  if (rendered.includes('{$')) throw new Error('Rendered config contains an unresolved placeholder');
  return rendered;
}

export function main(args = process.argv.slice(2)) {
  let temp;
  let staging;
  try {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--apply' && !options.apply) options.apply = true;
      else if (['--ui-dist', '--target'].includes(arg) && !options[arg] && args[i + 1] && !args[i + 1].startsWith('--')) options[arg] = args[++i];
      else throw new Error(`Unknown, duplicate, or incomplete argument: ${arg}`);
    }
    const uiDist = options['--ui-dist'];
    const target = options['--target'];
    if (!uiDist || !target || !isAbsolute(uiDist) || !isAbsolute(target)) throw new Error('Usage: frontdoor-install.mjs --ui-dist <absolute directory> --target <absolute file> [--apply]');
    if (!statSync(uiDist).isDirectory()) throw new Error('--ui-dist must be an existing directory');
    const original = existsSync(target) ? readFileSync(target) : null;
    const template = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../deploy/frontdoor/Caddyfile'), 'utf8');
    const rendered = renderFrontdoor(template, uiDist);
    temp = mkdtempSync(join(tmpdir(), 'odos-frontdoor-'));
    const config = join(temp, 'Caddyfile');
    writeFileSync(config, rendered);
    console.log('Running caddy validate --adapter caddyfile on rendered config');
    const validation = spawnSync('caddy', ['validate', '--adapter', 'caddyfile', '--config', config], { encoding: 'utf8' });
    if (validation.error?.code === 'ENOENT') throw new Error('caddy is required but was not found on PATH; validation cannot be skipped');
    if (validation.stdout) process.stdout.write(validation.stdout);
    if (validation.stderr) process.stderr.write(validation.stderr);
    if (validation.error || validation.status !== 0) throw new Error(`caddy validate failed (${validation.status ?? validation.error?.message})`);
    const before = join(temp, 'before');
    writeFileSync(before, original ?? '');
    const diff = spawnSync('diff', ['-u', '--label', target, '--label', `${target} (rendered)`, before, config], { encoding: 'utf8' });
    if (diff.error || ![0, 1].includes(diff.status)) throw new Error(`diff failed: ${diff.error?.message ?? diff.stderr}`);
    process.stdout.write(diff.stdout || 'No differences.\n');
    if (!options.apply) { console.log('Dry run: target unchanged.'); return 0; }
    const current = existsSync(target) ? readFileSync(target) : null;
    if (original === null ? current !== null : current === null || !current.equals(original)) throw new Error('Target changed during validation; rerun before applying');
    if (diff.status === 0) { console.log('Target already matches; no write required.'); return 0; }
    staging = mkdtempSync(join(dirname(target), '.odos-frontdoor-'));
    const stagedFile = join(staging, 'Caddyfile');
    writeFileSync(stagedFile, rendered, { flag: 'wx', mode: original === null ? 0o600 : statSync(target).mode & 0o777 });
    if (original !== null) chmodSync(stagedFile, statSync(target).mode & 0o777);
    const stagedFd = openSync(stagedFile, 'r');
    try { fsyncSync(stagedFd); } finally { closeSync(stagedFd); }
    if (original !== null) {
      const backup = `${target}.bak-${new Date().toISOString().replaceAll(':', '-')}`;
      copyFileSync(target, backup, constants.COPYFILE_EXCL);
      console.log(`Backup: ${backup}`);
    }
    if (original === null) linkSync(stagedFile, target);
    else renameSync(stagedFile, target);
    console.log('Applied. No service restarted; restart remains an operator step.');
    return 0;
  } catch (err) { console.error(`Front-door install: ${err.message}`); return 1; }
  finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main();
