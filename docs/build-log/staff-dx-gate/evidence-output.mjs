import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const checkout = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim());

export function redactEvidencePaths(output) {
  return output.replaceAll(root, '<worktree>').replaceAll(checkout, '<checkout>').replaceAll(homedir(), '<home>');
}

export function writeEvidenceOutput(path, output) {
  const original = resolve(root, '.odos/staff-dx-gate/raw-evidence', relative(root, path) + '.raw');
  mkdirSync(dirname(original), { recursive: true, mode: 0o700 });
  writeFileSync(original, output, { mode: 0o600 });
  const published = redactEvidencePaths(output);
  writeFileSync(path, path.endsWith('.gz') ? gzipSync(published) : published);
}
