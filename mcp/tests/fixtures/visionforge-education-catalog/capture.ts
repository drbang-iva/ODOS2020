import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const vf = process.env.O1_VF_WORKTREE ?? '/tmp/vf-o1-capture';
const { default: postgres } = await import(`${vf}/node_modules/postgres/src/index.js`);
const { applyPendingMigrations } = await import(`${vf}/runtime/src/db/migrations.ts`);
const { createRuntimeApp } = await import(`${vf}/runtime/src/http/app.ts`);
const { createEducationRepository } = await import(`${vf}/runtime/src/education/repository.ts`);
const { createDurablePracticeRepository } = await import(`${vf}/runtime/src/practices/repository.ts`);
const root = dirname(fileURLToPath(import.meta.url));
const ownerUrl = process.env.O1_VF_OWNER_URL;
assert.ok(ownerUrl && new URL(ownerUrl).hostname === '127.0.0.1');
const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
const sql = postgres(ownerUrl.replace('visionforge_owner:', 'visionforge_app:'), { max: 4, onnotice: () => {} });
const token = randomBytes(32).toString('hex');
const manifestSalt = randomBytes(16).toString('hex');
const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const practice = 'o1-practice-a';
const origin = 'https://education.example.test';
const actor = 'odos-o1-synthetic-reviewer';
const repo = createEducationRepository(sql, { educationOriginPracticeId: practice });
const app = createRuntimeApp({
  sql, adminOrigin: 'http://localhost:3000', runtimeAdminTokenHash: randomBytes(32).toString('hex'),
  programTokenKey: randomBytes(32), programPublicBaseUrl: 'https://program.example.test',
  programSeamTokenHash: hash(token), programSeamPracticeId: practice,
  educationOriginPracticeId: practice, educationPublicBaseUrl: origin,
});
const input = (technicalFixture = false) => ({
  title: 'Synthetic O1 content', kind: 'page', audience: 'patient', laneHint: 'clinical',
  consentClass: 'transactional', dxCodes: [], channels: ['sms', 'email', 'print'],
  body: { paragraphs: ['Synthetic content for isolated catalog verification.'] }, technicalFixture,
});
const receipts = (id: string, version: number) => ['web', 'email', 'print'].map(channel => ({
  channel, url: `${origin}/${id}/v${version}/${channel}`, origin,
  fileSha256: hash(`${id}@${version}/${channel}`), manifestSha256: hash(`${manifestSalt}:${id}@${version}`),
}));
async function publish(id: string, version = 1) {
  await repo.review(practice, id, version, actor, 'synthetic fixture review');
  await repo.record(practice, id, version, receipts(id, version), actor);
}
const request = (p = practice, auth = true, headers = {}) => app.request(`/v1/practices/${p}/education/catalog`, {
  headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...headers },
});
const captured: string[] = [];
async function capture(name: string, response: Response) {
  const body = await response.text();
  const metadata = JSON.stringify({ status: response.status, headers: Object.fromEntries(response.headers) }, null, 2) + '\n';
  await writeFile(join(root, `${name}.body`), body);
  await writeFile(join(root, `${name}.response.json`), metadata);
  captured.push(`${name}.body`, `${name}.response.json`);
  return { body, status: response.status, etag: response.headers.get('etag') };
}
try {
  const migrations = await applyPendingMigrations(owner, `${vf}/runtime/migrations`);
  for (const id of [practice, 'o1-practice-b']) {
    await createDurablePracticeRepository(sql).upsert({ id, name: 'O1 synthetic practice', timezone: 'America/New_York', handlesPhi: false,
      brandPack: { version: 5, enabledVerticals: ['eyecare'], verticalSelectionConfirmed: true,
        identity: { descriptor: 'Synthetic fixture', logos: {}, palette: [], typography: {}, voicePreset: 'clear' },
        services: [], people: [], reviews: [], beforeAfterPairs: [] } });
  }
  await repo.create(practice, 'history', input(), actor);
  await publish('history');
  await repo.newVersion(practice, 'history', input(), actor);
  await publish('history', 2);
  await repo.create(practice, 'withdrawn', input(), actor);
  await publish('withdrawn');
  await repo.withdraw(practice, 'withdrawn', 1, actor, 'Synthetic withdrawal');
  await repo.create(practice, 'technical', input(true), actor);
  await publish('technical');
  await repo.create(practice, 'partial', input(), actor);
  await publish('partial');
  const before = await capture('before-absence', await request());
  assert.equal(before.status, 200);
  assert.ok(JSON.parse(before.body).entries.some((e: any) => e.item.id === 'partial'));
  // Only this partial-publication fixture uses owner SQL; all content was created through the repository.
  await owner`delete from publication where practice_id=${practice} and item_id='partial' and channel <> 'web'`;
  const a = await capture('catalog', await request());
  assert.equal(a.status, 200);
  const entries = JSON.parse(a.body).entries;
  assert.deepEqual(entries.map((e: any) => [e.item.id, e.item.version, e.lifecycle.state]), [
    ['history', 1, 'retained'], ['history', 2, 'active'], ['withdrawn', 1, 'withdrawn'],
  ]);
  assert.equal(a.etag, `"${hash(a.body)}"`);
  const b = await capture('not-modified', await request(practice, true, { 'if-none-match': a.etag }));
  assert.equal(b.status, 304); assert.equal(b.body, '');
  const c = await capture('foreign-practice', await request('o1-practice-b'));
  const d = await capture('anonymous', await request('o1-practice-b', false));
  assert.equal(c.status, 401); assert.equal(d.status, 401); assert.equal(c.body, d.body);
  await writeFile(join(root, 'capture-result.json'), JSON.stringify({ migrations: migrations.length, statuses: [a.status, b.status, c.status, d.status],
    states: entries.map((e: any) => e.lifecycle.state), omitted: ['technical@1', 'partial@1'] }, null, 2) + '\n');
  captured.push('capture-result.json');
  console.log(JSON.stringify({ capture: 'C0', statuses: [a.status, b.status, c.status, d.status], entries: entries.length, migrations: migrations.length }));
  if (process.env.O1_SERVE === '1') {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
    await mkdir('/tmp/odos-o1-proof', { recursive: true, mode: 0o700 });
    await writeFile('/tmp/odos-o1-proof/reader-env.json', JSON.stringify({ VISIONFORGE_BASE_URL: server.url.origin, VISIONFORGE_PRACTICE_ID: practice, VISIONFORGE_SEAM_TOKEN: token }), { mode: 0o600 });
    console.log(`VisionForge C0 HTTP listener: ${server.url.origin}`);
    await new Promise<void>(resolve => { const stop = () => { server.stop(true); resolve(); }; process.once('SIGTERM', stop); process.once('SIGINT', stop); });
  }
} finally { await Promise.all([owner.end(), sql.end()]); }
