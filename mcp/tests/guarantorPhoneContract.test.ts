import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as telecom from '../src/clinic/patient-telecom.js';
import * as demographics from '../src/clinic/responsible-party-demographics.js';
import { guarantorOwnedHash } from '../src/clinic/guarantor-link-operation.js';
import { readFileSync } from 'node:fs';
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const refusal = telecom.ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL;
const marked = telecom.ODOS_TEXTABLE_NUMBER_EXTENSION_URL;
const phones = [{ value: '864-555-0101', use: 'home' }, { value: '864-555-0102', use: 'mobile' }] as const;
function person(answer: 'phone1' | 'phone2' | 'neither' | '' = 'neither') {
  assert.equal(typeof telecom.applyTextableAnswer, 'function');
  const p = { resourceType: 'Person' as const, telecom: phones.map(telecom.createPatientPhone) };
  return wire(answer ? telecom.applyTextableAnswer(p, answer === 'neither' ? answer : p.telecom[answer === 'phone1' ? 0 : 1]!) : p);
}
const refused = (p: any) => p.extension?.some((e: any) => e.url === refusal && e.valueBoolean === true) ?? false;
test('T1 Person and RelatedPerson answer leaves one marker and clears refusal on number selection', () => {
  for (const resourceType of ['Person', 'RelatedPerson'] as const) {
    const p = wire({ ...person('phone1'), resourceType, patient: { reference: 'Patient/synthetic' } });
    const no = wire(telecom.applyTextableAnswer(p, 'neither'));
    assert.equal(refused(no), true);
    const yes = wire(telecom.applyTextableAnswer(no, no.telecom![1]!));
    assert.equal(refused(yes), false);
    assert.deepEqual(yes.telecom!.map(p => p.extension?.some(e => e.url === marked && e.valueBoolean === true) ?? false), [false, true]);
  }
});
test('T2 merge preserves every target role and operation extension', () => {
  const p = person();
  const extension = ['consent-authority', 'primary', 'court-order', 'guarantor-link-claim', 'epoch'].map(url => ({ url: `urn:synthetic:${url}`, valueString: url }));
  for (const id of ['a', 'b']) {
    const child = wire(demographics.applyResponsiblePartyDemographics({ resourceType: 'RelatedPerson', id, patient: { reference: `Patient/${id}` }, extension }, p));
    assert.equal(refused(child), true);
    assert.deepEqual(child.extension!.filter(e => e.url !== refusal), extension);
  }
});
test('T3 projection clears refusal when source clears it', () => {
  const child = person();
  const cleared = person('phone2');
  assert.equal(refused(wire(demographics.applyResponsiblePartyDemographics(child, cleared))), false);
});
test('T4 projection has one representation of absent refusal after JSON transport', () => {
  const p = person('');
  const canonical = demographics.projectResponsiblePartyDemographics(p);
  for (const extension of [undefined, [], [{ url: 'urn:synthetic:other', valueBoolean: true }]]) {
    assert.deepEqual(demographics.projectResponsiblePartyDemographics(wire({ ...p, extension })), canonical);
  }
});
test('T6 projecting owned hash detects competing refusal but ignores unrelated extensions', () => {
  const p = wire({ ...person(''), resourceType: 'RelatedPerson' as const, patient: { reference: 'Patient/synthetic' } });
  assert.notEqual(guarantorOwnedHash(p, 'projecting'), guarantorOwnedHash(wire(telecom.applyTextableAnswer(p, 'neither')), 'projecting'));
  assert.equal(guarantorOwnedHash(p, 'projecting'), guarantorOwnedHash(wire({ ...p, extension: [{ url: 'urn:synthetic:other', valueBoolean: true }] }), 'projecting'));
});
test('T11 refusal profile accepts Patient Person and RelatedPerson', () => {
  const profile = JSON.parse(readFileSync(new URL('../../data/canonical-extensions/odos-no-textable-number.json', import.meta.url), 'utf8'));
  assert.deepEqual(profile.context.map((c: any) => c.expression), ['Patient', 'Person', 'RelatedPerson']);
});
