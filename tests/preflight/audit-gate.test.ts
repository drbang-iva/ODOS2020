import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const gate = new URL('../../scripts/audit-dependencies.mjs', import.meta.url);
const ghsa = 'GHSA-rgj7-g3m4-5g8c';
const clean = { auditReportVersion: 2, vulnerabilities: {} };
function finding(severity = 'high') {
  return { auditReportVersion: 2, vulnerabilities: { sharp: { severity, via: [{ name: 'sharp', severity, url: `https://github.com/advisories/${ghsa}` }] } } };
}
const entry = { ghsa, package: 'sharp', reason: 'Synthetic guard fixture only', reviewBy: '2099-12-31' };
function run(rootReport: unknown, mcpReport: unknown, allowlist: unknown = [], status = 0) {
  const root = mkdtempSync(join(tmpdir(), 'odos-audit-test-'));
  try {
    for (const dir of ['scripts', 'security', 'mcp', 'bin']) mkdirSync(join(root, dir));
    let source: string;
    try { source = readFileSync(gate, 'utf8'); } catch { assert.fail('Audit gate implementation is missing'); }
    writeFileSync(join(root, 'scripts/audit-dependencies.mjs'), source);
    writeFileSync(join(root, 'security/audit-allowlist.json'), JSON.stringify(allowlist));
    writeFileSync(join(root, 'report.json'), JSON.stringify(rootReport));
    writeFileSync(join(root, 'mcp/report.json'), JSON.stringify(mcpReport));
    writeFileSync(join(root, 'bin/npm'), `#!/usr/bin/env node\nconst fs=require('node:fs'); if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['audit','--audit-level=high','--omit=dev','--json']))process.exit(9); process.stdout.write(fs.readFileSync('report.json'));process.exit(${status});\n`, { mode: 0o755 });
    return spawnSync(process.execPath, [join(root, 'scripts/audit-dependencies.mjs')], { encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('audit gate accepts two clean manifests', () => { assert.equal(run(clean, clean).status, 0); });
test('D1 high runtime advisory blocks and names its GHSA', () => { const r=run(clean,finding(),[],1);assert.equal(r.status,1);assert.match(r.stdout,new RegExp(ghsa)); });
test('D2 moderate is reported without blocking', () => { const r=run(finding('moderate'),clean);assert.equal(r.status,0);assert.match(r.stdout,/moderate/);assert.match(r.stdout,new RegExp(ghsa)); });
test('D3 accepted high advisory passes; deleting its entry blocks', () => { assert.equal(run(clean,finding(),[entry],1).status,0);assert.equal(run(clean,finding(),[],1).status,1); });
test('D4 expired entry fails even when the audit is clean', () => { const r=run(clean,clean,[{...entry,reviewBy:'2000-01-01'}]);assert.equal(r.status,1);assert.match(r.stderr,/expired/); });
test('D5 neither root nor mcp can be omitted', () => { for(const reports of [[finding(),clean],[clean,finding()]]){const r=run(...reports as [unknown,unknown]);assert.equal(r.status,1);assert.match(r.stdout,new RegExp(ghsa));} });
test('allowlist matches both advisory and package', () => { assert.equal(run(clean,finding(),[{...entry,package:'other'}],1).status,1); });
test('invalid allowlist fields and dates fail closed', () => { for(const e of [{...entry,reason:''},{...entry,reviewBy:'2099-02-30'},{...entry,ghsa:'invalid'}])assert.equal(run(clean,clean,[e]).status,1); });
test('audit operational errors fail closed', () => { const r=run({error:{code:'E503'}},clean,[],1);assert.equal(r.status,1);assert.match(r.stderr,/audit/i); });
test('unexpected npm exit cannot masquerade as clean audit', () => { assert.equal(run(clean,clean,[],9).status,1); });
test('critical blocks and an exception cannot suppress another advisory', () => {
  assert.equal(run(clean, finding('critical')).status, 1);
  const report = finding();
  report.vulnerabilities.sharp.via.push({ name: 'sharp', severity: 'high', url: 'https://github.com/advisories/GHSA-2883-xcg3-v3hh' });
  assert.equal(run(clean, report, [entry], 1).status, 1);
});
test('a vulnerability without advisory provenance fails closed', () => {
  const report = finding(); report.vulnerabilities.sharp.via = [];
  assert.equal(run(clean, report, [], 1).status, 1);
});
