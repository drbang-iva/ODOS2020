import assert from 'node:assert/strict';
import type { Bundle, Observation, Resource } from '@medplum/fhirtypes';
import type { ClinicalFindingDefinition } from '../../../src/clinical-graph/glaucoma-suspect.js';
import { materializeAtomicFindingCatalog } from '../../../src/clinical-graph/diagnosis-findings-endpoint.js';
import { buildFindingReadAliases } from '../../../src/clinical-graph/finding-read-aliases.js';
import { classifyFindingObservation } from '../../../src/clinical-graph/current-finding-identity.js';

export interface WriteEvidence {
  writeId: string;
  method: string;
  url: string;
  resource: Resource;
  headers?: Record<string,string>;
  transactionEntry?: number;
  reference?: string;
  before?: Resource;
  after?: Resource;
}
export interface WriteTrace { attempted: WriteEvidence[]; persisted: WriteEvidence[] }
export interface WritePathEvidence extends WriteTrace {
  id: string;
  scenarioId: string;
  handler: string;
  responseStatus: number;
  observations: Array<{writeId:string;stage:'attempted'|'persisted';reference?:string;kind:string;resource:Observation}>;
  rejection: WriteTrace & {scenarioId:string;responseStatus:number;reason:string;setup?:WriteTrace};
  setup: WriteTrace;
}
type Attempt = Omit<WriteEvidence,'writeId'>;
export function createWriteRecorder(options: {snapshot:()=>Resource[];scenarioId?:string}) {
  const attempted: WriteEvidence[]=[],persisted:WriteEvidence[]=[];
  let sequence=0;
  const recordAttempt=(value:Attempt):WriteEvidence=>{
    const row={...structuredClone(value),writeId:`${options.scenarioId??'scenario'}:${++sequence}`};attempted.push(row);return row;
  };
  async function capture<T>(rows:Attempt[],delegate:()=>Promise<T>):Promise<T>{
    const before=new Map(options.snapshot().map(r=>[`${r.resourceType}/${r.id}`,structuredClone(r)]));
    const writes=rows.map(recordAttempt);
    let response: unknown;
    try{response=await delegate();return response as T;}
    finally{
      const assigned=new Set<string>();
      for(const after of options.snapshot()){
        const reference=`${after.resourceType}/${after.id}`,prior=before.get(reference);
        if(JSON.stringify(prior)===JSON.stringify(after))continue;
        const transactionResponse=response as Bundle | undefined;
        const responseReference=(write:WriteEvidence)=>{
          if(write.transactionEntry===undefined||transactionResponse?.resourceType!=='Bundle')return undefined;
          const entry=transactionResponse.entry?.[write.transactionEntry],resource=entry?.resource;
          return resource?.id?`${resource.resourceType}/${resource.id}`:entry?.response?.location?.split('/_history/')[0];
        };
        const normalized=(resource:Resource)=>{const {id:_,meta:__,...body}=resource;return JSON.stringify(body);};
        const available=writes.filter(w=>!assigned.has(w.writeId));
        const sameType=available.filter(w=>w.resource.resourceType===after.resourceType);
        const exactBody=sameType.filter(w=>normalized(w.resource)===normalized(after));
        const write=[...available].reverse().find(w=>responseReference(w)===reference||w.url===reference||w.reference===reference)||
          (exactBody.length===1?exactBody[0]:undefined)||(sameType.length===1?sameType[0]:undefined);
        assert.ok(write,`Unattributed persisted resource ${reference}`);
        assigned.add(write.writeId);
        persisted.push({...write,resource:structuredClone(after),reference,...(prior?{before:prior}:{}),after:structuredClone(after)});
      }
    }
  }
  function wrap<T extends object>(client:T):T{
    return new Proxy(client,{get(target,property){
      const value=Reflect.get(target,property,target);
      if(typeof value!=='function')return value;
      if(!['create','createWithOutcome','update','patch','executeTransaction','executeBatch'].includes(String(property)))return value.bind(target);
      return async (...args:any[])=>{
        let rows:Attempt[];
        if(property==='executeTransaction'||property==='executeBatch')rows=((args[0] as Bundle).entry??[]).flatMap((entry,index)=>{
          if(!entry.resource||!entry.request||['GET','HEAD'].includes(entry.request.method))return [];
          return [{method:entry.request.method,url:entry.request.url!,resource:entry.resource,transactionEntry:index,
            headers:{...(entry.request.ifMatch?{'If-Match':entry.request.ifMatch}:{}),...(entry.request.ifNoneExist?{'If-None-Exist':entry.request.ifNoneExist}:{})}}];
        });
        else if(property==='update')rows=[{method:'PUT',url:`${args[0]}/${args[1]}`,resource:args[2],headers:args[3]}];
        else if(property==='patch')rows=[{method:'PATCH',url:`${args[0]}/${args[1]}`,resource:{resourceType:'Binary',contentType:'application/json-patch+json',data:Buffer.from(JSON.stringify(args[2])).toString('base64')},headers:args[3]}];
        else rows=[{method:'POST',url:args[0].resourceType,resource:args[0],headers:args[1]}];
        return capture(rows,()=>value.apply(target,args));
      };
    }});
  }
  const mark=()=>({attempted:attempted.length,persisted:persisted.length});
  const since=(start:ReturnType<typeof mark>):WriteTrace=>structuredClone({attempted:attempted.slice(start.attempted),persisted:persisted.slice(start.persisted)});
  return {wrap,capture,recordAttempt,mark,since,attempted,persisted};
}

export function classifyWriteTrace(trace:WriteTrace,definitions:readonly ClinicalFindingDefinition[],id:string):WritePathEvidence['observations']{
  const catalog=materializeAtomicFindingCatalog(definitions),aliases=buildFindingReadAliases(definitions,catalog);
  return (['attempted','persisted'] as const).flatMap(stage=>trace[stage].flatMap(write=>{
    if(write.resource.resourceType!=='Observation')return [];
    const classification=classifyFindingObservation(write.resource,definitions,catalog,aliases);
    assert.ok(!classification.kind.startsWith('legacy-')&&!['unresolved-legacy','invalid'].includes(classification.kind),`${id}: ${stage} ${write.writeId} ${write.reference??write.url} classified ${classification.kind}`);
    return [{writeId:write.writeId,stage,reference:write.reference,kind:classification.kind,resource:write.resource}];
  }));
}
