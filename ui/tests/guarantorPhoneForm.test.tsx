import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { ResponsiblePartiesControl } from '../src/components/patient/ResponsiblePartiesControl';
import { loadGuarantor, saveGuarantor } from '../src/lib/guarantor-editor';
import { applyTextableAnswer, phoneDraft, applyPhoneDraft, telecomSnapshot } from '../../mcp/src/clinic/patient-telecom';
import { resolveSmsNumber } from '../../mcp/src/comms/suppression-gate';
import { world, withEditor, get, store, refused, otherExtensions, wire } from '../../mcp/tests/helpers/guarantor-phone-fixture';

test('T2 real editor name-only save keeps refusal on Person and both children', async () => {
  const f = await world(true, false);
  const before = ['Person/S','RelatedPerson/r1','RelatedPerson/r2'].map(ref=>get(f,ref));
  await withEditor(f, async () => {
    let tree: any;
    await act(async () => { tree = create(<ResponsiblePartiesControl patientId="p-r1" />); });
    try {
      const family = tree.root.findAllByType('label').find((n: any)=> n.children[0] === 'Family name 1').findByType('input');
      await act(async () => family.props.onChange({ target: { value: 'Changed Synthetic' } }));
      await act(async () => { await tree.root.findAllByType('button').find((n:any)=>n.children.includes('Save guarantor')).props.onClick(); });
      for (const [i,ref] of ['Person/S','RelatedPerson/r1','RelatedPerson/r2'].entries()) {
        const p=get(f,ref); assert.equal(p.name[0].family,'Changed Synthetic'); assert.equal(refused(p),true);
        assert.deepEqual(otherExtensions(p),otherExtensions(before[i]));
      }
    } finally { act(()=>tree.unmount()); }
  });
});
test('T3 real editor selecting a number clears refusal on both children', async () => {
  const f = await world(true, false);
  await withEditor(f,async()=>{
    let tree:any; await act(async()=>{tree=create(<ResponsiblePartiesControl patientId="p-r1"/>);});
    try {
      await act(async()=>tree.root.findAllByType('input').find((n:any)=>n.props.type==='radio'&&n.props.value==='phone2').props.onChange());
      await act(async()=>{await tree.root.findAllByType('button').find((n:any)=>n.children.includes('Save guarantor')).props.onClick();});
      for(const ref of ['Person/S','RelatedPerson/r1','RelatedPerson/r2']) assert.equal(refused(get(f,ref)),false);
    } finally {act(()=>tree.unmount());}
  });
});
test('T4 writer-derived guarantor without refusal remains verified for every absent representation', async()=>{
  for(const extension of [undefined,[],[{url:'urn:synthetic:unrelated',valueString:'keep'}]]) {
    const f=await world(false,false); store(f,{...get(f,'Person/S'),extension});
    await withEditor(f,async(http)=>{
      const loaded=await loadGuarantor('r1'); assert.equal(loaded.kind,'editable');
      if(loaded.kind!=='editable') return;
      assert.ok(loaded.verification.children.every(c=>c.classification==='verified'));
      const result=await saveGuarantor(loaded.snapshot,wire(loaded.snapshot.person));
      assert.equal(result.status,'unchanged'); assert.deepEqual(http.writes,[]);
    });
  }
});
test('T10 real editor preserves email third phone old and period-bounded identities',async()=>{
  const f=await world(false,false);const parent=get(f,'Person/S');
  const extras=[{system:'email',value:'synthetic@example.test',id:'email'},{system:'phone',use:'work',value:'864-555-0103',id:'third'},{system:'phone',use:'old',value:'864-555-0104',id:'old'},{system:'phone',value:'864-555-0105',period:{end:'2020-01-01'},id:'expired'}];
  store(f,{...parent,telecom:[...parent.telecom,...extras]});
  await withEditor(f,async()=>{
    let tree:any;await act(async()=>{tree=create(<ResponsiblePartiesControl patientId="p-r1"/>);});
    try {
      const field=tree.root.findAllByType('label').find((n:any)=>n.children[0]==='Phone 1').findByType('input');
      await act(async()=>field.props.onChange({target:{value:'864-555-0199'}}));
      await act(async()=>{await tree.root.findAllByType('button').find((n:any)=>n.children.includes('Save guarantor')).props.onClick();});
      for(const ref of ['Person/S','RelatedPerson/r1','RelatedPerson/r2']) {
        const saved=get(f,ref);assert.deepEqual(saved.telecom.slice(2),extras);
        assert.equal(saved.telecom[1].value,'864-555-0199');assert.equal(saved.telecom[1].use,'mobile');
      }
    }finally{act(()=>tree.unmount());}
  });
});
test('T9 guardian refusal prevents SMS and the marked Phone 2 controls delivery',async()=>{
  const f=await world(false,false);const parent=get(f,'Person/S');
  const chosen=wire(applyTextableAnswer(parent,parent.telecom[1]));
  await withEditor(f,async()=>{
    let loaded=await loadGuarantor('r1');assert.equal(loaded.kind,'editable');if(loaded.kind!=='editable')return;
    await saveGuarantor(loaded.snapshot,chosen);
    for(const id of ['r1','r2'])assert.equal(resolveSmsNumber(get(f,`RelatedPerson/${id}`), new Date("2026-09-15T12:00:00Z")),'864-555-0102');
    loaded=await loadGuarantor('r1');if(loaded.kind!=='editable')throw Error('not editable');
    await saveGuarantor(loaded.snapshot,wire(applyTextableAnswer(loaded.snapshot.person,'neither')));
    for(const id of ['r1','r2'])assert.equal(resolveSmsNumber(get(f,`RelatedPerson/${id}`), new Date("2026-09-15T12:00:00Z")),undefined);
  });
});
