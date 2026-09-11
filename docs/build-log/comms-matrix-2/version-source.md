# S1 real-server version proof

The earlier location-only assumption is resolved by the approved source order: matching returned Patient resource first, history-location fallback, disagreement or neither source means omit. No version arithmetic or server-side fresh-read substitution is used.

The repository-pinned Medplum 5.1.30 accepted a conditional Patient transaction and returned a bare `Patient/<id>` location plus an embedded resource with an opaque version. The parser's `writtenAgainst` matched the submitted If-Match; `current` matched the embedded resource and a subsequent read. The synthetic Patient remains inactive.

[Exact output](checks/live-version-source.log) · [Executable proof](prove-version-source.ts)

Run against a disposable local synthetic stack with `ODOS_MATRIX_BASE_URL`, `ODOS_MATRIX_ADMIN_EMAIL` and `ODOS_MATRIX_ADMIN_PASSWORD` supplied securely in the environment:

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs docs/build-log/comms-matrix-2/prove-version-source.ts
```

Own exit: 0. The script creates an inactive synthetic Patient, changes its synthetic name in a conditional transaction, and verifies both version fields. The fresh read is a proof assertion only, not the server's version source. The production dialog independently performs the D1 fresh-read equality check.

M5a removes the resource source and fails the real-shaped route tests. M5b ignores source disagreement and fails the disagreement tests. Both restored runs pass 111/111; see the mutation packet. The four route contracts also cover no-source omission and history fallback; opt-out no-ops return equal opaque versions.
