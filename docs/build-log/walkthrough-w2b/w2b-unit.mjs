import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

mkdirSync('.odos', { recursive: true });
const prefix = 'odos-w2b-unit-' + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex');
const saved = [];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MEDPLUM_|ODOS_|GITHUB_ENV)/.test(k)));
function run(label, project, files = []) {
  const result = spawnSync('npm', ['--prefix', project, 'test', ...(files.length ? ['--', ...files] : [])], { env, encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });
  writeFileSync('.odos/' + label + '.log', result.stdout + result.stderr, { mode: 0o600 });
  const summary = (result.stdout + result.stderr).split('\n').filter(line => /^(# (tests|suites|pass|fail|cancelled|skipped|todo)|not ok )/.test(line));
  return { status: result.status, stdout: label + ': exit=' + result.status + '\n' + summary.join('\n') + '\n' };
}
try {
  for (const name of ['operator.env', 'operator-identity.json']) if (existsSync('.odos/' + name)) {
    renameSync('.odos/' + name, '.odos/' + prefix + '-' + name); saved.push(name);
  }
  console.log('Unit suites: operator.env and operator-identity.json absent or moved aside.');
  const started = spawnSync('docker', ['run', '-d', '--name', prefix, '-e', 'POSTGRES_DB=medplum', '-e', 'POSTGRES_USER=medplum', '-e', 'POSTGRES_PASSWORD=' + password, '-p', '127.0.0.1::5432', 'postgres:16-alpine'], { encoding: 'utf8' });
  assert.equal(started.status, 0, 'dedicated Postgres startup');
  const port = spawnSync('docker', ['port', prefix, '5432/tcp'], { encoding: 'utf8' }).stdout.trim().split(':').at(-1);
  env.ODOS_POSTGRES_URL = `postgresql://medplum:${password}@127.0.0.1:${port}/medplum`;
  let healthy = false;
  for (let i = 0; i < 90; i++) {
    healthy = spawnSync('docker', ['exec', prefix, 'pg_isready', '-U', 'medplum', '-d', 'medplum'], { stdio: 'ignore' }).status === 0;
    if (healthy) break;
    await delay(2000);
  }
  assert.ok(healthy);
const endpoint='mcp/src/clinical-graph/protocol-endpoint.ts';
const classifier='mcp/src/clinical-graph/diagnosis-billing-class.ts';
const ledger='data/code-bindings/refractive-billing-class-ledger.json';
const cases=[
['g1',endpoint,s=>s.replace('const selected = medical ?? refractive ?? fallback;','const selected = classified.find((diagnosis) => diagnosis.rank === 1);'),'W2b G1'],
['g2',endpoint,s=>s.replace('family === "eye-code" || family === "em"','family === "eye-code"'),'W2b G2'],
['g3',endpoint,s=>s.replace('medical ?? refractive ?? fallback','medical ?? fallback'),'W2b G3'],
['g4a',endpoint,s=>s.replace('const selected = medical ?? refractive ?? fallback;','const selected = family === "vision-plan" ? classified.find((diagnosis) => diagnosis.rank === 1) : medical ?? refractive ?? fallback;'),'W2b G4a'],
['g4b',endpoint,s=>s.replace('const selected = medical ?? refractive ?? fallback;','const selected = medical ?? refractive ?? fallback ?? classified.find((diagnosis) => diagnosis.billingClass === "medical");'),'W2b G4b'],
['g5-astigmatism',classifier,s=>s.replace('refractiveCodes.has(icd10Code)','(refractiveCodes.has(icd10Code) || icd10Code.startsWith("H52.2"))'),'W2b G5 irregular'],
['g5-aniseikonia',classifier,s=>s.replace('refractiveCodes.has(icd10Code)','(refractiveCodes.has(icd10Code) || icd10Code.startsWith("H52.3"))'),'W2b G5 irregular'],
['g6',ledger,s=>{const l=JSON.parse(s);l.diagnosisCodes=l.diagnosisCodes.filter(x=>x.code!=='H52.4');return JSON.stringify(l);},'W2b G3 G6'],
['g7',endpoint,s=>s.replace('= "unclassified";', '= "medical";'),'W2b G7'],
];
const results=[];
for(const [label,file,mutate,expected] of cases){
 const original=readFileSync(file,'utf8');const mutant=mutate(original);assert.notEqual(mutant,original);
 try{
  writeFileSync(file,mutant);
  const red=run(label+'-red', 'mcp', ['src/__tests__/walkthrough-w2b.test.ts']);
  console.log(red.stdout);assert.equal(red.status,1);assert.ok(red.stdout.split('\n').some(x=>x.startsWith('not ok ')&&x.includes(expected)));
  results.push(red.stdout);
 }finally{writeFileSync(file,original);}
 const green=run(label+'-green', 'mcp', ['src/__tests__/walkthrough-w2b.test.ts']);
 console.log(green.stdout);assert.equal(green.status,0);results.push(green.stdout);
}

const seeds = 'mcp/src/clinical-graph/diagnosis-catalog-seeds.ts';
const originalSeeds = readFileSync(seeds, 'utf8');
const lines = originalSeeds.split('\n');
const kcs = lines.findIndex(line => line.includes('familySeed("kcs_not_sjogren"'));
const dry = lines.findIndex(line => line.includes('familySeed("dry_eye_syndrome"'));
assert.ok(kcs > 0 && dry > kcs);
[lines[kcs], lines[dry]] = [lines[dry], lines[kcs]];
try {
  writeFileSync(seeds, lines.join('\n'));
  const red = run('g8-red', 'ui');
  console.log(red.stdout); results.push(red.stdout);
  assert.equal(red.status, 1);
  const failures = red.stdout.split('\n').filter(line => line.startsWith('not ok '));
  assert.equal(failures.length, 2);
  assert.ok(failures.every(line => line.includes('W2b G8')));
} finally { writeFileSync(seeds, originalSeeds); }
const green = run('g8-green', 'ui');
console.log(green.stdout); results.push(green.stdout); assert.equal(green.status, 0);
const related = run('related-final', 'mcp', ['src/__tests__/walkthrough-w2b.test.ts', 'src/__tests__/visit-billing-codes.test.ts', 'src/__tests__/procedure-charges.test.ts', 'tests/feeInterpretation.test.ts']);
console.log(related.stdout); results.push(related.stdout); assert.equal(related.status, 0);
const full = spawnSync('bash', ['-c', 'shopt -s globstar; node --import tsx --test --test-concurrency=1 src/__tests__/**/*.test.ts tests/**/*.test.ts ../tests/boundaries/**/*.test.ts ../tests/observation-status-machine/**/*.test.ts ../tests/setup-wizard/**/*.test.ts ../tests/preflight/**/*.test.ts ../tests/smart/**/*.test.ts ../tests/cds/**/*.test.ts ../tests/agentops/**/*.test.ts ../tests/bulk-data/**/*.test.ts ../tests/mandate-8/**/*.test.ts'], { cwd: 'mcp', env, encoding: 'utf8', maxBuffer: 60 * 1024 * 1024 });
writeFileSync('.odos/w2b-full-mcp.log', full.stdout + full.stderr, { mode: 0o600 });
const fullSummary = 'full-mcp-ci-unit: exit=' + full.status + '\n' + (full.stdout + full.stderr).split('\n').filter(line => /^(# (tests|suites|pass|fail|cancelled|skipped|todo)|not ok )/.test(line)).join('\n');
console.log(fullSummary); results.push(fullSummary);
writeFileSync('.odos/w2b-mutation-summaries.txt', results.join('\n'));
assert.equal(full.status, 0);

} finally {
  const removed = spawnSync('docker', ['rm', '-f', prefix], { encoding: 'utf8' });
  console.log('dedicated Postgres cleanup: exit=' + removed.status);
  for (const name of saved) renameSync('.odos/' + prefix + '-' + name, '.odos/' + name);
  console.log(spawnSync('docker', ['ps', '--format', 'table {{.Names}}\t{{.Status}}'], { encoding: 'utf8' }).stdout.trim());
}
