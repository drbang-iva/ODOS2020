import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { diagnosisSearchOptions } from '../src/components/charting/DiagnosisWorkspace';
import { DiagnosisPicker } from '../src/components/charting/DiagnosisPicker';
import { OdosSearchPicker } from '../src/components/inputs/OdosSearchPicker';
import { handleDiagnosisQuickListRequest } from '../../mcp/src/clinical-graph/diagnosis-quick-list-endpoint';
import { handleDiagnosisCatalogListRequest } from '../../mcp/src/clinical-graph/diagnosis-catalog-endpoint';

const emptyFhir = { search: async () => ({ resourceType: 'Bundle', type: 'searchset', entry: [] }) };

test('W2b G8 Find dx serves KCS first for dry eye', async () => {
  const response = await handleDiagnosisQuickListRequest({
    authenticate: async () => ({ staffReference: 'Practitioner/synthetic', actorRole: 'admin' }),
    tallyFhir: emptyFhir as never,
  }, { authHeader: 'Bearer synthetic' });
  assert.equal(response.status, 200);
  const matches = diagnosisSearchOptions((response.body as any).catalog, 'dry eye');
  assert.equal(matches[0]?.value, 'kcs_not_sjogren');
  assert.ok(matches.some(row => row.value === 'dry_eye_syndrome'));
});

test('W2b G8 DiagnosisPicker serves KCS first for dry eye', async () => {
  const response = await handleDiagnosisCatalogListRequest({
    authenticate: async () => ({ staffReference: 'Practitioner/synthetic', actorRole: 'provider', fhir: emptyFhir as never }),
  }, { authHeader: 'Bearer synthetic' });
  assert.equal(response.status, 200);
  const originalFetch = globalThis.fetch;
  let renderer: ReactTestRenderer | undefined;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('diagnosis-catalog')) return Response.json(response.body);
    if (url.includes('diagnosis-candidates')) return Response.json({ findings: [{ findingInstanceId: 'synthetic', candidates: [{ diagnosisKey: 'synthetic', display: 'Synthetic', codingStatus: 'provisional', source: 'rule' }] }] });
    throw new Error('Unexpected request in W2b guard');
  };
  try {
    await act(async () => { renderer = create(<DiagnosisPicker encounterReference="Encounter/synthetic" />); await new Promise(r => setTimeout(r, 0)); });
    act(() => renderer!.root.findAllByType('button').find(node => node.props['aria-expanded'] === false)!.props.onClick());
    const picker = renderer!.root.findByType(OdosSearchPicker);
    const matches = await picker.props.search('dry eye');
    assert.equal(matches[0]?.value, 'kcs_not_sjogren');
    assert.ok(matches.some((row: any) => row.value === 'dry_eye_syndrome'));
  } finally { act(() => renderer?.unmount()); globalThis.fetch = originalFetch; }
});
