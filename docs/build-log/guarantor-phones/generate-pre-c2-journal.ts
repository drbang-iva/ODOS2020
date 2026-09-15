import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { world, input, run, journal, wire } from '../../../mcp/tests/helpers/guarantor-phone-fixture.js';
const path = process.argv[2];
assert.ok(path, 'Pass a clean detached checkout of the exact pre-C2 revision');
const head = execFileSync('git', ['rev-parse','HEAD'], { cwd: path, encoding: 'utf8' }).trim();
assert.equal(head, '02cdf89e0b964cb442bd42287c86435102fcccc9');
execFileSync('git', ['diff', '--exit-code', head, '--', 'mcp/src', 'src'], { cwd: path });
const engine = await import(`${path}/mcp/src/clinic/guarantor-link-operation.ts`);
const f = await world(false, false); let lost = 0;
for (const [key, resource] of f.data) { const { address, birthDate, ...rest } = resource as any; f.data.set(key, wire(rest)); }
f.afterWrite = async (w: any) => { if (!lost && w.actor.actionReason === 'guarantor.link projecting RelatedPerson/r1' && w.status === 200) { lost++; throw new Error('Exact pre-C2 committed reply lost'); } };
const result: any = await run(f,'create',input(f),undefined,engine);
assert.equal(lost,1);
assert.equal(journal(f,result.body.task.id).find(i => !i.disposition).phase,'projecting');
writeFileSync('mcp/tests/fixtures/guarantor-pre-c2-journal.json', JSON.stringify(wire({ head, taskId: result.body.task.id, resources: [...f.data.values()] }), null, 2)+'\n');
console.log(JSON.stringify({head,lost,status:result.status,phase:result.body.phase,taskId:result.body.task.id}));
