#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFrontdoorCoverage } from './check-frontdoor-coverage.mjs';

const proxy = (extra = '') => `const mcpTarget = 'http://localhost:3333'; const config = { server: { proxy: {
"/watchers": { target: mcpTarget },
"/fhir": { target: "http://localhost:8103" },
"/comms": { target: mcpTarget },
"/communications": { target: mcpTarget, bypass(req) {
if (req.method === "GET" && ["/communications/education/review", "/communications/consent-evidence"].includes(req.url?.split("?")[0] ?? "") && (req.headers["sec-fetch-dest"] === "document" || (req.headers.accept || "").includes("text/html"))) return "/index.html";
}},
${extra}
}}};`;
const plain = (prefix, target = '3333') => `handle ${prefix}* {\n reverse_proxy 127.0.0.1:${target}\n}\n`;
const comms = `handle /communications* {
handle @dest {\n rewrite * /index.html\n file_server\n}
handle @pages {\n rewrite * /index.html\n file_server\n}
handle {\n reverse_proxy 127.0.0.1:3333\n}
}`;
const caddy = `:8090 {
root * {$ODOS_UI_DIST}
@dest {
method GET
path /communications/education/review /communications/consent-evidence
header Sec-Fetch-Dest document
}
@pages {
method GET
path /communications/education/review /communications/consent-evidence
header Accept *text/html*
}
${plain('/watchers')}${plain('/fhir', '8103')}${comms}
handle {\n try_files {path} /index.html\n file_server\n}
}`;
const base = { backendFamilies: ['/watchers', '/comms', '/communications'], viteSource: proxy(), caddySource: caddy, exclusions: [{ prefix: '/comms', reason: 'Tunnel only' }] };
const check = (changes = {}) => checkFrontdoorCoverage({ ...base, ...changes });
const finding = (changes, type, prefix) => assert.ok(check(changes).some(f => f.type === type && (!prefix || f.prefix === prefix)), JSON.stringify(check(changes)));

test('valid config including placeholders and nested handles', () => assert.deepEqual(check(), []));
test('missing backend and Vite route', () => {
const changes = { caddySource: caddy.replace(plain('/watchers'), '') };
finding(changes, 'missing-backend', '/watchers'); finding(changes, 'missing-vite', '/watchers');
});
test('missing exclusion', () => finding({ exclusions: [] }, 'missing-backend', '/comms'));
test('excluded but routed', () => finding({ caddySource: caddy.replace(comms, plain('/comms') + comms) }, 'excluded-but-routed', '/comms'));
test('plain proxy loses page split', () => finding({ caddySource: caddy.replace(comms, plain('/communications')) }, 'page-api-split', '/communications'));
test('page path removed', () => finding({ caddySource: caddy.replace(' /communications/consent-evidence', '') }, 'page-path', '/communications'));
test('page method must be GET', () => finding({ caddySource: caddy.replace('method GET', 'method POST') }, 'page-method', '/communications'));
test('wrong target', () => finding({ caddySource: caddy.replace(plain('/watchers'), plain('/watchers', '8103')) }, 'target-mismatch', '/watchers'));
test('Medplum target must also match', () => finding({ caddySource: caddy.replace(plain('/fhir', '8103'), plain('/fhir')) }, 'target-mismatch', '/fhir'));
test('Vite-only missing route', () => finding({ viteSource: proxy('"/newthing": { target: mcpTarget },') }, 'missing-vite', '/newthing'));
test('stale route', () => finding({ caddySource: caddy.replace(comms, plain('/oldthing') + comms) }, 'stale-route', '/oldthing'));
test('unmatched opening brace', () => finding({ caddySource: caddy.slice(0, -1) }, 'parse'));
test('unmatched closing brace', () => finding({ caddySource: caddy + '}' }, 'parse'));
test('zero route blocks', () => finding({ caddySource: ':8090 {\n file_server\n}' }, 'parse'));
test('empty exclusion reason', () => finding({ exclusions: [{ prefix: '/comms', reason: ' ' }] }, 'invalid-exclusion'));
test('stale exclusion', () => finding({ exclusions: [...base.exclusions, { prefix: '/gone', reason: 'gone' }] }, 'stale-exclusion', '/gone'));
test('malformed exclusion data', () => finding({ exclusions: {} }, 'invalid-exclusion'));
test('duplicate exclusion', () => finding({ exclusions: [...base.exclusions, ...base.exclusions] }, 'invalid-exclusion'));
test('missing proxy table', () => finding({ viteSource: '' }, 'parse'));
test('unmatched Vite brace', () => finding({ viteSource: proxy().slice(0, -3) }, 'parse'));
test('unknown Vite target refuses', () => finding({ viteSource: proxy().replace('target: mcpTarget', 'target: otherTarget') }, 'parse'));
test('backend diagnostics block', () => finding({ discoveryWarnings: ['Unreadable backend file'] }, 'parse'));
test('zero backend discovery blocks', () => finding({ backendFamilies: [] }, 'parse'));
test('unexpected split on plain Vite route', () => finding({ caddySource: caddy.replace(plain('/watchers'), comms.replace('/communications*', '/watchers*')) }, 'page-api-split', '/watchers'));
test('duplicate route block refuses', () => finding({ caddySource: caddy.replace(comms, plain('/watchers') + comms) }, 'parse'));
test('unresolved page matcher refuses', () => finding({ caddySource: caddy.replace('handle @pages', 'handle @missing') }, 'parse'));

test('malformed exclusion member', () => finding({ exclusions: [null] }, 'invalid-exclusion'));
test('empty Vite proxy object', () => finding({ viteSource: 'const x = { proxy: {} };' }, 'parse'));
test('extra communications page path', () => finding({ caddySource: caddy.replace('path /communications', 'path /communications/extra /communications') }, 'page-path', '/communications'));
test('omitted GET constraint', () => finding({ caddySource: caddy.replace('method GET', '') }, 'page-method', '/communications'));
test('missing nested API proxy', () => finding({ caddySource: caddy.replace('handle {\n reverse_proxy 127.0.0.1:3333\n}', '') }, 'page-api-split', '/communications'));

test('CLI refuses missing config files with exit 1', async () => {
 const { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os');
 const { join, resolve } = await import('node:path');
 const { spawnSync } = await import('node:child_process');
 const dir = mkdtempSync(join(tmpdir(), 'frontdoor-cli-'));
 try {
  const scripts = '.claude/skills/tier0-census/scripts';
  mkdirSync(join(dir,scripts), { recursive: true });
  for (const file of ['check-frontdoor-coverage.mjs','check-proxy-coverage.mjs','discover-backend-routes.mjs']) copyFileSync(resolve(scripts,file),join(dir,scripts,file));
  symlinkSync(resolve('node_modules'), join(dir,'node_modules'), 'dir');
  mkdirSync(join(dir,'ui')); mkdirSync(join(dir,'mcp/src'), {recursive:true}); mkdirSync(join(dir,'deploy/frontdoor'), {recursive:true});
  writeFileSync(join(dir,'ui/vite.config.ts'),proxy());
  writeFileSync(join(dir,'mcp/src/index.ts'),'app.get("/watchers", handler);');
  writeFileSync(join(dir,'deploy/frontdoor/exclusions.json'),'[]');
  const result = spawnSync(process.execPath,[join(dir,scripts,'check-frontdoor-coverage.mjs')],{encoding:'utf8'});
  assert.equal(result.status,1); assert.match(result.stdout,/! parse:.*ENOENT/); assert.match(result.stdout,/Caddyfile/);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('unterminated Caddy string is a parser finding', () => finding({ caddySource: caddy.replace('root * {$ODOS_UI_DIST}', 'root * "unterminated') }, 'parse'));
test('API proxy under a page-only matcher cannot replace unconditional fallback', () => finding({ caddySource: caddy.replace('handle {\n reverse_proxy 127.0.0.1:3333', 'handle @pages {\n reverse_proxy 127.0.0.1:3333') }, 'page-api-split', '/communications'));
test('changed mcpTarget declaration is refused', () => finding({ viteSource: proxy().replace("const mcpTarget = 'http://localhost:3333'", "const mcpTarget = 'http://localhost:4444'") }, 'parse'));
test('supported development override preserves validated static fallback', () => assert.deepEqual(check({ viteSource: proxy().replace("const mcpTarget = 'http://localhost:3333'", 'const mcpTarget = env.ODOS_MCP_PROXY_TARGET || "http://localhost:3333"') }), []));
test('missing mcpTarget binding is refused', () => finding({ viteSource: proxy().replace("const mcpTarget = 'http://localhost:3333';", '') }, 'parse'));
test('changed mcpTarget fallback is refused', () => finding({ viteSource: proxy().replace("const mcpTarget = 'http://localhost:3333'", 'const mcpTarget = env.ODOS_MCP_PROXY_TARGET || "http://localhost:4444"') }, 'parse'));
test('extra proxy in page handler cannot steal page navigation', () => finding({ caddySource: caddy.replace('rewrite * /index.html\n file_server', 'rewrite * /index.html\n reverse_proxy 127.0.0.1:3333\n file_server') }, 'page-api-split', '/communications'));
test('extra top-level directive in bypass block is refused', () => finding({ caddySource: caddy.replace('handle /communications* {', 'handle /communications* {\n respond "oops"') }, 'page-api-split', '/communications'));
test('missing file server in page handler is refused', () => finding({ caddySource: caddy.replace('rewrite * /index.html\n file_server', 'rewrite * /index.html') }, 'page-api-split', '/communications'));
test('handle_path cannot expose an untracked prefix', () => finding({ caddySource: caddy.replace(comms, 'handle_path /comms* {\n reverse_proxy 127.0.0.1:3333\n}\n' + comms) }, 'parse'));
test('route directive cannot hide an untracked prefix', () => finding({ caddySource: caddy.replace(comms, 'route /hidden* {\n reverse_proxy 127.0.0.1:3333\n}\n' + comms) }, 'parse'));
test('site-level proxy cannot bypass route inventory', () => finding({ caddySource: caddy.replace(':8090 {', ':8090 {\n reverse_proxy /hidden* 127.0.0.1:3333') }, 'parse'));
test('fallback cannot conceal additional routes', () => finding({ caddySource: caddy.replace('try_files {path} /index.html', 'reverse_proxy /hidden* 127.0.0.1:3333') }, 'parse'));
test('backend-only family must still proxy to MCP', () => finding({ backendFamilies: [...base.backendFamilies,'/new-api'], caddySource: caddy.replace(comms,plain('/new-api','8103') + comms) }, 'target-mismatch','/new-api'));
test('backend-only MCP route does not change advisory Vite coverage', () => assert.deepEqual(check({ backendFamilies: [...base.backendFamilies,'/new-api'], caddySource: caddy.replace(comms,plain('/new-api') + comms) }), []));

test('F12 wildcard Accept is a page-predicate finding', () => finding({ caddySource: caddy.replace('header Accept *text/html*', 'header Accept *') }, 'page-predicate'));
test('F13 missing Accept predicate is a page-predicate finding', () => finding({ caddySource: caddy.replace('header Accept *text/html*', '') }, 'page-predicate'));
test('F14 both navigation alternatives are required per block', () => finding({ caddySource: caddy.replace('handle @pages {\n rewrite * /index.html\n file_server\n}', '') }, 'page-predicate'));
test('F15 extra header narrows navigation and is refused', () => finding({ caddySource: caddy.replace('header Sec-Fetch-Dest document', 'header Sec-Fetch-Dest document\nheader X-Other yes') }, 'page-predicate'));
test('two navigation predicates in one matcher are refused', () => finding({ caddySource: caddy.replace('header Accept *text/html*', 'header Accept *text/html*\nheader Sec-Fetch-Dest document') }, 'page-predicate'));
test('extra matcher directive is refused', () => finding({ caddySource: caddy.replace('header Accept *text/html*', 'header Accept *text/html*\nquery foo=bar') }, 'page-predicate'));
test('unrecognizable Vite navigation condition is a parse finding', () => finding({ viteSource: proxy().replace('.includes("text/html")', '.startsWith("text/html")') }, 'parse'));
test('changed Vite boolean composition is a parse finding', () => finding({ viteSource: proxy().replace('=== "document" ||', '=== "document" &&') }, 'parse'));
test('unguarded Vite page return is a parse finding', () => finding({ viteSource: proxy().replace('bypass(req) {', 'bypass(req) { return "/index.html";') }, 'parse'));

const navigationVite = proxy('"/clinic": { target: mcpTarget, bypass(req) { if (req.headers["sec-fetch-dest"] === "document" || (req.headers.accept || "").includes("text/html")) return "/index.html"; } },');
const navigationCaddy = caddy.replace('root * {$ODOS_UI_DIST}', `root * {$ODOS_UI_DIST}
@navdest header Sec-Fetch-Dest document
@navaccept header Accept *text/html*
${comms.replace('/communications*', '/clinic*').replace('@dest', '@navdest').replace('@pages', '@navaccept')}`);
test('shared single-line navigation matchers are supported', () => assert.deepEqual(check({ viteSource: navigationVite, caddySource: navigationCaddy }), []));
test('F12 shared Accept wildcard refuses each affected route', () => finding({ viteSource: navigationVite, caddySource: navigationCaddy.replace('@navaccept header Accept *text/html*', '@navaccept header Accept *') }, 'page-predicate', '/clinic'));
test('F14 shared navigation block requires both alternatives', () => finding({ viteSource: navigationVite, caddySource: navigationCaddy.replace('handle @navaccept {\n rewrite * /index.html\n file_server\n}', '') }, 'page-predicate', '/clinic'));
test('F15 shared matcher extra header refuses', () => finding({ viteSource: navigationVite, caddySource: navigationCaddy.replace('@navdest header Sec-Fetch-Dest document', '@navdest {\nheader Sec-Fetch-Dest document\nheader X-Other yes\n}') }, 'page-predicate', '/clinic'));
test('GET constraint is allowed only on communications page matchers', () => finding({ viteSource: navigationVite, caddySource: navigationCaddy.replace('@navdest header Sec-Fetch-Dest document', '@navdest {\nheader Sec-Fetch-Dest document\nmethod GET\n}') }, 'page-predicate', '/clinic'));
test('changed destination value is refused', () => finding({ caddySource: caddy.replace('Sec-Fetch-Dest document', 'Sec-Fetch-Dest iframe') }, 'page-predicate'));
test('unknown Vite destination value refuses parsing', () => finding({ viteSource: proxy().replace('=== "document"', '=== "iframe"') }, 'parse'));

test('duplicate Vite bypass cannot hide an overriding condition', () => finding({ viteSource: proxy().replace('bypass(req) {', 'bypass(req) { return "/index.html"; }, bypass(req) {') }, 'parse'));
test('Vite spread cannot override recognized bypass', () => finding({ viteSource: proxy().replace('bypass(req) {', '...override, bypass(req) {') }, 'parse'));
test('quoted bypass names still receive predicate validation', () => finding({ viteSource: proxy().replace('bypass(req)', '"bypass"(req)').replace('.includes("text/html")', '.includes("anything")') }, 'parse'));

test('duplicate Vite target cannot override the validated destination', () => finding({ viteSource: proxy().replace('"/watchers": { target: mcpTarget }', '"/watchers": { target: mcpTarget, target: "http://localhost:8103" }') }, 'parse'));
