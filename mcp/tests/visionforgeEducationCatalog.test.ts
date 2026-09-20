import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { Pool } from "pg";
import { PgEducationCatalogSnapshotStore, type EducationCatalogSnapshotStore } from "../src/comms/education-catalog-snapshot-store.js";
import { createEducationCatalogFromEnv, createVisionForgeEducationCatalogReader } from "../src/comms/visionforge-education-catalog.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/visionforge-education-catalog/${name}`, import.meta.url), "utf8");
const envelope = () => JSON.parse(fixture("catalog.body"));
const metadata = JSON.parse(fixture("catalog.response.json"));
const token = "synthetic-o1-seam-secret";
const practiceId = "o1-practice-a";
const postgresUrl = process.env.ODOS_POSTGRES_URL
  ?? "postgresql://medplum:medplum@127.0.0.1:5433/medplum";
const catalogTest = test;

async function setup(t: TestContext) {
  const schema = `o1_${randomUUID().replaceAll("-", "")}`;
  const owner = new Pool({ connectionString: postgresUrl });
  await owner.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(postgresUrl); scoped.searchParams.set("options", `-c search_path=${schema}`);
  const store = new PgEducationCatalogSnapshotStore({ postgresUrl: scoped.href });
  let body = fixture("catalog.body"); let status = 200; let delay = 0; let requests = 0; let redirectTo: string | undefined;
  const redirectHeaders: Array<string | undefined> = [];
  const headers: Array<import("node:http").IncomingHttpHeaders> = [];
  const server = createServer((req, res) => {
    if (req.url === "/redirect-target") {
      redirectHeaders.push(req.headers.authorization);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(fixture("catalog.body"));
      return;
    }
    requests++; headers.push(req.headers);
    assert.equal(req.url, `/v1/practices/${practiceId}/education/catalog`);
    setTimeout(() => { res.writeHead(status, { "Content-Type": "application/json", ETag: metadata.headers.etag,
      ...(redirectTo ? { Location: redirectTo } : {}) }); res.end(status === 304 ? undefined : body); }, delay).unref();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const config = { baseUrl: `http://127.0.0.1:${address.port}`, practiceId, token };
  const reader = createVisionForgeEducationCatalogReader(config, store);
  await reader.ready();
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await store.close(); await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); });
  return { reader, store, config, headers, redirectHeaders, requests: () => requests,
    set: (value: unknown, code = 200, wait = 0) => { body = typeof value === "string" ? value : JSON.stringify(value); status = code; delay = wait; redirectTo = undefined; },
    setRedirect: (url: string) => { status = 302; redirectTo = url; },
    disconnect: () => { server.closeAllConnections(); server.close(); },
  };
}

catalogTest("C0 accepted through real HTTP; active picker and pinned retained/withdrawn split", async t => {
  const f = await setup(t);
  assert.equal(f.reader.status().state, "unavailable");
  assert.equal((await f.reader.refresh()).outcome, "accepted");
  assert.deepEqual(f.reader.status().counts, { active: 1, retained: 1, withdrawn: 1 });
  assert.deepEqual(f.reader.list().map(i => `${i.id}@${i.version}`), ["history@2"]);
  assert.equal(f.reader.get("history", 1)?.version, 1);
  assert.equal(f.reader.get("history")?.version, 2);
  assert.equal(f.reader.getForNewWork("history", 1), undefined);
  assert.equal(f.reader.get("withdrawn", 1), undefined);
  assert.equal(f.reader.lifecycle("withdrawn", 1), "withdrawn");
  assert.equal(f.headers[0].authorization, `Bearer ${token}`);
  assert.equal(f.headers[0]["if-none-match"], undefined);
  assert.deepEqual((await f.store.load(practiceId))?.envelope, envelope());
  const copy = f.reader.get("history", 1)!; copy.title = "caller mutation";
  assert.notEqual(f.reader.get("history", 1)?.title, copy.title);
});

const invalid: Array<[string, (e: any) => void]> = [
  ["contract-version-unsupported", e => { e.contractVersion = 99; }],
  ["practice-mismatch", e => { e.practiceId = "o1-practice-b"; }],
  ["entry-invalid", e => { e.entries[0].item.unexpected = true; }],
  ["dx-code-unverified", e => { e.entries[0].item.dxCodes = ["Z99.999"]; }],
  ["url-origin-mismatch", e => { e.entries[0].item.urls.web = "https://foreign.example.test/content"; }],
  ["catalog-emptied", e => { e.entries = []; }],
  ["meaning-changed", e => { e.entries[0].manifestSha256 = "c".repeat(64); }],
  ["lifecycle-regressed", e => { e.entries[2].lifecycle.state = "active"; }],
];
for (const [code, mutate] of invalid) catalogTest(`refusal ${code} preserves the entire last-good row and served copy`, async t => {
  const f = await setup(t); await f.reader.refresh();
  const before = await f.store.load(practiceId); const changed = envelope(); mutate(changed); f.set(changed);
  assert.deepEqual(await f.reader.refresh(), { outcome: "refused", refusalCode: code });
  const after = await f.store.load(practiceId);
  assert.deepEqual(after?.envelope, before?.envelope); assert.deepEqual(after?.localCopy, before?.localCopy);
  assert.equal(after?.etag, before?.etag); assert.equal(after?.acceptedAt, before?.acceptedAt);
  assert.equal(after?.lastRefusalCode, code); assert.equal(f.reader.status().state, "last-good");
  assert.equal(f.reader.get("history", 1)?.version, 1); assert.equal(f.reader.get("withdrawn", 1), undefined);
});

catalogTest("G2 G20 C0 absence carries forward as retained across restart and normal reappearance", async t => {
  const f = await setup(t); f.set(fixture("before-absence.body")); await f.reader.refresh();
  assert.ok(f.reader.getForNewWork("partial", 1));
  f.set(fixture("catalog.body")); assert.equal((await f.reader.refresh()).outcome, "accepted");
  assert.ok(f.reader.get("partial", 1)); assert.equal(f.reader.getForNewWork("partial", 1), undefined);
  assert.equal(f.reader.lifecycle("partial", 1), "retained");
  const row = await f.store.load(practiceId);
  assert.equal(row?.localCopy.find(e => e.item.id === "partial")?.absentUpstream, true);
  assert.equal((row?.envelope as any).entries.some((e: any) => e.item.id === "partial"), false);
  const restarted = createVisionForgeEducationCatalogReader(f.config, f.store);
  const calls = f.requests(); await restarted.ready(); assert.equal(f.requests(), calls);
  assert.ok(restarted.get("partial", 1)); assert.equal(restarted.lifecycle("partial", 1), "retained");
  f.set(fixture("before-absence.body")); assert.equal((await restarted.refresh()).outcome, "accepted");
  assert.ok(restarted.getForNewWork("partial", 1));
});

catalogTest("G12 restart with upstream unreachable serves persisted copy and preserves withdrawal", async t => {
  const f = await setup(t); await f.reader.refresh(); f.disconnect();
  const restarted = createVisionForgeEducationCatalogReader(f.config, f.store); await restarted.ready();
  assert.ok(restarted.get("history", 1)); assert.equal(restarted.get("withdrawn", 1), undefined);
  assert.equal((await restarted.refresh()).refusalCode, "network");
  assert.ok(restarted.get("history", 1));
});

catalogTest("G24 failed boot and failed retry cannot replace an unread withdrawn baseline", async t => {
  const f = await setup(t); assert.equal((await f.reader.refresh()).outcome, "accepted");
  const before = await f.store.load(practiceId); assert.ok(before);
  const changed = envelope();
  changed.entries = changed.entries.filter((entry: any) => !(entry.item.id === "history" && entry.item.version === 1));
  changed.entries.find((entry: any) => entry.item.id === "withdrawn").lifecycle.state = "active";
  f.set(changed);
  let failedLoads = 2; let accepted = 0; let attempts = 0;
  const flaky: EducationCatalogSnapshotStore = {
    load: async id => { if (failedLoads-- > 0) throw new Error("Synthetic Postgres read interruption"); return f.store.load(id); },
    accept: async value => { accepted++; await f.store.accept(value); },
    recordAttempt: async (id, value) => { attempts++; await f.store.recordAttempt(id, value); },
  };
  const restarted = createVisionForgeEducationCatalogReader(f.config, flaky);
  await restarted.ready();
  assert.equal(restarted.status().state, "unavailable");
  const requestsBefore = f.requests();
  assert.deepEqual(await restarted.refresh(), { outcome: "refused", refusalCode: "storage-unavailable" });
  assert.equal(f.requests(), requestsBefore, "an unread baseline must be refused before the network request");
  assert.equal(restarted.status().state, "unavailable");
  assert.equal(restarted.status().lastRefusalCode, "storage-unavailable");
  assert.equal(restarted.getForNewWork("withdrawn", 1), undefined);
  assert.equal(restarted.get("withdrawn", 1), undefined);
  assert.equal(accepted, 0); assert.equal(attempts, 0);
  assert.deepEqual(await f.store.load(practiceId), before);
  assert.equal(before.localCopy.length, 3);
  assert.equal(before.localCopy.find(entry => entry.item.id === "withdrawn")?.lifecycle.state, "withdrawn");
  assert.ok(before.localCopy.find(entry => entry.item.id === "history" && entry.item.version === 1));

  assert.deepEqual(await restarted.refresh(), { outcome: "refused", refusalCode: "lifecycle-regressed" });
  assert.equal(restarted.lifecycle("withdrawn", 1), "withdrawn");
  assert.equal(restarted.getForNewWork("withdrawn", 1), undefined);
  assert.ok(restarted.get("history", 1));
  assert.equal((await f.store.load(practiceId))?.localCopy.length, 3);
  const control = createVisionForgeEducationCatalogReader(f.config, f.store); await control.ready();
  assert.deepEqual(await control.refresh(), { outcome: "refused", refusalCode: "lifecycle-regressed" });
  assert.equal(control.lifecycle("withdrawn", 1), "withdrawn");
  t.diagnostic("A–I: boot unavailable; retry storage-unavailable; no writes; withdrawn not offered; history retained; persisted 3; recovered and healthy controls lifecycle-regressed/withdrawn");
});

catalogTest("G13 captured 304 preserves snapshot and records not-modified", async t => {
  const f = await setup(t); await f.reader.refresh(); const before = await f.store.load(practiceId);
  f.set(fixture("not-modified.body"), 304);
  assert.equal((await f.reader.refresh()).outcome, "not-modified");
  const after = await f.store.load(practiceId);
  assert.deepEqual(after?.localCopy, before?.localCopy); assert.deepEqual(after?.envelope, before?.envelope);
  assert.equal(after?.acceptedAt, before?.acceptedAt); assert.equal(after?.lastAttemptOutcome, "not-modified");
  assert.equal(f.headers[1]["if-none-match"], metadata.headers.etag);
  assert.equal(f.reader.status().state, "current");
});

catalogTest("G23 redirected seam never forwards the bearer to the target", async t => {
  const f = await setup(t); await f.reader.refresh(); const before = await f.store.load(practiceId);
  f.setRedirect(`${f.config.baseUrl}/redirect-target`);
  const result = await f.reader.refresh();
  assert.deepEqual(f.redirectHeaders, [], "the redirect target must receive no Authorization header or request");
  assert.equal(result.outcome, "refused");
  assert.deepEqual((await f.store.load(practiceId))?.localCopy, before?.localCopy);
});

catalogTest("G17 concurrent refreshes coalesce into one HTTP request", async t => {
  const f = await setup(t); f.set(fixture("catalog.body"), 200, 50);
  const results = await Promise.all([f.reader.refresh(), f.reader.refresh(), f.reader.refresh()]);
  assert.equal(f.requests(), 1); assert.ok(results.every(r => r.outcome === "accepted"));
});

catalogTest("foreign-practice 401 and practice-mismatch store nothing without an accepted copy", async t => {
  const f = await setup(t);
  f.set(fixture("foreign-practice.body"), 401);
  assert.equal((await f.reader.refresh()).refusalCode, "http-401"); assert.equal(await f.store.load(practiceId), undefined);
  const wrong = envelope(); wrong.practiceId = "o1-practice-b"; f.set(wrong);
  assert.equal((await f.reader.refresh()).refusalCode, "practice-mismatch"); assert.equal(await f.store.load(practiceId), undefined);
});

for (const [code, body, status, wait] of [["http-503", "{}", 503, 0], ["not-json", "invalid-json", 200, 0], ["timeout", "{}", 200, 11_000]] as const) {
  catalogTest(`transport ${code} keeps last-good`, async t => {
    const f = await setup(t); await f.reader.refresh(); const before = await f.store.load(practiceId);
    f.set(body, status, wait); assert.equal((await f.reader.refresh()).refusalCode, code);
    assert.deepEqual((await f.store.load(practiceId))?.localCopy, before?.localCopy); assert.ok(f.reader.get("history", 1));
  });
}

test("G14 seed only for entirely unset configuration; invalid/partial configuration fails closed without secrets", async () => {
  const seed = createEducationCatalogFromEnv({}); await seed.ready(); assert.ok(seed.list().length); assert.equal(seed.status().source, "seed-placeholder");
  for (const env of [{ VISIONFORGE_BASE_URL: "http://localhost" }, { VISIONFORGE_BASE_URL: "file:///tmp", VISIONFORGE_PRACTICE_ID: "platform", VISIONFORGE_SEAM_TOKEN: token }, { VISIONFORGE_SEAM_TOKEN: "" }]) {
    const logs: string[] = [];
    const reader = createEducationCatalogFromEnv(env, { log: message => logs.push(message) });
    await reader.ready(); await reader.refresh();
    assert.equal(reader.status().state, "misconfigured"); assert.deepEqual(reader.list(), []); assert.equal(reader.get("history", 1), undefined);
    assert.equal(logs.length, 1); assert.ok(!logs.join().includes(token)); assert.ok(!logs.join().includes("http://localhost"));
  }
});

test("G22 HTTPS is required except literal IPv4 and IPv6 loopback", async () => {
  let requests = 0;
  const store: EducationCatalogSnapshotStore = { load: async () => undefined, accept: async () => {}, recordAttempt: async () => {} };
  const fakeFetch = async () => { requests++; return new Response("{}", { status: 503 }); };
  for (const [url, allowed] of [
    ["https://education.example.test", true], ["http://127.0.0.1:4318", true], ["http://[::1]:4318", true],
    ["http://ivadash-1.tail2e28aa.ts.net", false], ["http://localhost:4318", false],
  ] as const) {
    const reader = createEducationCatalogFromEnv({ VISIONFORGE_BASE_URL: url, VISIONFORGE_PRACTICE_ID: practiceId, VISIONFORGE_SEAM_TOKEN: token },
      { store, fetch: fakeFetch as typeof fetch, log: () => {} });
    await reader.ready(); const before = requests; const result = await reader.refresh();
    assert.equal(reader.status().state === "misconfigured", !allowed, url);
    assert.equal(requests - before, Number(allowed), url);
    assert.equal(result.refusalCode, allowed ? "http-503" : "misconfigured", url);
  }
});

catalogTest("G15 configured status contains neither credential nor base URL", async t => {
  const f = await setup(t); await f.reader.refresh();
  for (const s of [f.reader.status(), (f.set("bad", 401), await f.reader.refresh(), f.reader.status())]) {
    const text = JSON.stringify(s); assert.ok(!text.includes(token)); assert.ok(!text.includes(f.config.baseUrl)); assert.ok(!text.includes("Synthetic O1 content"));
  }
});

test("G18 captured transactional catalog remains compatible and E1a requires marketing offerClass", async () => {
  const { educationItemSchema } = await import("../src/comms/education-catalog.js");
  for (const entry of envelope().entries) {
    const parsed = educationItemSchema.parse(entry.item);
    assert.equal(parsed.offerClass, "eyecare");
    const { offerClass, ...unchanged } = parsed;
    assert.deepEqual(unchanged, entry.item);
    assert.equal(educationItemSchema.safeParse({ ...entry.item, consentClass: "marketing" }).success, false);
    for (const classification of ["eyecare", "cosmetic"]) {
      assert.equal(educationItemSchema.parse({ ...entry.item, consentClass: "marketing", offerClass: classification }).offerClass, classification);
    }
  }
});

catalogTest("E1a published marketing without classification is refused without replacing last good content", async t => {
  const f = await setup(t);
  assert.equal((await f.reader.refresh()).outcome, "accepted");
  const before = await f.store.load(practiceId);
  const changed = envelope(); changed.entries[1].item.consentClass = "marketing";
  f.set(changed);
  assert.deepEqual(await f.reader.refresh(), { outcome: "refused", refusalCode: "entry-invalid" });
  const after = await f.store.load(practiceId);
  assert.deepEqual(after?.localCopy, before?.localCopy);
  assert.deepEqual(after?.envelope, before?.envelope);
  assert.equal(after?.etag, before?.etag);
  assert.equal(after?.acceptedAt, before?.acceptedAt);
  assert.equal(after?.lastRefusalCode, "entry-invalid");
});
for (const offerClass of ["eyecare", "cosmetic"]) catalogTest(`E1a published ${offerClass} classification survives persistence and restart`, async t => {
  const f = await setup(t);
  const changed = envelope(); changed.entries[1].item.consentClass = "marketing"; changed.entries[1].item.offerClass = offerClass;
  f.set(changed); assert.equal((await f.reader.refresh()).outcome, "accepted");
  assert.equal(f.reader.getForNewWork("history", 2)?.offerClass, offerClass);
  const restarted = createVisionForgeEducationCatalogReader(f.config, f.store); await restarted.ready();
  assert.equal(restarted.getForNewWork("history", 2)?.offerClass, offerClass);
});

test("G19 plan-set and protocol defaults remain the seed placeholder reader", async () => {
  const { loadDefaultEducationCatalogReader } = await import("../src/comms/education-catalog.js");
  const generator = readFileSync(new URL("../src/clinical-graph/plan-sets/generator.ts", import.meta.url), "utf8");
  const protocol = readFileSync(new URL("../src/clinical-graph/protocol-endpoint.ts", import.meta.url), "utf8");
  assert.match(generator, /catalog: EducationCatalogReader = loadDefaultEducationCatalogReader\(\)/);
  assert.match(protocol, /catalog \?\? loadDefaultEducationCatalogReader\(\)/);
  assert.equal(loadDefaultEducationCatalogReader().placeholderUrlHost, "education.invalid");
});
