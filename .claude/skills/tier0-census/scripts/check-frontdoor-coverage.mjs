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
  if (tree.children.some(n => n.children === null) || ['route', 'handle_path', 'import'].some(name => descendants(tree, name).length)) throw new Error('unsupported Caddy routing directive');
  for (const node of site.children) {
    if (!['root', 'encode', 'handle'].includes(node.words[0]) && !node.words[0]?.startsWith('@')) throw new Error('unsupported Caddy site directive');
    if (node.words.join(' ') === 'handle' && (!node.children || node.children.length !== 2 || node.children.some(n => n.children !== null) || !sameSet(node.children.map(n => n.words.join(' ')), ['try_files {path} /index.html', 'file_server']))) throw new Error('unsupported SPA fallback shape');
  }
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

function syntaxShape(node) {
  if (ts.isParenthesizedExpression(node)) return syntaxShape(node.expression);
  const children = [];
  ts.forEachChild(node, child => { children.push(syntaxShape(child)); });
  return [node.kind, ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) ? node.text : null, children];
}

function navigationPredicates(bypass, prefix, paths) {
  const fail = () => { throw new Error(`unrecognizable Vite bypass condition for ${prefix}`); };
  if (!ts.isMethodDeclaration(bypass) || bypass.modifiers?.length || bypass.asteriskToken || bypass.parameters.length !== 1 || !ts.isIdentifier(bypass.parameters[0].name) || !bypass.body || bypass.body.statements.length !== 1) return fail();
  const request = bypass.parameters[0].name.text;
  const branch = bypass.body.statements[0];
  if (!ts.isIfStatement(branch) || branch.elseStatement) return fail();
  const returns = ts.isBlock(branch.thenStatement) ? branch.thenStatement.statements : [branch.thenStatement];
  if (returns.length !== 1 || !ts.isReturnStatement(returns[0]) || !returns[0].expression || !ts.isStringLiteral(returns[0].expression) || returns[0].expression.text !== '/index.html') return fail();
  const navigation = `${request}.headers["sec-fetch-dest"] === "document" || (${request}.headers.accept || "").includes("text/html")`;
  const condition = prefix === '/communications'
    ? `${request}.method === "GET" && ${JSON.stringify(paths)}.includes(${request}.url?.split("?")[0] ?? "") && (${navigation})`
    : navigation;
  const expected = ts.createSourceFile('condition.ts', `if (${condition}) {}`, ts.ScriptTarget.Latest, true).statements[0].expression;
  if (JSON.stringify(syntaxShape(branch.expression)) !== JSON.stringify(syntaxShape(expected))) return fail();
  let expression = branch.expression;
  if (prefix === '/communications') expression = expression.right;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  const destination = expression.left;
  const accept = expression.right;
  // Read the recognized source literals so matcher expectations share Vite's source of truth.
  const headerName = value => value.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('-');
  return [
    ['header', headerName(destination.left.argumentExpression.text), destination.right.text],
    ['header', headerName(accept.expression.expression.expression.left.name.text), `*${accept.arguments[0].text}*`],
  ];
}

function parseVite(source, warnings) {
  const keys = parseProxyKeys(source, warnings);
  if (!keys.length) throw new Error('zero Vite proxy keys found');
  const ast = ts.createSourceFile('vite.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (ast.parseDiagnostics.length) throw new Error('Vite syntax: ' + ast.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '));
  const tables = [];
  const mcpBindings = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'mcpTarget') mcpBindings.push(node.initializer);
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
    if (fields.some(p => !p.name || (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name)))) throw new Error(`unsupported Vite proxy field for ${prefix}`);
    const target = fields.find(p => p.name.text === 'target');
    const value = target && ts.isPropertyAssignment(target) ? target.initializer : null;
    let expectedTarget;
    if (value && ts.isIdentifier(value) && value.text === 'mcpTarget') {
      const binding = mcpBindings.length === 1 ? mcpBindings[0] : null;
      const fallback = binding && ts.isBinaryExpression(binding) && binding.operatorToken.kind === ts.SyntaxKind.BarBarToken && binding.left.getText(ast) === 'env.ODOS_MCP_PROXY_TARGET' ? binding.right : binding;
      if (!fallback || !ts.isStringLiteral(fallback) || fallback.text !== 'http://localhost:3333') throw new Error('unsupported or changed mcpTarget binding; expected localhost:3333 static fallback');
      expectedTarget = '127.0.0.1:3333';
    }
    else if (value && ts.isStringLiteral(value) && value.text === 'http://localhost:8103') expectedTarget = '127.0.0.1:8103';
    else throw new Error(`unsupported Vite target for ${prefix}`);
    const bypasses = fields.filter(p => p.name.text === 'bypass');
    if (bypasses.length > 1) throw new Error(`duplicate Vite bypass for ${prefix}`);
    const bypass = bypasses[0];
    const pageLists = [];
    function findPaths(n) {
      if (ts.isArrayLiteralExpression(n) && n.elements.every(e => ts.isStringLiteral(e) && e.text.startsWith('/'))) pageLists.push(n.elements.map(e => e.text));
      ts.forEachChild(n, findPaths);
    }
    if (bypass) findPaths(bypass);
    if (prefix === '/communications' && bypass && pageLists.length !== 1) throw new Error('cannot discover /communications bypass page list');
    entries.set(prefix, { expectedTarget, bypass: Boolean(bypass), pages: pageLists[0] ?? [], predicates: bypass ? navigationPredicates(bypass, prefix, pageLists[0] ?? []) : [] });
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
    const entry = vite.get(prefix) ?? (backendFamilies.includes(prefix) ? { expectedTarget: '127.0.0.1:3333', bypass: false, pages: [] } : null);
    if (!entry) continue;
    const proxies = descendants(block, 'reverse_proxy');
    if (!proxies.length || proxies.some(p => p.words.length !== 2 || p.words[1] !== entry.expectedTarget)) add('target-mismatch', prefix, `expected reverse_proxy ${entry.expectedTarget}`);
    const handles = block.children.filter(n => n.words[0] === 'handle');
    const pages = handles.filter(h => descendants(h, 'rewrite').some(r => r.words.join(' ') === 'rewrite * /index.html'));
    const fallbacks = handles.filter(h => h.words.length === 1 && h.children?.length === 1 && h.children[0].words[0] === 'reverse_proxy' && h.children[0].children === null);
    const validPages = pages.length > 0 && pages.every(h => h.children?.length === 2 && h.children.every(n => n.children === null) && sameSet(h.children.map(n => n.words.join(' ')), ['rewrite * /index.html', 'file_server']));
    const validSplit = validPages && fallbacks.length === 1 && handles.length === pages.length + 1 && block.children.length === handles.length;
    const plain = handles.length === 0 && block.children.length === 1 && block.children[0].words[0] === 'reverse_proxy';
    if (entry.bypass ? !validSplit : !plain) add('page-api-split', prefix, entry.bypass ? 'expected nested page rewrite and API proxy' : 'expected plain proxy without page bypass');
    const coveredPredicates = new Set();
    for (const page of pages) {
      const matches = matchers.filter(m => m.words[0] === page.words[1]);
      if (page.words.length !== 2 || matches.length !== 1) { add('parse', prefix, 'unresolved or ambiguous page matcher'); continue; }
      const matcher = matches[0];
      const directives = matcher.children ?? [{ words: matcher.words.slice(1), children: null }];
      const headers = directives.filter(n => n.words[0] === 'header');
      const predicateIndex = (entry.predicates ?? []).findIndex(expected => headers.length === 1 && headers[0].words.length === expected.length && headers[0].words.every((word, i) => word === expected[i]));
      const allowed = directives.every(n => n.children === null && (n.words[0] === 'header' || (prefix === '/communications' && (n.words.join(' ') === 'method GET' || n.words[0] === 'path'))));
      if (predicateIndex < 0 || !allowed || (matcher.children && matcher.words.length !== 1)) add('page-predicate', prefix, `${matcher.words[0]} must contain exactly one Vite navigation predicate and only permitted constraints`);
      else coveredPredicates.add(predicateIndex);
      if (prefix !== '/communications') continue;
      const paths = descendants(matcher, 'path').flatMap(n => n.words.slice(1));
      if (!sameSet(paths, entry.pages)) add('page-path', prefix, `page-path mismatch: expected ${entry.pages.join(', ')}, got ${paths.join(', ')}`);
      const methods = descendants(matcher, 'method').flatMap(n => n.words.slice(1));
      if (methods.length !== 1 || methods[0] !== 'GET') add('page-method', prefix, 'page matcher must require method GET');
    }
    if (entry.bypass && coveredPredicates.size !== entry.predicates.length) add('page-predicate', prefix, 'page handles must cover both Vite navigation predicates');
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
