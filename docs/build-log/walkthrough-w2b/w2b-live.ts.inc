const provider = await human('provider');
const seeds = buildDiagnosisCatalogSeeds();
const myopiaSeed = seeds.find(row => row.stableKey === 'myopia')!;
const glaucomaSeed = seeds.find(row => row.stableKey === 'glaucoma_suspect_open_angle_high')!;
assert.ok(myopiaSeed && glaucomaSeed);
const pointers: Array<{ family: string; actual: string; expected: string }> = [];
try {
  for (const [concept, expectedKey] of [['comprehensive-exam-new', 'glaucoma'], ['routine-vision-exam-new', 'myopia']]) {
    let encounter = await seeder.fhir.create<Encounter>({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' }, subject: { reference: `Patient/${patient.id}` }, participant: [{ individual: { reference: provider.profile } }] });
    const refs: Record<string, string> = {};
    for (const [key, seed] of [['myopia', myopiaSeed], ['glaucoma', glaucomaSeed]] as const) {
      assert.ok(seed.icd10?.pattern?.bilateral);
      const condition = await seeder.fhir.create<Condition>({ resourceType: 'Condition', subject: { reference: `Patient/${patient.id}` }, encounter: { reference: `Encounter/${encounter.id}` }, code: { coding: [{ system: ICD10_CM_CODE_SYSTEM, code: seed.icd10.pattern.bilateral }], text: seed.display } });
      refs[key] = `Condition/${condition.id}`;
    }
    encounter = await seeder.fhir.update<Encounter>('Encounter', encounter.id!, { ...encounter, diagnosis: [{ condition: { reference: refs.myopia }, rank: 1 }, { condition: { reference: refs.glaucoma }, rank: 2 }] });
    const url = `${mcpBase}/clinical-graph/protocols/encounters/${encounter.id}/visit-charge`;
    const callerHeaders = { Authorization: `Bearer ${provider.token}`, 'Content-Type': 'application/json' };
    const created = await fetch(url, { method: 'POST', headers: callerHeaders, body: JSON.stringify({ procedureConceptKey: concept }) });
    assert.equal(created.status, 200, 'provider visit charge creation');
    const response = await created.json() as { proposal: { dxPointers: string[] } };
    const readback = await fetch(url, { headers: callerHeaders });
    assert.equal(readback.status, 200, 'provider persisted charge readback');
    const stored = await readback.json() as { proposal: { dxPointers: string[] } };
    assert.deepEqual(stored.proposal.dxPointers, response.proposal.dxPointers, 'persisted pointer equals creation response');
    const actual = Object.keys(refs).find(key => refs[key] === stored.proposal.dxPointers[0]) ?? 'none';
    console.log(`provider: ${concept} create=200 readback=200 pointer=${actual} expected=${expectedKey}`);
    pointers.push({ family: concept!, actual, expected: expectedKey! });
  }
  assert.deepEqual(pointers.map(row => row.actual), pointers.map(row => row.expected));
  console.log('provider: G9 2/2 persisted visit defaults PASS');
} finally { await proofDb.end(); }
