# Comms proxy proof

Captured on 2026-09-04 from the isolated `claude/comms-proxy-fix` worktree at base `61f3cb37b1267a609ae4be8cc91b07116413afec`. Vite ran on `127.0.0.1:29173` before the change and `127.0.0.1:29174` after it; both targeted a local Express server on `127.0.0.1:28333` that mounted the real `registerTwilioWebhookRoutes`, `registerGhlWebhookRoutes`, and `registerTrackedLinkRoutes` handlers. The tracked-link store contained one synthetic link. No practice data, credentials, or external services were used.

Direct backend controls returned each real handler's response: Twilio and GHL rejected deliberately unsigned synthetic webhook requests with `403 application/json`, while the seeded tracked link returned `302` with `Location: https://destination.example/comms-proof`.

Before the proxy entry, the two webhook POSTs through Vite returned empty `404` responses. The tracked-link GET returned the SPA shell as `200 text/html`. `before.json` records the direct and through-Vite results; the pre-fix assertion that each Vite response must equal its direct-handler control failed first on the Twilio registration with `404 !== 403`.

After adding the plain `/comms` proxy entry, all three through-Vite responses exactly matched their direct-handler controls, including status, content type, redirect location, and body prefix. `after.json` records those results. This proves dev routing to one real route per `/comms` registration; it does not prove valid vendor signatures, downstream event persistence, the public-base-URL path, or production reverse-proxy behavior.

No live UI caller was found. A source search under `ui/` found only TypeScript module paths such as `components/comms/EngageSheet`, not a URL, fetch, navigation, form action, or asset request to `/comms/*`. The repaired gap is therefore dev-proxy completeness for external-inbound webhooks and tracked-link redirects, not a currently broken UI flow.
