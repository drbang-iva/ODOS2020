import type { CustomFindingDefinition } from '../../src/components/charting/CustomFindingSection';

const adapters = new WeakMap<typeof fetch, typeof fetch>();

// Test row specifications are expanded into the canonical facts/panel wire contract explicitly.
// The production editor never reads these specifications as current snapshot observations.
export function canonicalOcularFixture(source: typeof fetch, definitions: CustomFindingDefinition[]): typeof fetch {
  const existing = adapters.get(source);
  if (existing) return existing;
  const saved = new Map<string, any>();
  const adapter: typeof fetch = async (input, init) => {
    const response = await source(input, init);
    if (!response.ok) return response;
    const body = await response.json();
    const url = new URL(String(input), 'http://test');
    const stableKey = decodeURIComponent(url.pathname.match(/\/custom\/([^/]+)/)?.[1] ?? '');
    const definition = definitions.find(d => d.stableKey === stableKey);
    if (!definition) return Response.json(body, {status: response.status});
    if (init?.method === 'POST') {
      if (body.result) return Response.json(body, {status: response.status});
      const request = JSON.parse(String(init.body));
      const current = saved.get(stableKey) ?? canonicalEyes(definition, [], request.patientReference, request.encounterReference);
      for (const [eye, row] of Object.entries(request.eyes) as Array<[string, any]>) {
        current[eye].facts = current[eye].facts.map((fact:any) => {
          const selected = row.selected.find((claim:any) => claim.key.optionCode === fact.key.optionCode);
          return selected ? {...fact, status:'live', presence:'present', qualifiers:selected.qualifiers, homes:selected.homes, baseline:{kind:'canonical', reference:`Observation/${eye}-${fact.key.optionCode}`,versionId:'2'}} : row.loaded.some((claim:any)=>claim.key.optionCode===fact.key.optionCode) ? {...fact,status:'retired'} : fact;
        });
        if (row.panel) current[eye].panel = {...current[eye].panel,other:'',remarks:'',...row.panel.state, baseline:{kind:'canonical', reference:`Observation/${eye}-panel`,versionId:'2'}};
        if (row.negativeAct) current[eye].negativeActs = [{status:'live',scope:{...row.negativeAct, definitionStableKey:stableKey,eye,optionCodes:row.negativeAct.scope,assertedAt:'2026-09-17T12:00:00Z'}}];
      }
      saved.set(stableKey, current);
      return Response.json({result:'command', commandId:request.commandId,complete:true,executionOrder:[0],outcomes:[{target:stableKey,status:'applied',clinicalWrite:'confirmed'}]});
    }
    if (!url.searchParams.has('encounter')) return Response.json(body);
    const eyes = saved.get(stableKey) ?? canonicalEyes(definition, body.rows ?? [], url.searchParams.get('patient')!, url.searchParams.get('encounter')!);
    saved.set(stableKey, eyes);
    return Response.json({...body, eyes});
  };
  adapters.set(source, adapter);
  return adapter;
}

function canonicalEyes(definition: CustomFindingDefinition, rows: any[], patient: string, encounter: string) {
  return Object.fromEntries(['OD','OS'].map(eye => {
    const row = rows.find(row => row.eye === eye);
    const base = {v:1,patientId:patient.replace('Patient/',''),encounterId:encounter.replace('Encounter/',''),stableKey:definition.stableKey,eye};
    const facts = definition.customFields.filter(field=>field.valueType==='multi-select').flatMap(field=>(field.options??[]).filter(option=>option.active).map(option=>{
      const key = {...base,fieldCode:field.localCode,optionCode:option.code};
      const live = row?.values?.some((v:any)=>v.code===field.localCode&&Array.isArray(v.value)&&v.value.includes(option.code));
      return {key,rowKey:`${eye}-${option.code}`,projectionKey:`${eye}-${option.code}`,kind:'fact',status:live?'live':'offered',presence:'present',qualifiers:row?.findingDetails?.[option.code]??{},homes:[],editable:true,baseline:live?{kind:'canonical',reference:row.observationReference??`Observation/${eye}-${option.code}`,versionId:'1'}:{kind:'absent',key}};
    }));
    const selectedCodes = (row?.values??[]).flatMap((value:any) => Array.isArray(value.value) ? value.value : []);
    facts.sort((a,b) => {const ai=selectedCodes.indexOf(a.key.optionCode),bi=selectedCodes.indexOf(b.key.optionCode);return (ai<0?999:ai)-(bi<0?999:bi);});
    return [eye,{encounterEditable:true,facts,panel:{deferred:row?.state==='deferred',other:row?.other??'',remarks:row?.remarks??'',values:Object.fromEntries((row?.values??[]).filter((v:any)=>!Array.isArray(v.value)).map((v:any)=>[v.code,v.value])),editable:true,baseline:{kind:'absent',key:base}},negativeActs:row?.state==='normal'?[{status:'live',scope:{id:'aa5234a9-95d4-4aed-a577-c93233dd08e0',definitionStableKey:definition.stableKey,eye,optionCodes:facts.map(f=>f.key.optionCode),exclusions:[],assertedAt:row.recordedAt??'2026-09-17T12:00:00Z'}}]:[]}];
  }));
}
