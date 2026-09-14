import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { refreshFixtureTokens, successfulHttp, http, writeEvidence, saveHttpTrace } from './live-fixture.mjs';
const f = await refreshFixtureTokens();
const seedPath = new URL('./e1-seed.json', import.meta.url);
const created=existsSync(seedPath) ? JSON.parse(readFileSync(seedPath,'utf8')) : [];
if (!created.length)
for(const [family,given] of [['ZzeoneAnn','ZzeoneBeth'],['ZzeoneAnna','ZzeoneCarl'],['ZzeoneOther','ZzeoneDora']]) {
 const p=await successfulHttp(f,'POST','/fhir/R4/Person',{body:{resourceType:'Person',meta:{project:f.projectA},active:true,name:[{family,given:[given]}]},scenario:'E1 seed'});created.push(p);
}
writeFileSync(seedPath,JSON.stringify(created,null,2)+'\n');
const cases=[];
for(const key of ['ZzeoneAnn','zzeoneann','ZZEONEANN','ZzeoneBeth','zzeonebe','eoneAnn','ZzeoneAbsent']) {
 const result=await http(f,'GET',`/fhir/R4/Person?name=${key}&_project=${f.projectA}`,{scenario:'E1 name search'});
 cases.push({key,status:result.status,names:result.body.entry?.map(e=>e.resource.name),ids:(result.body.entry ?? []).map(e=>e.resource.id)});
}
writeEvidence('e1-results.json',{cases});saveHttpTrace('e1-http.json');
for(const c of cases) assert.equal(c.status,200,c.key);
assert.deepEqual(new Set(cases[0].ids),new Set(created.slice(0,2).map(p=>p.id)));
assert.deepEqual(cases[1].ids,cases[0].ids);assert.deepEqual(cases[2].ids,cases[0].ids);
assert.deepEqual(cases[3].ids,[created[0].id]);assert.deepEqual(cases[4].ids,[created[0].id]);
assert.deepEqual(cases[5].ids,[]);assert.deepEqual(cases[6].ids,[]);
console.log(JSON.stringify(cases,null,2));
