import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCaddyParity } from './caddy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = join(root, '.odos/r10-a3-2-served');
const manifest = JSON.parse(readFileSync(join(runtime, 'manifest.json'), 'utf8'));
const sourceRoot = process.argv[3] ? resolve(process.argv[3]) : root;
const generatedPath = process.argv[2] ? resolve(process.argv[2]) : join(runtime, 'Caddyfile');
assertCaddyParity(readFileSync(join(sourceRoot, 'deploy/frontdoor/Caddyfile'), 'utf8'), readFileSync(generatedPath, 'utf8'), manifest.ports);
console.log(`Caddy parity PASS: ${generatedPath}; only bind and upstream ports differ.`);
