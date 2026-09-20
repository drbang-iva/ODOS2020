import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const require = createRequire(join(root, 'ui/package.json'));
const { chromium } = require('playwright-core');
const runtime = join(root, '.odos/email-e1a-proof');
const read = name => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const manifest = read('manifest.json'), credentials = read('credentials.json'), fixture = read('fixture.json');
assert.equal(manifest.project, 'odos-email-e1a-proof');
const state = process.argv[2] ?? 'after';
assert.ok(['before', 'after'].includes(state));
const base = `http://127.0.0.1:${state === 'after' ? manifest.ports.frontdoor : 32191}`;
const evidence = process.env.E1A_EVIDENCE ?? join(root, 'docs/build-log/email-e1a-envelope');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
const dispatches = [];
const replies = [];
page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/communications/education/dispatch')) dispatches.push(r.url()); });
page.on('response', r => { if (new URL(r.url()).pathname.startsWith('/communications/')) replies.push({ path: new URL(r.url()).pathname, status: r.status() }); });
try {
  await page.goto(base + '/clinic');
  await page.getByPlaceholder('Email address').fill(credentials.staff.email);
  await page.getByPlaceholder('Password', { exact: true }).fill(credentials.staff.password);
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  await page.getByPlaceholder('Password', { exact: true }).waitFor({ state: 'detached' });
  const identity = await page.evaluate(async () => {
    const session = JSON.parse(sessionStorage.getItem('odos.session.v1'));
    const response = await fetch('/auth/me', { headers: { Authorization: `Bearer ${session.accessToken}` } });
    const me = await response.json();
    return { status: response.status, project: me.project.id, profile: me.profile.id, admin: me.membership.admin === true, membership: me.membership.id, policy: me.accessPolicy?.id, policyTags: me.accessPolicy?.meta?.tag, membershipKeys: Object.keys(me.membership) };
  });
  assert.equal(identity.status, 200); assert.equal(identity.admin, false);
  assert.equal(identity.project, credentials.projectId);
  assert.equal('Practitioner/' + identity.profile, credentials.staff.practitionerReference);
  console.log(JSON.stringify(identity));
  assert.equal('ProjectMembership/' + identity.membership, credentials.staff.membershipReference);
  await page.goto(`${base}/clinic?patientId=${fixture.patientReference.slice(8)}&encounterId=${fixture.current.slice(10)}`);
  await page.getByRole('tab', { name: 'Engage', exact: true }).click();
  const card = page.getByRole('region', { name: 'Education content', exact: true }).locator('article').first();
  await card.getByRole('button', { name: /^Email / }).click();
  const confirmation = page.getByRole('region', { name: 'Education send confirmation', exact: true });
  await confirmation.waitFor({ state: 'visible' });
  const disclosure = confirmation.getByText('Education email is off for this patient. Sending will turn it back on.', { exact: true });
  assert.equal(await disclosure.count(), state === 'after' ? 1 : 0);
  const confirm = confirmation.getByRole('button', { name: 'Confirm education send', exact: true });
  assert.equal(await confirm.isEnabled(), true); assert.equal(dispatches.length, 0);
  await confirm.evaluate(element => element.scrollIntoView({ block: 'end', behavior: 'instant' }));
  const box = await confirm.boundingBox(); assert.ok(box && box.y >= 0 && box.y + box.height <= 1100);
  if (state === 'after') {
    assert.equal(await disclosure.isVisible(), true);
    const disclosureBox = await disclosure.boundingBox();
    assert.ok(disclosureBox && disclosureBox.y >= 0 && disclosureBox.y + disclosureBox.height <= box.y);
  }
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.screenshot({ path: join(evidence, `staff-${state}.png`), animations: 'disabled' });
  const html = await (await fetch(base)).text();
  const asset = html.match(/src="([^"]+\.js)"/)?.[1]; assert.ok(asset);
  const bytes = Buffer.from(await (await fetch(new URL(asset, base))).arrayBuffer());
  const result = { state, base, identity, staffPolicy: credentials.staff.policyReference,
    route: new URL(page.url()).pathname, disclosurePresent: state === 'after', confirmEnabled: true,
    confirmClicked: false, dispatchRequests: dispatches.length, communicationsResponses: replies,
    servedAsset: { path: asset, sha256: createHash('sha256').update(bytes).digest('hex') },
    screenshot: `staff-${state}.png`, confirmationText: await confirmation.innerText(),
  };
  writeFileSync(join(evidence, `staff-${state}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ state, staffAdmin: identity.admin, disclosurePresent: state === 'after', confirmEnabled: true, dispatchRequests: dispatches.length }));
} catch (error) {
  if (!await page.locator('input[type=password]').count()) await page.screenshot({ path: join(runtime, `browser-${state}-failure.png`) });
  writeFileSync(join(runtime, `browser-${state}-failure.txt`), await page.locator('body').innerText());
  throw error;
} finally { await browser.close(); }
