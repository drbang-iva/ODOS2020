# Watcher proxy proof

Captured on 2026-09-03 from the isolated `claude/watchers-proxy-fix` worktree against a disposable local Medplum project, MCP server on `127.0.0.1:23333`, and Vite on `127.0.0.1:25173`. No practice data or retained credentials appear here.

At base `d805c51e72d3abf9c340188490ce45d86f7ad1fd`, both a normal fetch and a request with browser-navigation headers returned `200 text/html` for `GET /watchers/work`; `before.json` records the response metadata and first 100 body characters. The pre-fix assertion expecting the real backend rejection failed with `200 !== 401`.

After adding the plain `/watchers` proxy entry, `after.json` records eight requests through Vite: the three watcher GET routes and the task-action POST route, each sent once with fetch headers and once with browser-navigation headers. All eight reached the real MCP route and returned `401 application/json` with `{"error":"Authentication required for watcher alerts."}`. This proves routing and content type for unauthenticated requests; it does not prove authenticated watcher behavior.

`route-census.json` is a one-off TypeScript AST comparison of the 24 `register*Routes(app, ...)` call sites in `mcp/src/index.ts` against Vite's proxy prefixes. It found 148 route patterns in the imported modules. After this fix, `/comms` and `/communications` remain unproxied. The scan does not cover direct routes declared in `index.ts`, nested routers, the Iris Caddyfile, or runtime health.
