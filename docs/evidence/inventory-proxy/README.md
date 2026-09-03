# Inventory proxy proof

Captured on 2026-09-03 from the isolated `claude/inventory-proxy-fix` worktree at base `b13a1b0db2c11a72ded4f5625cdac476869423eb`. Vite ran on `127.0.0.1:27173` before the change and `127.0.0.1:27174` after it; both targeted a local Express server on `127.0.0.1:25333` that mounted the real `handleFrameInventoryAdjustmentRequest` with `authenticate` returning `null`. A distinguishable JSON catch-all verified the backend harness. No practice data or credentials were used.

The direct backend control returned `401 application/json` with `{"error":"Authentication required to adjust inventory."}` for `POST /inventory/frame-units/synthetic-proxy-unit/adjustments`.

Before the proxy entry, the same POST through Vite returned an empty `404` under both fetch and browser-navigation header profiles. Same-path GET controls returned the SPA shell as `200 text/html`, confirming the unproxied `/inventory` family fell through to Vite rather than reaching the backend. `before.json` records all four results; the pre-fix assertion requiring the real handler's `401` response failed.

After adding the plain `/inventory` proxy entry, both POST requests returned the real handler's `401 application/json` response. The same-path GET controls returned `404 application/json` with `{"marker":"real-inventory-backend-catch-all"}`, proving that browser-navigation headers do not bypass the proxy. This proves routing and content type at the unauthenticated boundary; it does not prove authenticated inventory adjustment, FHIR persistence, or production reverse-proxy behavior.
