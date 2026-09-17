import assert from 'node:assert/strict';
import type { Observation, Resource } from '@medplum/fhirtypes';
import { FhirFindingDefinitionStore } from '../../../src/clinical-graph/finding-definition-store.js';
import { protocolFixture, protocolRollbackFixture, findingItem } from './protocol-harness.js';
import { canonicalFact } from './writer-harness.js';
import { lens } from './factories.js';
import { createWriteRecorder, classifyWriteTrace, type WriteEvidence, type WriteTrace, type WritePathEvidence } from './write-path-recorder.js';

type Fixture = Awaited<ReturnType<typeof protocolFixture>>;
type Recorder = ReturnType<typeof createWriteRecorder>;
interface InvocationEvidence extends WriteTrace {
  responseStatus: number;
  handlerOutcome: 'returned' | 'threw-after-compensation';
  reason?: string;
}
export interface ProtocolWritePathEvidence extends WritePathEvidence {
  invocation: InvocationEvidence;
  phase: 'whole-invocation' | 'fault-triggered-restore';
  rejectionScope?: 'phase-only';
  rejectionInvocation?: InvocationEvidence;
  rejectionSetup?: WriteTrace;
  wholeRequestRejection?: WritePathEvidence['rejection'];
  fixtureStateChange?: { resource: Resource; reason: string };
}
const emptyTrace = (): WriteTrace => ({attempted:[],persisted:[]});
function instrument(c: Fixture, scenarioId: string): Recorder {
  const recorder=createWriteRecorder({scenarioId,snapshot:()=>[...c.resources.values()]});
  const original=c.deps.authenticate;
  const fhir=recorder.wrap(c.fhir);
  c.deps.authenticate=async()=>({...await original(),fhir});
  return recorder;
}
const trace = (recorder:Recorder):WriteTrace => recorder.since({attempted:0,persisted:0});
const snapshot = (c:Fixture) => [...c.resources].sort(([a],[b])=>a.localeCompare(b));
function observations(rows:WriteEvidence[]):Observation[] {return rows.flatMap(row=>row.resource.resourceType==='Observation'?[row.resource]:[]);}
function assertUnrelated(trace:WriteTrace,definitions:Awaited<ReturnType<FhirFindingDefinitionStore['list']>>,id:string) {
  const classified=classifyWriteTrace(trace,definitions,id);
  assert.ok(classified.length,`${id}: real Observation write was not reached`);
  assert.ok(classified.every(row=>row.kind==='unrelated'),`${id}: protocol must never emit a shared Observation`);
  assert.ok([...trace.attempted,...trace.persisted].every(row=>row.resource.resourceType!=='Binary'),`${id}: unexpected Binary patch`);
  return classified;
}
async function closedUnapplyRejection():Promise<WritePathEvidence['rejection']> {
  const c=await protocolFixture([findingItem('cup_disc_ratio',.5)]);
  const recorder=instrument(c,'protocol-unapply-closed');
  const applied=await c.apply();assert.equal(applied.status,200);
  c.close();const before=structuredClone(snapshot(c)),start=recorder.mark();
  const result=await c.unapply((applied.body as any).application.id),writes=recorder.since(start);
  assert.equal(result.status,409);assert.equal((result.body as any).error,'encounter-closed');
  assert.deepEqual(writes,emptyTrace());assert.deepEqual(snapshot(c),before);
  return {...writes,scenarioId:'protocol-unapply-closed',responseStatus:result.status,reason:(result.body as any).error};
}
async function sharedRejection(path:'commit'|'unapply'):Promise<WritePathEvidence['rejection']> {
  const c=await protocolFixture([findingItem(path==='commit'?lens.stableKey:'cup_disc_ratio',path==='commit'?'abnormal':.5)]);
  const recorder=instrument(c,`protocol-${path}-shared-reject`);
  let applicationId='';
  if(path==='unapply') {
    const applied=await c.apply();assert.equal(applied.status,200);applicationId=(applied.body as any).application.id;
    const finding=(await c.service.findings.list())[0];const shared=c.save(canonicalFact('shared-refusal'));
    await c.service.findings.save({...finding,observationReference:`Observation/${shared.id}`});
  }
  const before=structuredClone(snapshot(c)),start=recorder.mark();
  const result=path==='commit'?await c.apply():await c.unapply(applicationId),writes=recorder.since(start);
  assert.equal(result.status,422);assert.equal((result.body as any).error,'shared-finding-charted-in-ocular-health');
  assert.deepEqual(writes,emptyTrace());assert.deepEqual(snapshot(c),before);
  return {...writes,scenarioId:`protocol-${path}-shared-reject`,responseStatus:result.status,reason:(result.body as any).error};
}
async function commitAndUnapply():Promise<ProtocolWritePathEvidence[]> {
  const c=await protocolFixture([findingItem('cup_disc_ratio',.5)]),recorder=instrument(c,'protocol-apply-unapply');
  const definitions=await new FhirFindingDefinitionStore(c.fhir).list();
  const applied=await c.apply();assert.equal(applied.status,200,JSON.stringify(applied.body));
  const committed=trace(recorder),commitObservations=assertUnrelated(committed,definitions,'protocol-commit');
  assert.equal(observations(committed.attempted).length,1);assert.equal(observations(committed.persisted).length,1);
  const original=observations(committed.persisted)[0];assert.equal(original.status,'final');assert.ok(original.id);
  const commit:ProtocolWritePathEvidence={id:'protocol-commit',scenarioId:'protocol-apply-unapply',handler:'handleProtocolApplyRequest',responseStatus:applied.status,
    ...committed,observations:commitObservations,setup:emptyTrace(),rejection:await sharedRejection('commit'),phase:'whole-invocation',
    invocation:{...committed,responseStatus:applied.status,handlerOutcome:'returned'}};
  const start=recorder.mark();const unapplied=await c.unapply((applied.body as any).application.id),removed=recorder.since(start);
  assert.equal(unapplied.status,200,JSON.stringify(unapplied.body));
  const removalObservations=assertUnrelated(removed,definitions,'protocol-unapply');
  assert.equal(observations(removed.attempted).length,1);assert.equal(observations(removed.persisted).length,1);
  const owner=c.resources.get(`Observation/${original.id}`) as Observation;
  assert.equal(owner.status,'entered-in-error');assert.deepEqual(owner.valueQuantity,original.valueQuantity);
  assert.deepEqual(owner.identifier,original.identifier);assert.deepEqual(owner.component,original.component);
  const unapply:ProtocolWritePathEvidence={id:'protocol-unapply',scenarioId:'protocol-apply-unapply',handler:'handleProtocolUnapplyRequest',responseStatus:unapplied.status,
    ...removed,observations:removalObservations,setup:committed,rejection:await closedUnapplyRejection(),wholeRequestRejection:await sharedRejection('unapply'),phase:'whole-invocation',
    invocation:{...removed,responseStatus:unapplied.status,handlerOutcome:'returned'}};
  return [commit,unapply];
}
function restorePhase(all:WriteTrace,reference:string,status:Observation['status']):WriteTrace {
  const phase=(rows:WriteEvidence[])=>rows.filter(row=>row.resource.resourceType==='Observation' &&
    (row.reference===reference||row.url===reference) && row.resource.status===status);
  return {attempted:phase(all.attempted),persisted:phase(all.persisted)};
}
function withoutPhase(all:WriteTrace,phase:WriteTrace):WriteTrace {
  return {attempted:all.attempted.filter(row=>!phase.attempted.some(own=>own.writeId===row.writeId)),
    persisted:all.persisted.filter(row=>!phase.persisted.some(own=>own.writeId===row.writeId))};
}
async function restore():Promise<ProtocolWritePathEvidence> {
  let recorder!:Recorder;
  const c=await protocolRollbackFixture('restore',fixture=>{recorder=instrument(fixture,'protocol-restore-compensation');});
  const definitions=await new FhirFindingDefinitionStore(c.fhir).list();
  const setup=trace(recorder),start=recorder.mark();let failure:unknown;
  try {await c.run();} catch(error){failure=error;}
  assert.match(String(failure),/synthetic finding-state failure after Observation removal/);
  const invocation=recorder.since(start),reference=`Observation/${c.original.id}`;
  assert.equal(c.original.resourceType,'Observation');
  const phase=restorePhase(invocation,reference,(c.original as Observation).status);
  assert.equal(phase.attempted.length,1,'protocol-restore: actual compensation PUT not reached');
  assert.equal(phase.persisted.length,1);assert.ok(phase.attempted[0].headers?.['If-Match']);
  assert.deepEqual({...c.resources.get(reference),meta:undefined},{...c.original,meta:undefined});
  const classified=assertUnrelated(phase,definitions,'protocol-restore');
  classifyWriteTrace(invocation,definitions,'protocol-restore/invocation');classifyWriteTrace(setup,definitions,'protocol-restore/setup');
  let rejectedRecorder!:Recorder;
  const rejected=await protocolRollbackFixture('restore',fixture=>{rejectedRecorder=instrument(fixture,'protocol-restore-late-close');});
  const rejectedSetup=trace(rejectedRecorder),rejectStart=rejectedRecorder.mark();
  const injectedFailure=rejected.hooks.beforeWrite;let closeOnRead=false;let fixtureStateChange:ProtocolWritePathEvidence['fixtureStateChange'];
  rejected.hooks.beforeWrite=async write=>{try {await injectedFailure?.(write);} catch(error){closeOnRead=true;throw error;}};
  const originalRead=rejected.hooks.beforeRead;
  rejected.hooks.beforeRead=(type,id)=>{originalRead?.(type,id);if(closeOnRead&&type==='Encounter'&&id==='e1'){
    closeOnRead=false;rejected.close();fixtureStateChange={resource:structuredClone(rejected.resources.get('Encounter/e1')!),reason:'External close injected after failed finding-state write and before restore guard read'};
  }};
  const result=await rejected.run(),rejectedInvocation=rejectedRecorder.since(rejectStart);
  assert.equal(result.status,409);assert.equal((result.body as any).error,'encounter-closed');assert.ok(fixtureStateChange);
  const refusedRestore=restorePhase(rejectedInvocation,`Observation/${rejected.original.id}`,(rejected.original as Observation).status);
  assert.deepEqual(refusedRestore,emptyTrace());assert.equal(observations(rejectedInvocation.attempted).length,1);
  assert.equal((rejected.resources.get(`Observation/${rejected.original.id}`) as Observation).status,'entered-in-error');
  classifyWriteTrace(rejectedInvocation,definitions,'protocol-restore/rejected-invocation');
  const rest=withoutPhase(invocation,phase);
  return {id:'protocol-restore',scenarioId:'protocol-restore-compensation',handler:'handleProtocolUnapplyRequest',responseStatus:500,
    ...phase,observations:classified,setup:{attempted:[...setup.attempted,...rest.attempted],persisted:[...setup.persisted,...rest.persisted]},
    phase:'fault-triggered-restore',rejectionScope:'phase-only',invocation:{...invocation,responseStatus:500,handlerOutcome:'threw-after-compensation',reason:String(failure)},
    rejection:{...refusedRestore,scenarioId:'protocol-restore-late-close',responseStatus:result.status,reason:'encounter-closed; zero restore writes, preceding unapply and Basic compensation retained separately'},
    rejectionInvocation:{...rejectedInvocation,responseStatus:result.status,handlerOutcome:'returned',reason:(result.body as any).error},
    rejectionSetup:{attempted:[...rejectedSetup.attempted,...rejectedInvocation.attempted],persisted:[...rejectedSetup.persisted,...rejectedInvocation.persisted]},
    wholeRequestRejection:await sharedRejection('unapply'),fixtureStateChange};
}
export async function runProtocolWritePaths():Promise<ProtocolWritePathEvidence[]> {
  return [...await commitAndUnapply(),await restore()];
}
