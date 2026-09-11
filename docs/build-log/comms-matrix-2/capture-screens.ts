import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../../../ui/node_modules/vite/dist/node/index.js';
import { chromium } from '../../../ui/node_modules/playwright-core/index.mjs';
import { COMMS_PREFERENCE_DEFAULTS, COMMS_PREFERENCE_DEFAULTS_VERSION, replaceCommsPreferenceCells, buildCommsOptOutExtension, ODOS_COMMS_MARKETING_CONSENT_EXTENSION_URL } from '../../../mcp/src/comms/suppression-gate.ts';
import { commsPreferencesWithEvidence, buildCommsConsent } from '../../../mcp/src/comms/comms-preferences.ts';
import type { Patient, Consent } from '@medplum/fhirtypes';

process.chdir(resolve(import.meta.dirname, '../../../ui'));
const output = resolve(import.meta.dirname, 'screenshots');
await mkdir(output, { recursive: true });
const reference = 'Patient/synthetic-matrix';
const actor = { actorReference: 'Practitioner/synthetic-staff', actorRole: 'staff' as const, recordedAt: '2026-09-11T12:00:00Z', surface: 'staff-demographics' as const };
const original: Patient = { resourceType: 'Patient', id: 'synthetic-matrix', active: true, meta: { versionId: 'opaque-before' }, name: [{ given: ['Synthetic'], family: 'Patient' }], birthDate: '1980-01-02', gender: 'unknown', telecom: [{ system: 'phone', value: '+15555550101' }, { system: 'email', value: 'synthetic@example.test' }] };
let patient = structuredClone(original), scenario = '', consents: Consent[] = [], savedDemographics = 0;
const requests: Array<{ scenario: string; method: string; path: string; ifMatch?: string }> = [];
const lanes = [{ label: 'Practice texts', number: '+15555550100', roles: ['clinical-sms', 'transactional-sms', 'marketing-sms'] }];
let stopped = false;
const sms = () => ({ patientReference: reference, smsOptedOut: stopped, remainingOptOuts: { global: false, numbers: stopped ? [lanes[0].number] : [] }, smsLanes: lanes });
function reset(state: string) {
  scenario = state; patient = structuredClone(original); consents = []; stopped = state === 'stop' || state === 'chip'; savedDemographics = 0;
  if (state === 'mixed' || state === 'paper') {
    patient.extension = [{ url: ODOS_COMMS_MARKETING_CONSENT_EXTENSION_URL, extension: [{ url: 'consent', valueBoolean: true }, { url: 'recorded', valueDateTime: actor.recordedAt }] }];
    patient = replaceCommsPreferenceCells(patient, [{ purpose: 'education', channel: 'email', allowed: true }], { recordedAt: actor.recordedAt, setBy: { reference: actor.actorReference, display: 'Synthetic staff' }, surface: actor.surface });
    consents = [{ ...buildCommsConsent(reference, [{ purpose: 'education', channel: 'email' }], 'paper-form', actor, '2026-09-10'), id: 'synthetic-evidence' }];
  }
  if (stopped) patient.extension = [buildCommsOptOutExtension('sms', lanes[0].number)];
  if (state.startsWith('engage')) patient = replaceCommsPreferenceCells(patient, [
    { purpose: 'education', channel: 'sms', allowed: false }, { purpose: 'education', channel: 'email', allowed: false },
    { purpose: 'marketing-promo', channel: 'email', allowed: state !== 'engage-marketing-off' },
  ], { recordedAt: actor.recordedAt, setBy: { reference: actor.actorReference }, surface: actor.surface });
}
const view = () => commsPreferencesWithEvidence(patient, consents, { smsSenderNumber: lanes[0].number });
const upstream = httpServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  requests.push({ scenario, method: req.method ?? 'GET', path: url.pathname, ...(req.headers['if-match'] ? { ifMatch: req.headers['if-match'] } : {}) });
  const send = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (url.pathname === '/communications/preferences/defaults' && scenario === 'new-defaults-unavailable') return send({ error: 'Synthetic defaults unavailable' }, 500);
  if (url.pathname === '/communications/preferences/defaults') return send({ version: COMMS_PREFERENCE_DEFAULTS_VERSION, defaults: COMMS_PREFERENCE_DEFAULTS });
  if (url.pathname === '/communications/preferences') {
    if (scenario === 'malformed') return send({ error: 'Malformed preferences' }, 500);
    if (req.method === 'PUT') {
      if (scenario === 'denied') return send({ error: 'Forbidden' }, 403);
      const writtenAgainst = scenario === 'outside' ? 'other-staff-version' : patient.meta!.versionId;
      patient = replaceCommsPreferenceCells(patient, body.cells, { recordedAt: actor.recordedAt, setBy: { reference: actor.actorReference }, surface: actor.surface });
      patient.meta = { versionId: 'opaque-after' };
      return send({ ...view(), patientVersion: { writtenAgainst, current: 'opaque-after' } });
    }
    return send(view());
  }
  if (url.pathname === '/communications/opt-out') return send(sms());
  if (url.pathname === '/communications/education') return send({ chartDispatchLane: 'locked_clinical', availableChannels: { clinicalSms: true, frontdeskSms: true, email: true, print: true }, items: ['transactional', 'marketing'].map(consentClass => ({ id: consentClass, version: 1, title: consentClass === 'marketing' ? 'Practice news' : 'Education handout', kind: 'handout', audience: 'patient', dxCodes: [], channels: ['sms', 'email', 'print'], laneHint: 'clinical', consentClass, urls: { web: 'https://education.invalid/read', email: 'https://education.invalid/email', print: 'https://education.invalid/print' } })) });
  if (url.pathname === '/fhir/R4/Patient/synthetic-matrix') {
    if (req.method === 'PUT') {
      if (req.headers['if-match'] !== `W/"${patient.meta!.versionId}"`) return send({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'conflict' }] }, 412);
      patient = body; savedDemographics++;
    }
    return send(patient);
  }
  if (url.pathname.startsWith('/fhir/')) return send({ resourceType: 'Bundle', type: 'searchset', entry: [] });
  return send({ error: 'No synthetic fixture response' }, 403);
});
let server: Awaited<ReturnType<typeof createServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
const address = upstream.address(); assert.ok(address && typeof address !== 'string');
const target = `http://127.0.0.1:${address.port}`;
const moduleSource = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {PatientDemographicsEditor} from '/src/components/patient/PatientDemographicsEditor.tsx'; import {NewPatient} from '/src/scenes/NewPatient.tsx'; import {EngageSheet} from '/src/components/comms/EngageSheet.tsx'; import {PatientOverview} from '/src/scenes/PatientOverview.tsx'; import '/src/styles/globals.css'; const patient=${JSON.stringify(original)}; const surface=new URLSearchParams(location.search).get('surface'); const props={patient,onSaved:()=>{},onDiscard:()=>{},onPatientSaved:()=>{}}; const element=surface==='new'?React.createElement(NewPatient):surface==='engage'?React.createElement(EngageSheet,{open:true,patient,onClose:()=>{}}):surface==='chart'?React.createElement(PatientOverview,props):React.createElement(PatientDemographicsEditor,props);createRoot(document.getElementById('root')).render(element);`;
server = await createServer({ root: resolve(import.meta.dirname, '../../../ui'), logLevel: 'silent', server: { host: '127.0.0.1', port: 0, proxy: { '/communications': { target }, '/fhir': { target } } }, plugins: [{ name: 'matrix-screen-proof', configResolved(config) { for (const proxy of Object.values(config.server.proxy ?? {})) if (typeof proxy === 'object') proxy.target = target; }, transformIndexHtml(html) { return html.replace('/src/main.tsx', '/matrix-proof.js'); }, resolveId(id) { if (id === '/matrix-proof.js') return id; }, load(id) { if (id === '/matrix-proof.js') return moduleSource; } }] });
await server.listen(); const web = server.httpServer!.address(); assert.ok(web && typeof web !== 'string');
browser = await chromium.launch({ channel: 'chrome', args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
  for (const [state, surface] of [['mixed','edit'],['stop','edit'],['paper','edit'],['denied','edit'],['malformed','edit'],['outside','edit'],['new','new'],['new-defaults-unavailable','new'],['engage','engage'],['engage-marketing-off','engage'],['chip','chart'],['sync','edit']]) {
    reset(state);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
    await page.goto(`http://127.0.0.1:${web.port}/matrix-2-proof?surface=${surface}`);
    if (surface === 'engage') await page.getByText('Their education email setting is off. Sending will switch it on.').waitFor();
    else if (surface === 'chart') { await page.getByText('Demographic detail', { exact: true }).click(); await page.getByText('Texting blocked (STOP)', { exact: true }).first().waitFor(); }
    else if (state === 'new-defaults-unavailable') { await page.getByText(/server defaults will apply/).waitFor(); assert.equal(await page.getByRole('button', { name: 'Create patient', exact: true }).isEnabled(), true); }
    else if (state === 'malformed') await page.getByText("Communication preferences can't be read for this patient. Ask a practice administrator.").waitFor();
    else await page.getByRole('table', { name: 'Communication preferences grid' }).waitFor();
    if (state === 'paper') { await page.getByLabel('Confirmed via', { exact: true }).selectOption('paper-form'); await page.getByLabel('Form date', { exact: true }).fill('2026-09-10'); }
    if (state === 'denied' || state === 'outside' || state === 'sync') {
      if (state === 'sync') await page.locator('input').first().fill('Edited draft');
      await page.getByLabel('Education Email', { exact: true }).uncheck();
      const freshRead = state === 'sync' ? page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/fhir/R4/Patient/synthetic-matrix') : undefined;
      await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
      if (state === 'denied') { await page.getByText("You don't have permission to change communication preferences.").waitFor(); assert.equal(await page.getByLabel('Education Email', { exact: true }).isDisabled(), true); }
      else if (state === 'outside') await page.getByText("This patient's record also changed elsewhere. Reload before saving demographics.").waitFor();
      else {
        await (await freshRead!).finished();
        await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Save demographics' && !button.disabled));
        const [saved] = await Promise.all([
          page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/fhir/R4/Patient/synthetic-matrix'),
          page.getByRole('button', { name: 'Save demographics', exact: true }).click(),
        ]);
        assert.equal(saved.status(), 200); await saved.finished();
        assert.equal(savedDemographics, 1); assert.equal(patient.name?.[0].given?.[0], 'Edited draft');
      }
    }
    await page.screenshot({ path: resolve(output, `${state}.png`), fullPage: true, animations: 'disabled' });
    await page.close();
  }
  await writeFile(resolve(output, 'browser-proof.json'), JSON.stringify({ fixture: 'Synthetic HTTP responses; actual components and clients; server resolver supplies matrix and defaults', requests, passed: true }, null, 2));
  console.log('Captured 12 synthetic screens and confirmed the real editor save sequence.');
} finally { await browser?.close(); await server?.close(); if (upstream.listening) await new Promise<void>(done => upstream.close(() => done())); }
