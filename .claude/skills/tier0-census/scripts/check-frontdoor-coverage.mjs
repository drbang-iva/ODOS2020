#!/usr/bin/env node
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { discoverBackendRouteFamilies } from './discover-backend-routes.mjs';
import { parseProxyKeys } from './check-proxy-coverage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function parseCaddy(source) {
  const tree = { words: [], children: [] };
  const stack = [tree];
  let words = [];
  const flush = () => {
    if (words.length) stack.at(-1).children.push({ words, children: null });
    words = [];
  };
  const tokenPattern = /#[^\n]*|"(?:\\.|[^"\\])*"|\{[^\s{}]+\}|[{}\n]|[^\s{}"]+/g;
  const tokens = [];
  let end = 0;
  for (const match of source.matchAll(tokenPattern)) {
    if (source.slice(end, match.index).trim()) throw new Error('unrecognized Caddy token or unterminated string');
    tokens.push(match[0]);
    end = match.index + match[0].length;
  }
  if (source.slice(end).trim()) throw new Error('unrecognized Caddy token or unterminated string');
  for (const token of tokens) {
    if (token.startsWith('#')) continue;
    if (token === '\n') { flush(); continue; }
    if (token === '{') {
      const node = { words, children: [] };
      stack.at(-1).children.push(node);
      stack.push(node);
      words = [];
    } else if (token === '}') {
      flush();
      if (stack.length === 1) throw new Error('unmatched closing Caddy brace');
      stack.pop();
    } else words.push(token.startsWith('"') ? JSON.parse(token) : token);
  }
  flush();
  if (stack.length !== 1) throw new Error('unmatched opening Caddy brace');
  const sites = tree.children.filter(n => n.children && n.words.length);
  if (sites.length !== 1) throw new Error('expected exactly one Caddy site block');
  const site = sites[0];
  const routes = new Map();
  for (const node of site.children.filter(n => n.words[0] === 'handle' && n.words.length > 1)) {
    if (!node.children || node.words.length !== 2 || !/^\/[\w-]+\*$/.test(node.words[1])) throw new Error('unsupported front-door handle matcher');
    const prefix = node.words[1].slice(0, -1);
    if (routes.has(prefix)) throw new Error(`duplicate front-door block ${prefix}`);
    routes.set(prefix, node);
  }
  if (!routes.size) throw new Error('zero front-door route blocks found');
  return { routes, matchers: site.children.filter(n => n.words[0]?.startsWith('@')) };
}

function parseVite(source, warnings) {
  const keys = parseProxyKeys(source, warnings);
  if (!keys.length) throw new Error('zero Vite proxy keys found');
  const ast = ts.createSourceFile('vite.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (ast.parseDiagnostics.length) throw new Error('Vite syntax: ' + ast.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '));
  const tables = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'proxy' && ts.isObjectLiteralExpression(node.initializer)) tables.push(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (tables.length !== 1) throw new Error('expected exactly one Vite proxy object');
  const entries = new Map();
  for (const prop of tables[0].properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteral(prop.name) || !ts.isObjectLiteralExpression(prop.initializer)) throw new Error('unsupported Vite proxy entry');
    const prefix = prop.name.text;
    if (!keys.includes(prefix) || entries.has(prefix)) throw new Error(`Vite key discovery disagreement or duplicate: ${prefix}`);
    const fields = prop.initializer.properties;
    const target = fields.find(p => p.name?.getText(ast) === 'target');
    const value = target && ts.isPropertyAssignment(target) ? target.initializer : null;
    let expectedTarget;
    if (value && ts.isIdentifier(value) && value.text === 'mcpTarget') expectedTarget = '127.0.0.1:3333';
    else if (value && ts.isStringLiteral(value) && value.text === 'http://localhost:8103') expectedTarget = '127.0.0.1:8103';
    else throw new Error(`unsupported Vite target for ${prefix}`);
    const bypass = fields.find(p => p.name?.getText(ast) === 'bypass');
    const pageLists = [];
    function findPaths(n) {
      if (ts.isArrayLiteralExpression(n) && n.elements.every(e => ts.isStringLiteral(e) && e.text.startsWith('/'))) pageLists.push(n.elements.map(e => e.text));
      ts.forEachChild(n, findPaths);
    }
    if (bypass) findPaths(bypass);
    if (prefix === '/communications' && bypass && pageLists.length !== 1) throw new Error('cannot discover /communications bypass page list');
    entries.set(prefix, { expectedTarget, bypass: Boolean(bypass), pages: pageLists[0] ?? [] });
  }
  if (entries.size !== keys.length) throw new Error('Vite key discovery disagreement');
  return entries;
}

function descendants(node, directive) {
  return (node.children ?? []).flatMap(child => [ ...(child.words[0] === directive ? [child] : []), ...descendants(child, directive) ]);
}
const sameSet = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

export function checkFrontdoorCoverage({ backendFamilies, viteSource, caddySource, exclusions, discoveryWarnings = [] }) {
  const findings = [];
  const add = (type, prefix, message) => findings.push({ type, prefix, message });
  for (const warning of discoveryWarnings) add('parse', '', warning);
  if (!backendFamilies.length) add('parse', '', 'zero backend families discovered');
  let routes, matchers, vite;
  try { ({ routes, matchers } = parseCaddy(caddySource)); }
  catch (err) { add('parse', '', err.message); }
  const warnings = [];
  try { vite = parseVite(viteSource, warnings); }
  catch (err) { add('parse', '', err.message); }
  for (const warning of warnings) add('parse', '', warning);
  const excluded = new Set();
  if (!Array.isArray(exclusions)) add('invalid-exclusion', '', 'exclusions must be an array');
  else for (const entry of exclusions) {
    if (!entry || typeof entry.prefix !== 'string' || !/^\/[\w-]+$/.test(entry.prefix) || typeof entry.reason !== 'string' || !entry.reason.trim() || excluded.has(entry.prefix)) {
      add('invalid-exclusion', entry?.prefix ?? '', 'exclusion requires a unique prefix and non-empty reason');
      continue;
    }
    excluded.add(entry.prefix);
    if (routes?.has(entry.prefix)) add('excluded-but-routed', entry.prefix, 'excluded prefix has a front-door block');
    if (vite && !vite.has(entry.prefix) && !backendFamilies.includes(entry.prefix)) add('stale-exclusion', entry.prefix, 'exclusion exists in neither backend nor Vite');
  }
  if (!routes || !vite) return findings;
  for (const prefix of backendFamilies) if (!routes.has(prefix) && !excluded.has(prefix)) add('missing-backend', prefix, 'backend family has no front-door block');
  for (const prefix of vite.keys()) if (!routes.has(prefix) && !excluded.has(prefix)) add('missing-vite', prefix, 'Vite proxy key has no front-door block');
  for (const [prefix, block] of routes) {
    if (!vite.has(prefix) && !backendFamilies.includes(prefix)) add('stale-route', prefix, 'front-door block exists in neither backend nor Vite');
    const entry = vite.get(prefix);
    if (!entry) continue;
    const proxies = descendants(block, 'reverse_proxy');
    if (!proxies.length || proxies.some(p => p.words.length !== 2 || p.words[1] !== entry.expectedTarget)) add('target-mismatch', prefix, `expected reverse_proxy ${entry.expectedTarget}`);
    const handles = block.children.filter(n => n.words[0] === 'handle');
    const pages = handles.filter(h => descendants(h, 'rewrite').some(r => r.words.join(' ') === 'rewrite * /index.html'));
    const nestedProxy = handles.some(h => descendants(h, 'reverse_proxy').length);
    const plain = handles.length === 0 && block.children.length === 1 && block.children[0].words[0] === 'reverse_proxy';
    if (entry.bypass ? !pages.length || !nestedProxy : !plain) add('page-api-split', prefix, entry.bypass ? 'expected nested page rewrite and API proxy' : 'expected plain proxy without page bypass');
    for (const page of pages) {
      const matches = matchers.filter(m => m.words[0] === page.words[1]);
      if (page.words.length !== 2 || matches.length !== 1) { add('parse', prefix, 'unresolved or ambiguous page matcher'); continue; }
      if (prefix !== '/communications') continue;
      const matcher = matches[0];
      const paths = descendants(matcher, 'path').flatMap(n => n.words.slice(1));
      if (!sameSet(paths, entry.pages)) add('page-path', prefix, `page-path mismatch: expected ${entry.pages.join(', ')}, got ${paths.join(', ')}`);
      const methods = descendants(matcher, 'method').flatMap(n => n.words.slice(1));
      if (methods.length !== 1 || methods[0] !== 'GET') add('page-method', prefix, 'page matcher must require method GET');
    }
  }
  return findings;
}

export function main() {
  try {
    const backend = discoverBackendRouteFamilies();
    const findings = checkFrontdoorCoverage({
      backendFamilies: backend.families,
      discoveryWarnings: backend.warnings,
      viteSource: readFileSync(resolve(root, 'ui/vite.config.ts'), 'utf8'),
      caddySource: readFileSync(resolve(root, 'deploy/frontdoor/Caddyfile'), 'utf8'),
      exclusions: JSON.parse(readFileSync(resolve(root, 'deploy/frontdoor/exclusions.json'), 'utf8')),
    });
    for (const finding of findings) console.log(`! ${finding.type}${finding.prefix ? ` ${finding.prefix}` : ''}: ${finding.message}`);
    console.log(`Front-door route parity: ${findings.length} finding(s); ${findings.length ? 'FAIL' : 'PASS'} (blocking).`);
    return findings.length ? 1 : 0;
  } catch (err) {
    console.log(`! parse: ${err.message}`);
    console.log('Front-door route parity: FAIL (blocking).');
    return 1;
  }
}
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main();
