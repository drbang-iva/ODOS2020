import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const store = 'mcp/src/clinical-graph/follow-up-profile-store.ts';
const endpoint = 'mcp/src/clinical-graph/follow-up-profile-endpoint.ts';
const ui = 'ui/src/components/settings/FollowUpProfilesSettings.tsx';
const keyTest = 'mcp/src/__tests__/follow-up-profile-keys.test.ts';
const storeTest = 'mcp/tests/followUpProfileStore.test.ts';
const endpointTest = 'mcp/tests/followUpProfileEndpoint.test.ts';
const uiTest = 'ui/tests/followUpProfilesSettings.test.tsx';
const test = (file, name) => [process.execPath, ['--import', 'tsx', '--test', `--test-name-pattern=${name}`, file]];
const replace = (from, to) => source => { assert.ok(source.includes(from), `Mutation target missing: ${from}`); return source.replace(from, to); };
const header = '"If-None-Exist": `identifier=${encodeURIComponent(`${FOLLOW_UP_PROFILE_IDENTIFIER_SYSTEM}|${profile.profileKey}`)}`';
const jobs = [
  { id: 'G1', file: store, change: replace('"key": "va"', '"key": "fictional-section"'), command: test(keyTest, '^G1') },
  { id: 'G2', file: store, change: replace('"orderable": "visual-field-threshold"', '"orderable": "fictional-orderable"'), command: test(keyTest, '^G2') },
  { id: 'G3-seed', file: store, change: replace('"profileKey": "glaucoma",', '"profileKey": "glaucoma", "mdmSuggestion": "synthetic",'), command: test(keyTest, '^G3') },
  { id: 'G3-request', file: endpoint, change: replace('const writeSchema = z.object({ profile: followUpProfileSchema, expectedVersion }).strict();', 'const writeSchema = z.object({ profile: followUpProfileSchema, expectedVersion });'), command: test(endpointTest, '^G3') },
  { id: 'G4', file: store, change: replace('byKey.get(seed.profileKey) ?? { ...structuredClone(seed), versionId: null }', '{ ...structuredClone(seed), versionId: null }'), command: test(storeTest, '^G4') },
  { id: 'G5a', file: store, change: replace('const writeVersion = expectedVersion;', 'const writeVersion = existing?.meta?.versionId ?? null;'), command: test(storeTest, '^G5a') },
  { id: 'G5b', file: store, change: replace(header, '...{}'), command: test(storeTest, '^G5b') },
  { id: 'G5c', file: store, change: replace(header, `...(mode === "save" ? {} : { ${header} })`), command: test(storeTest, '^G5c') },
  { id: 'G6', file: endpoint, change: replace('  if (!staffHasBusinessAction(staff, "finding-definitions.write")) return { status: 403, body: { error: "finding-definitions.write required." } };', ''), command: test(endpointTest, '^G6') },
  { id: 'G7', file: endpoint, change: replace('    assertProfileReferences(profile, choices);', ''), command: test(endpointTest, '^G7') },
  { id: 'server-fault', file: endpoint, change: replace('    throw error;', '    return { status: 400, body: { error: "misclassified server fault" } };'), command: test(endpointTest, '^write failures distinguish') },
  { id: 'G8-registry', file: 'data/canonical-extensions/registry.json', change: source => { const value = JSON.parse(source); value.extensions = value.extensions.filter(row => !row.url.endsWith('/odos-follow-up-profile-json')); return JSON.stringify(value, null, 2) + '\n'; }, command: ['npm', ['run', 'preflight']] },
  { id: 'G8-frontdoor', file: 'deploy/frontdoor/Caddyfile', change: replace('\thandle /follow-up-profiles* {\n\t\treverse_proxy 127.0.0.1:3333\n\t}\n', ''), command: [process.execPath, ['.claude/skills/tier0-census/scripts/check-frontdoor-coverage.mjs']] },
  { id: 'UI-save', file: ui, change: replace('expectedVersion: original?.versionId ?? null }', 'expectedVersion: null }'), command: test(uiTest, '^Settings reset') },
  { id: 'UI-picker', file: ui, change: replace('onChange([...items, structuredClone(option)])', 'onChange([...items])'), command: test(uiTest, '^Settings picker') },
  { id: 'UI-read-only', file: ui, change: replace('const disabled = !catalog?.canWrite || saving;', 'const disabled = saving;'), command: test(uiTest, '^Settings read-only') },
];
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const hash = text => createHash('sha256').update(text).digest('hex');
function run(command) {
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  const lines = (result.stdout + result.stderr).split('\n');
  const summary = lines.filter(line => /^# (tests|pass|fail|cancelled|skipped|todo) |^not ok|^! |Front-door route parity:|ODOS preflight complete:|odos-extension-url-shape|fictional-section|fictional-orderable/.test(line)).map(line => line.replaceAll(process.cwd() + '/', ''));
  return { exit: result.status, summary };
}
const results = [];
for (const job of jobs) {
  const original = readFileSync(job.file, 'utf8');
  const mutant = job.change(original); assert.notEqual(mutant, original);
  let red;
  try { writeFileSync(job.file, mutant); red = run(job.command); }
  finally { writeFileSync(job.file, original); }
  assert.equal(hash(readFileSync(job.file, 'utf8')), hash(original));
  const green = run(job.command);
  results.push({ id: job.id, file: job.file, command: [job.command[0] === process.execPath ? 'node' : job.command[0], ...job.command[1]].map(shellQuote).join(' '), originalHash: hash(original), mutantHash: hash(mutant), red, green });
  writeFileSync('docs/build-log/followup-s3a-profiles/mutations.json', JSON.stringify(results, null, 2) + '\n');
  console.log(`${job.id}: red exit ${red.exit}, restored exit ${green.exit}`);
  assert.equal(red.exit, 1, `${job.id} must fail`); assert.equal(green.exit, 0, `${job.id} must restore green`);
}
