import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(root, 'docs/evidence/r10-a2a/guards');
const privateDir = resolve(root, '.odos/r10-a2a');
mkdirSync(output, { recursive: true });
mkdirSync(privateDir, { recursive: true });
const reader = 'mcp/src/clinical-graph/current-finding-reader.ts';
const writer = 'mcp/src/clinical-graph/current-finding-writer.ts';
const identity = 'mcp/src/clinical-graph/current-finding-identity.ts';
const clean = text => text.replaceAll(root, '<repo-root>').replaceAll(homedir(), '<local-home>').split('\n').map(line=>line.trimEnd()).join('\n').trimEnd() + '\n';
const replace = (text, before, after) => {
  assert.equal(text.split(before).length - 1, 1, `Mutation anchor must be unique: ${before}`);
  return text.replace(before, after);
};
const unit = pattern => ({ cwd: resolve(root, 'mcp'), args: ['--import', 'tsx', '--test', `--test-name-pattern=${pattern}`, 'tests/currentFindingWriter.test.ts'] });
const live = name => ({ cwd: root, args: ['--import', 'tsx', 'mcp/scripts/r10-a2a-preflight.mjs', 'writer', name], live: name });
const guards = {
  W1: { file: writer, mutate: text => replace(text, ',"If-Match":etag(prior!.meta!.versionId!)', ''), run: live('W1') },
  W2: { file: writer, mutate: text => replace(text, '"If-None-Exist":`identifier=${currentFindingIdentifier(target.key).system}|${ownerId}`', '...{}'), run: live('W2') },
  W5: { file: writer, mutate: text => replace(text, '  const next=buildFact(target,components,operation,prior);', `  if (baseline.kind==="legacy" && baseline.mode==="materialize") {
    for (const sibling of projection.currentFacts.filter(f=>f.projectionKey!==id && f.contributors.some(c=>c.reference===baseline.sourceReference))) {
      const other={...target,key:sibling.key,state:{status:sibling.status,presence:sibling.presence,qualifiers:sibling.qualifiers,homes:sibling.homes}};
      const identifier=currentFindingIdentifier(sibling.key);
      await deps.fhir.createWithOutcome(buildFact(other,qualifierComponents(sibling.key,sibling.qualifiers),{...operation,target:sibling.projectionKey}),
        {"If-None-Exist":\`identifier=\${identifier.system}|\${identifier.value}\`});
    }
  }
  const next=buildFact(target,components,operation,prior);`), run: unit('W5') },
  W6: { file: writer, mutate: text => replace(text, '  if (!validFactBaseline(target.baseline,target.key))', `  if (target.baseline.kind==="legacy") target={...target,baseline:{...target.baseline,key:target.baseline.key??target.key,mode:target.baseline.mode??"materialize"}};
  if (!validFactBaseline(target.baseline,target.key))`), run: unit('W6') },
  W11: { file: writer, mutate: text => replace(text, '...qualifiers,{code:odosConcept("R10_CURRENT_META"),valueString:JSON.stringify(key)},\n      {code:odosConcept("R10_OPERATION"),valueString:JSON.stringify(operation)}]',
    '...qualifiers,{code:odosConcept("R10_CURRENT_META"),valueString:JSON.stringify({...key,operation})}]'), run: unit('W11') },
  W13: { file: writer, mutate: text => replace(text, 'if (recordFactDigest(owner,definition,row)!==digest)', 'if (false)'), run: live('W13') },
  W14: { file: writer, mutate: text => replace(text, '} catch { return {status:"unconfirmed",target:id,reference:prior?.id?', '} catch { return {status:"applied",target:id,reference:prior?.id?'), run: unit('W14') },
  W15: { file: writer, mutate: text => replace(text, '  const next=buildFact(target,components,operation,prior);', `  if (baseline.kind==="legacy" && !target.state.homes.length) {
    for (const condition of state.conditions.filter(c=>c.evidence?.some(e=>e.detail?.some(d=>d.reference===baseline.sourceReference)))) {
      await deps.fhir.update("Condition",condition.id!,{...condition,evidence:condition.evidence?.map(e=>({...e,detail:e.detail?.filter(d=>d.reference!==baseline.sourceReference)}))},
        {"If-Match":etag(condition.meta!.versionId!)});
    }
  }
  const next=buildFact(target,components,operation,prior);`), run: unit('W15') },
  W16: { file: reader, mutate: text => {
    const start = text.indexOf('  const suppressedPanels = new Set<string>();');
    const end = text.indexOf('  const selected = new Map<string, Assertion[]>();', start);
    assert.ok(start > 0 && end > start);
    return text.slice(0, start) + '  const suppressedPanels = new Set<string>();\n' + text.slice(end);
  }, run: { cwd: resolve(root, 'mcp'), args: ['--import', 'tsx', '--test', '--test-name-pattern=W16|negative act remains|panel context|E1–E17', 'tests/currentFindingReader.test.ts', 'tests/r10-parity.test.ts'] } },
  W18: { file: reader, mutate: text => replace(text, '...(assertions[0].canonical ? [] : conditions).flatMap', '...conditions.flatMap'),
    run: { cwd: resolve(root, 'mcp'), args: ['--import', 'tsx', '--test', '--test-name-pattern=canonical homes', 'tests/currentFindingReader.test.ts'] } },
  W19: { file: writer, mutate: text => replace(text, 'return {...WRITE_HEADERS,"If-None-Exist":`_tag=${FINDING_OPERATION_AUDIT_SYSTEM}|${key}`};', 'return {...WRITE_HEADERS};'), run: live('W19') },
  W20: { file: writer, mutate: text => replace(text, 'async function repairPrior(deps:FindingCommandDeps,observation:Observation):Promise<boolean> {',
    'async function repairPrior(deps:FindingCommandDeps,observation:Observation):Promise<boolean> {\n  return true;'), run: live('W20') },
  W21: { file: writer, mutate: text => replace(text, 'if (target.kind==="reassert") return executeReassert(deps,command,target,state);',
    'if (target.kind==="reassert") return {status:"unchanged",target:id};'), run: unit('W21') },
  W22: { file: writer, mutate: text => replace(text, 'Number(a.target.kind==="legacy-retire")-Number(b.target.kind==="legacy-retire")',
    'Number(b.target.kind==="legacy-retire")-Number(a.target.kind==="legacy-retire")'), run: unit('W22') },
  W23: { file: writer, mutate: text => replace(text, '      if (!result.created) {', '      if (!result.created) {\n        return {status:"applied",target:id,reference:`Observation/${saved.id}`,versionId:saved.meta?.versionId};'), run: live('W23') },
  W24: { file: writer, mutate: text => replace(text, '  let stop = false;', `  if (state.observations.some(o=>parseFindingOperation(o)?.commandId===command.commandId)) {
    for (const target of command.targets) if (target.kind!=="legacy-retire" && target.baseline?.kind==="canonical") {
      const baseline=target.baseline;
      const now=state.observations.find(o=>\`Observation/\${o.id}\`===baseline.reference);
      if (now?.meta?.versionId) baseline.versionId=now.meta.versionId;
    }
  }
  let stop = false;`), run: unit('W24') },
  W25: { file: identity, mutate: text => replace(text, '.update(`${commandId}|${target}|${kind}|${digest}`)', '.update(`${commandId}|${target}|${kind}`)'), run: unit('W25') },
};

for (const name of process.argv.slice(2)) {
  const guard = guards[name]; assert.ok(guard, `Unknown guard ${name}`);
  const path = resolve(root, guard.file); const original = readFileSync(path, 'utf8');
  const backup = resolve(privateDir, `${name}-original.txt`); writeFileSync(backup, original);
  let red; let green;
  try {
    writeFileSync(path, guard.mutate(original));
    const diff = spawnSync('diff', ['-U0', backup, path], { encoding: 'utf8' });
    writeFileSync(resolve(output, `${name}-mutant.diff`), clean(diff.stdout));
    red = run('red');
    assert.ok(Number.isInteger(red.exit) && red.exit !== 0, `${name} mutation check did not complete with a failing exit`);
  } finally { writeFileSync(path, original); }
  green = run('green'); assert.equal(green.exit, 0, `${name} restored check failed`);
  const result = { guard: name, changedFile: guard.file, red, green };
  writeFileSync(resolve(output, `${name}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));

  function run(phase) {
    const p = spawnSync(process.execPath, guard.run.args, { cwd: guard.run.cwd, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, timeout: 90000 });
    const text = clean(p.stdout + p.stderr);
    writeFileSync(resolve(output, `${name}-${phase}.txt`), text);
    if (guard.run.live) for (const kind of ['results', 'http']) copyFileSync(resolve(root, `docs/evidence/r10-a2a/writer-${kind}-${guard.run.live}.json`), resolve(output, `${name}-${phase}-${kind}.json`));
    return { exit: p.status, command: `node ${guard.run.args.join(' ')}`, summary: text.split('\n').filter(line => /^# (tests|pass|fail|skipped|cancelled|todo)/.test(line)), ...(p.error ? { error: p.error.message } : {}) };
  }
}
