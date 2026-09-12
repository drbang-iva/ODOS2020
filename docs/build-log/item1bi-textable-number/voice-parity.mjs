import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root=process.cwd();
const require=createRequire(`${root}/mcp/package.json`);
const ts=require('typescript');
const current=await import(pathToFileURL(`${root}/mcp/src/comms/suppression-gate.ts`));
const base=execFileSync('git',['show','fb14704637d51dcb098c611903492becfde6200a:mcp/src/comms/suppression-gate.ts'],{encoding:'utf8'});
const body=base.slice(base.indexOf('export function resolveVoiceNumber('),base.indexOf('function patientPhone('));
const js=ts.transpile(body.replace('export function','function'));
const oldVoice=new Function(`${js}; return resolveVoiceNumber;`)();
const now=new Date('2026-08-02T15:00:00.000Z');
const variants=[];
for(const system of ['phone','sms','email',undefined]) for(const use of ['mobile','home','work','old',undefined]) for(const value of [' +12025550101 ','',undefined]) for(const period of [undefined,{start:now.toISOString()},{end:now.toISOString()},{start:'2026-08-03'},{end:'2026-08-03'},{start:'invalid'}]) variants.push({system,use,value,period});
let voice=0,sms=0;
for(const point of variants) for(const mark of [true,false,undefined]) for(const refusal of [true,false]) {
 const resource={resourceType:'Patient',telecom:[{...point,extension:[{url:current.ODOS_TEXTABLE_NUMBER_EXTENSION_URL??'https://odos2020.com/fhir/StructureDefinition/odos-textable-number',valueBoolean:mark}]},{system:'phone',use:'mobile',value:'+12025550102'},{system:'sms',value:'+12025550103'}],extension:refusal?[{url:current.ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL,valueBoolean:true}]:[]};
 assert.equal(current.resolveVoiceNumber(resource,now),oldVoice(resource,now));voice++;
 if(mark!==true&&!refusal){assert.equal(current.resolveSmsNumber(resource,now),oldVoice(resource,now));sms++;}
}
console.log(`Voice comparisons ${voice}; unmarked SMS comparisons ${sms}; mismatches 0`);
