import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const evidenceDirectory = dirname(fileURLToPath(import.meta.url));
const templatePath = resolve(sourceRoot, 'docs/build-log/guarantor-g2b1/live-fixture.mjs');
const privateDirectory = resolve(sourceRoot, '.odos/staff-dx-gate');
const generatedPath = resolve(privateDirectory, 'fixture/live-fixture.mjs');
const template = readFileSync(templatePath, 'utf8');
const replacements = [
  ["'g2b1-build-live'", "'staff-dx-gate-live'"],
  ["'10.249.60.0/24'", "'10.249.78.0/24'"],
  ['28760', '28980'], ['28761', '28981'], ['28762', '28982'],
  ['28763', '28983'], ['28764', '28984'], ['28765', '28985'],
];
let generated = template;
for (const [before, after] of replacements) {
  assert.ok(generated.includes(before), `Fixture template changed: ${before}`);
  generated = generated.replaceAll(before, after);
}
mkdirSync(dirname(generatedPath), { recursive: true, mode: 0o700 });
writeFileSync(generatedPath, generated, { mode: 0o600 });
process.env.G2B1_SOURCE_ROOT = sourceRoot;
process.env.G2B1_LIVE_DIR = privateDirectory;
process.env.G2B1_EVIDENCE_DIR = evidenceDirectory;
export const fixture = await import(pathToFileURL(generatedPath).href);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  writeFileSync(resolve(evidenceDirectory, 'fixture-template.json'), JSON.stringify({
    template: 'docs/build-log/guarantor-g2b1/live-fixture.mjs',
    sha256: createHash('sha256').update(template).digest('hex'), replacements,
    generatedPath: '.odos/staff-dx-gate/fixture/live-fixture.mjs',
  }, null, 2) + '\n');
  const result = spawnSync(process.execPath, [
    '--import', resolve(sourceRoot, 'mcp/node_modules/tsx/dist/loader.mjs'), generatedPath, process.argv[2],
  ], { cwd: sourceRoot, env: process.env, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
