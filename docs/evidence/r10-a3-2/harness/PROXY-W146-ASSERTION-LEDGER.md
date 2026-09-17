# W146 proxy authority guard — author verification

CodeQL finding267 identified a real harness SSRF path: `new URL(incoming.url, destination)` allowed a raw absolute or authority-form target to replace the configured upstream host. This repair is confined to the disposable response proxy and its tests. CodeQL status must be checked on the new scan; these tests do not establish a cleared CodeQL result.

## Assertions added

| W row | Before | After |
|---|---|---|
| W146 | No raw request-target authority test; an absolute target, network-path target and slash/backslash target reached a second local server | Six raw Node HTTP request targets are rejected400; the second local spy receives0 requests and configured upstream receives0 rejected requests |
| W146 | No assertion that query strings survive fixed-host forwarding | Valid origin-form path with encoded URL query and repeated eye parameters reaches the configured local upstream byte-for-byte; the spy still receives0 requests |
| W146 | Existing response-drop test | Unchanged: exactly one matching response is dropped only after upstream completion, and the next identical request succeeds |

The proxy now validates origin-form targets before handling the drop selector and constructs `http.request` with fixed `hostname` and `port` from the configured destination. The incoming target supplies only `path`. Absolute/authority-form targets, leading double slash, literal backslash and fragment targets are refused400.

## Red / green and mutation

Command: `node --test scripts/r10-served-route/harness.test.mjs`.

- New test before repair:4 tests,3 pass,1 fail; raw absolute/authority/backslash requests escaped to the second local spy. `proxy-authority-red.tap`.
- Implemented repair:4 tests,4 pass,0 fail. `proxy-authority-green.tap`.
- Exact vulnerable-behavior mutant: remove the origin-form refusal and restore `new URL(incoming.url, destination)` as the request destination. Both source anchors were required to occur exactly once; a missing or duplicated anchor raises an explicit error. Result:4 tests,3 pass,1 fail at the zero-escape assertion. `proxy-authority-mutation-red.tap`.
- Source restored in `finally`, then4 tests,4 pass,0 fail. `proxy-authority-restored-green.tap`; restoration hash and counts are in `proxy-authority-mutation.json`.

NOT EVALUATED. This is author verification, not the independent Claude Opus verdict.
