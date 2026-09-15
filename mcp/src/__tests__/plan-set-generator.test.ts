import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_PROTOCOLS } from '../clinical-graph/protocol-fixtures.js';
test('seven generated glaucoma built-ins replace the suspect v1 finding seeds', () => {
  const protocols = BUILTIN_PROTOCOLS.filter(p => p.id.startsWith('glaucoma-'));
  assert.equal(protocols.length, 7);
  assert.equal(protocols.find(p => p.id === 'glaucoma-suspect-initial')?.version, 2);
  assert.ok(protocols.every(p => p.items.every(i => i.itemType !== 'finding-seed' && i.title)));
});

import { buildPlanSetProtocols } from '../clinical-graph/plan-sets/generator.js';
import { GLAUCOMA_PLAN_SET_SPECS, PENDING_ORDERABLES } from '../clinical-graph/plan-sets/glaucoma.js';
import { PROCEDURE_FEE_SEEDS } from '../clinical-graph/procedure-fee-schedule.js';
import { buildDiagnosisCatalogSeeds } from '../clinical-graph/diagnosis-catalog-seeds.js';
import type { EducationCatalogReader, EducationContentItem } from '../comms/education-catalog.js';
import type { PlanSetSpec } from '../clinical-graph/plan-sets/types.js';
const keys = new Set(PROCEDURE_FEE_SEEDS.map(p => p.procedureConceptKey));
const build = () => buildPlanSetProtocols(GLAUCOMA_PLAN_SET_SPECS, keys);
const expectedPending = [ ['corneal-hysteresis','erg','oct-angiography'], ['corneal-hysteresis'], ['anterior-segment-oct'], ['anterior-segment-oct'], [], ['corneal-hysteresis','erg','oct-angiography'], ['corneal-hysteresis','erg','oct-angiography','anterior-segment-oct'] ];
test('hidden report is exact and hidden tests never become orders or charges', () => {
  const result = build();
  GLAUCOMA_PLAN_SET_SPECS.forEach((spec, index) => {
    assert.deepEqual(result.hidden.filter(h => h.planSetKey === spec.key).map(h => h.kind === 'test' ? h.orderable : h.reason), [...expectedPending[index], 'handout — no real catalog content']);
    const p = result.protocols[index];
    assert.equal(p.items.filter(i => i.itemType === 'order').length, [5,5,4,4,4,5,5][index]);
    assert.ok(p.items.every(i => i.itemType !== 'education'));
    for (const item of p.items.filter(i => i.itemType === 'order')) assert.ok(keys.has(String(item.payload.orderableKey)));
    assert.equal(p.items.filter(i => i.itemType === 'charge-seed').length, [5,5,4,4,4,5,5][index]);
  });
});
test('every named test is orderable or explicitly pending', () => {
  for (const spec of GLAUCOMA_PLAN_SET_SPECS) for (const t of spec.tests) assert.ok(keys.has(t.orderable) || PENDING_ORDERABLES.has(t.orderable), t.orderable);
});
test('independent catalog oracle assigns all 15 rows and 60 laterality slots to exactly the intended set', () => {
  const { protocols } = build(); let rows = 0; let slots = 0;
  for (const row of buildDiagnosisCatalogSeeds()) {
    const intended = GLAUCOMA_PLAN_SET_SPECS.find(s => s.families.some(f => row.icd10Family?.startsWith(f)));
    if (!intended) continue;
    rows++;
    const codes = row.icd10 && ('pattern' in row.icd10 ? Object.values(row.icd10.pattern) : [row.icd10.code]);
    assert.ok(codes?.length);
    for (const code of codes!) {
      slots++;
      assert.deepEqual(protocols.filter(p => p.trigger.kind === 'diagnosis' && p.trigger.dxKeys.includes(code)).map(p => p.id), [intended.replaces?.id ?? intended.key], `${row.stableKey} ${code}`);
    }
  }
  assert.equal(rows, 15); assert.equal(slots, 60);
});
test('unresolved family and injected finding seeds are refused', () => {
  assert.throws(() => buildPlanSetProtocols([{...GLAUCOMA_PLAN_SET_SPECS[0],families:['unknown-family']}], keys), /Unresolved/);
  assert.throws(() => buildPlanSetProtocols([{...GLAUCOMA_PLAN_SET_SPECS[0],tests:[{...GLAUCOMA_PLAN_SET_SPECS[0].tests[0],itemType:'finding-seed'}]} as unknown as PlanSetSpec], keys), /finding-seed/);
});
const handout: EducationContentItem = {id:'synthetic-handout',version:1,title:'Catalog handout title',kind:'handout',audience:'patient',dxCodes:[],channels:['print'],laneHint:'clinical',consentClass:'transactional',urls:{print:'https://content.example.org/handout'}};
const reader = (item?: EducationContentItem): EducationCatalogReader => ({placeholderUrlHost:'placeholder.example.org',list:()=>item?[item]:[],get:id=>item?.id===id?item:undefined});
test('missing and unknown handouts stay hidden without fabricated references', () => {
  for (const assetRef of [undefined,'unknown-handout']) {
    const spec={...GLAUCOMA_PLAN_SET_SPECS[0],handouts:[{title:'Requested handout',...(assetRef?{assetRef}:{})}]};
    const r=buildPlanSetProtocols([spec],keys,reader());
    assert.ok(!r.protocols[0].items.some(i=>i.itemType==='education'));
    assert.equal(r.hidden.at(-1)?.reason,'handout — no real catalog content');
    assert.equal(r.hidden.at(-1)?.assetRef,assetRef);
  }
});
test('placeholder metadata blocks a handout including mixed real and placeholder URLs', () => {
  const spec={...GLAUCOMA_PLAN_SET_SPECS[0],handouts:[{title:'Requested handout',assetRef:handout.id}]};
  for (const urls of [{print:'https://placeholder.example.org/handout'}, {...handout.urls,web:'https://placeholder.example.org/handout'}]) {
    const r=buildPlanSetProtocols([spec],keys,reader({...handout,urls}));
    assert.ok(!r.protocols[0].items.some(i=>i.itemType==='education'));
  }
});
test('real handout uses catalog title and accurate recording note', () => {
  const spec={...GLAUCOMA_PLAN_SET_SPECS[0],handouts:[{title:'Requested handout',assetRef:handout.id}]};
  const item=buildPlanSetProtocols([spec],keys,reader(handout)).protocols[0].items.find(i=>i.itemType==='education')!;
  assert.equal(item.title,handout.title);
  assert.equal(item.payload.deliveryMode,'print');
  assert.equal(item.payload.note,'Handout recorded; delivery is not yet tracked');
});
test('photo focus keeps first legacy identity and second focus shares one charge', () => {
  const spec={...GLAUCOMA_PLAN_SET_SPECS[0],tests:[{title:'Optic nerve photos',orderable:'fundus-photography',focus:'optic nerve',performContext:'in-office-today' as const},{title:'Retina photos',orderable:'fundus-photography',focus:'retina',performContext:'in-office-today' as const}]};
  const p=buildPlanSetProtocols([spec],keys).protocols[0];
  assert.deepEqual(p.items.filter(i=>i.itemType==='order').map(i=>[i.itemKey,i.mergeKey,i.payload.chargeSeedRef]),[['order-fundus-photography','order:fundus-photography','charge-fundus-photography'],['order-fundus-photography-retina','order:fundus-photography:retina','charge-fundus-photography']]);
  assert.equal(p.items.filter(i=>i.itemType==='charge-seed').length,1);
});

import { GLAUCOMA_CHARGE_RULES, GLAUCOMA_SUSPECT_CHARGE_RULES, GLAUCOMA_SUSPECT_PROTOCOL_V1, DRY_EYE_IPL_INIT_PROTOCOL, DRY_EYE_RF_INIT_PROTOCOL, DRY_EYE_LLLT_INIT_PROTOCOL } from '../clinical-graph/protocol-fixtures.js';
test('v2 glaucoma rules cover the union, remain provisional, and preserve legacy v1 rules', () => {
  const union=[...new Set(build().protocols.flatMap(p=>p.trigger.kind==='diagnosis'?p.trigger.dxKeys:[]))].sort();
  assert.equal(GLAUCOMA_CHARGE_RULES.length,5);
  for(const r of GLAUCOMA_CHARGE_RULES) {
    assert.equal(r.id,`rule-${r.procedureConceptKey}-glaucoma`);
    assert.equal(r.version,2);assert.equal(r.outcome,'needs-review');assert.equal(r.verificationStatus,'provisional');assert.deepEqual(r.dxScope,union);
  }
  assert.ok(GLAUCOMA_SUSPECT_CHARGE_RULES.every(r=>r.version===1 && r.id.endsWith('-h40x')));
  assert.equal(GLAUCOMA_SUSPECT_PROTOCOL_V1.version,1);
  assert.ok(!BUILTIN_PROTOCOLS.includes(GLAUCOMA_SUSPECT_PROTOCOL_V1));
});
test('dry-eye series v2 links the exact practice switch and preserves package dependency', () => {
  for(const [p,modality] of [[DRY_EYE_IPL_INIT_PROTOCOL,'ipl'],[DRY_EYE_RF_INIT_PROTOCOL,'rf'],[DRY_EYE_LLLT_INIT_PROTOCOL,'lllt']] as const) {
    assert.equal(p.version,2);
    const item=p.items.find(i=>i.itemType==='series-prescription')!;
    assert.equal(item.procedureDefinitionKey,`procedure:dry-eye:${modality}`);
    assert.ok(p.items.some(i=>i.itemKey===item.payload.chargeSeedRef));
  }
});
test('first and repeated photo focus must be distinct', () => {
  const t={title:'Optic nerve photos',orderable:'fundus-photography',focus:'optic nerve',performContext:'in-office-today' as const};
  assert.throws(()=>buildPlanSetProtocols([{...GLAUCOMA_PLAN_SET_SPECS[0],tests:[t,{...t}]}],keys),/Duplicate test focus/);
});

test('fixback exact glaucoma counseling and monitoring reasons', () => {
  const expected = [
    ['Discussed glaucoma suspect. Questions answered.', 'Glaucoma suspect monitoring'],
    ['Discussed ocular hypertension. Questions answered.', 'Ocular hypertension monitoring'],
    ['Discussed anatomical narrow angle: angle-closure warning signs · medications that dilate (antihistamines, decongestants, anticholinergics). Questions answered.', 'Anatomical narrow angle monitoring'],
    ['Discussed primary angle closure without damage. Questions answered.', 'Primary angle closure without damage monitoring'],
    ['Discussed steroid responder. Questions answered.', 'Steroid responder monitoring'],
    ['Discussed primary open-angle glaucoma: adherence and drop technique. Questions answered.', 'Primary open-angle glaucoma monitoring'],
    ['Discussed low-tension glaucoma. Questions answered.', 'Low-tension glaucoma monitoring'],
  ];
  assert.deepEqual(build().protocols.map(p => [p.items.find(i => i.itemType === 'counseling')!.payload.narrativeTemplate, p.items.find(i => i.itemType === 'follow-up')!.payload.reason]), expected);
});
