# Dependency audit gate — author proof

Base: `32ef9fb6e717ad8c509aae80c46fc9c3440f9a68`. Coder: Codex — GPT-6 Astra (high).
NOT EVALUATED. No evaluation marker, merge, alert dismissal, or deployment.

The gate runs `npm audit --audit-level=high --omit=dev --json` for root and MCP.
It reports every direct advisory and severity counts, blocks unaccepted high/critical
advisories, and rejects invalid or expired allowances. Dates use UTC and remain valid
through the stated review day. npm execution/report errors fail closed. The preflight
CI job invokes it without continue-on-error. UI is outside this two-manifest contract.

`security/audit-allowlist.json` is empty: no vulnerability requires acceptance.
D3 proves enforcement with a disposable sharp advisory/allowance pair; it is not a
committed exception or an alert dismissal. The user corrected D2: a moderate finding
must be reported while exit status stays zero.

## Exact dependency operations

All commands ran from the isolated task worktree unless prefixed with `mcp`:

```sh
npm update csv-parse --package-lock-only --ignore-scripts
npm --prefix mcp update sharp js-yaml qs hono --package-lock-only --ignore-scripts
```

Added only this override to MCP's manifest (dependency ranges unchanged):

```json
{"overrides":{"@lhncbc/ucum-lhc":{"csv-parse":"^7.0.2"}}}
```

```sh
npm --prefix mcp install --package-lock-only --ignore-scripts
npm ci
npm --prefix mcp ci
npm --prefix mcp update csv-parse --package-lock-only --ignore-scripts
npm --prefix mcp update qs --package-lock-only --ignore-scripts --prefer-dedupe=false
npm --prefix mcp install hono@4.13.5 --package-lock-only --ignore-scripts --no-save
```

Those latter update attempts retained the stale nested csv-parse entry. Removed only
`packages["node_modules/@lhncbc/ucum-lhc/node_modules/csv-parse"]` from the lockfile to
invalidate that resolution, then let npm regenerate it; no replacement metadata was
handwritten:

```sh
npm --prefix mcp install --package-lock-only --ignore-scripts
npm --prefix mcp update express body-parser qs --package-lock-only --ignore-scripts
npm --prefix mcp ci
```

Express 4.22.2 and body-parser 1.20.6 constrain qs to `~6.15.1`. The targeted parent
updates admit qs 6.16.0 within the existing direct Express range. The initial hono
update selected 4.13.8; to retain the specifically requested 4.13.5, temporarily set
`overrides.hono`, invalidated only its lock entry, regenerated, and removed that
temporary override:

```sh
npm --prefix mcp pkg set overrides.hono=4.13.5
# Remove only packages["node_modules/hono"] from mcp/package-lock.json.
npm --prefix mcp install --package-lock-only --ignore-scripts
npm --prefix mcp pkg delete overrides.hono
npm --prefix mcp ci
npm --prefix mcp ls --all --json
```

The final `npm ls --all` succeeds. No application source changes. PR #617 overlaps
only a separate test script field in mcp/package.json; operator authorized proceeding.

## Audits and supply-chain delta

`proof.json` includes raw before/after audit JSON for full and runtime-only scopes,
every changed package record (versions, integrity, resolved URL and dependency
metadata), and disposable guard outputs. All unlisted package records are identical.

| Audit | Before high / moderate | After high / moderate |
|---|---:|---:|
| root full | 0 / 1 | 0 / 0 |
| MCP full | 2 / 7 | 0 / 0 |
| root runtime | 0 / 1 | 0 / 0 |
| MCP runtime | 1 / 4 | 0 / 0 |

All low, critical and informational counts are zero. npm counts dependency nodes,
whereas GitHub's starting nine alerts count package/advisory pairs.

Direct requested versions: root csv-parse 7.0.1 → 7.0.2; MCP sharp 0.35.3 → 0.35.4,
js-yaml 4.3.1 → 4.3.2, qs 6.15.3 → 6.16.0, hono 4.13.0 → 4.13.5.
Collateral: Express 4.22.2 → 4.22.3 and body-parser 1.20.6 → 1.20.8 admit fixed qs;
16 sharp platform binaries move 0.35.3 → 0.35.4, and ten libvips platform bundles
move 1.3.2 → 1.3.3 with sharp. The nested dev csv-parse 4.16.3 record is removed;
ucum-lhc now deduplicates to the existing MCP csv-parse 7.0.2. Exact package paths
are enumerated below and in proof.json.

## Guards

| Guard | Broken state | Restored |
|---|---|---|
| D1 sharp 0.35.3 | exit 1, GHSA-rgj7-g3m4-5g8c named | exit 0, clean |
| D2 root csv-parse 7.0.1 | exit 0, moderate GHSA-8cw4-87c7-c6xx reported | exit 0, clean |
| D3 delete synthetic accepted sharp entry | accepted state exit 0; deletion exit 1 | exit 0, clean |
| D4 expire entry | exit 1, expired entry named | exit 0, clean |
| D5 omit MCP | 6 pass / 6 fail, including D5 | 12 pass / 0 fail |
| D6 break native image resize dimensions | 2 pass / 1 fail | 3 pass / 0 fail |

Every restore is byte-identical. No mutation landed in application source. Original
TDD: 0/10 → 10/10; added malformed-provenance guard: 11/12 → 12/12. D6 uses the
actual installed sharp 0.35.4 binary and a generated JPEG, not a mock decoder.

## Limitations and follow-ups

The first full local run lacked PostgreSQL (6 failures, 64 skips). A subsequent run
overlapped dependency installation and is invalid evidence (34 failures, 49 skips).
Only the final stable-tree run is used to judge A2. Local live-authorization tests
remain explicitly skipped; the full credentialed CI lane is required separately.

The override crosses three csv-parse major versions inside a dev dependency. A green
suite covers exercised paths, not every upstream API. No exception is accepted for
runtime vulnerabilities. A newly published high advisory may block an unrelated PR;
an operator-approved, dated allowance is the explicit escape hatch.

Sharp is native: deployment must run a real `npm ci` and verify the loaded binary.
No deployment occurs here. Input magic-byte validation is a separate follow-up;
this slice makes no claim about anonymous reachability of upload routes.

## Package-by-package lockfile delta

| Manifest | Package path | Before | After |
|---|---|---|---|
| package-lock.json | node_modules/csv-parse | 7.0.1 | 7.0.2 |
| mcp/package-lock.json | node_modules/@img/sharp-darwin-arm64 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-darwin-x64 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-freebsd-wasm32 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-libvips-darwin-arm64 | 1.3.2 | 1.3.3 |
| mcp/package-lock.json | node_modules/@img/sharp-libvips-darwin-x64 | 1.3.2 | 1.3.3 |
| mcp/package-lock.json | node_modules/@img/sharp-libvips-linux-arm | 1.3.2 | 1.3.3 |
| mcp/package-lock.json | node_modules/@img/sharp-libvips-linux-arm64 | 1.3.2 | 1.3.3 |
| mcp/package-lock.json | node_modules/@img/sharp-libvips-linux-ppc64 | 1.3.2 | 1.3.3 |
| mcp/package-lock.json | node_modules/@img/sharp-libvips-linux-riscv64 | 1.3.2 | 1.3.3 |
| mcp/package-lock.json | node_modules/@img/sharp-libvips-linux-s390x | 1.3.2 | 1.3.3 |
| mcp/package-lock.json | node_modules/@img/sharp-libvips-linux-x64 | 1.3.2 | 1.3.3 |
| mcp/package-lock.json | node_modules/@img/sharp-libvips-linuxmusl-arm64 | 1.3.2 | 1.3.3 |
| mcp/package-lock.json | node_modules/@img/sharp-libvips-linuxmusl-x64 | 1.3.2 | 1.3.3 |
| mcp/package-lock.json | node_modules/@img/sharp-linux-arm | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-linux-arm64 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-linux-ppc64 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-linux-riscv64 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-linux-s390x | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-linux-x64 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-linuxmusl-arm64 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-linuxmusl-x64 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-wasm32 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-webcontainers-wasm32 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-win32-arm64 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-win32-ia32 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@img/sharp-win32-x64 | 0.35.3 | 0.35.4 |
| mcp/package-lock.json | node_modules/@lhncbc/ucum-lhc/node_modules/csv-parse | 4.16.3 | removed |
| mcp/package-lock.json | node_modules/body-parser | 1.20.6 | 1.20.8 |
| mcp/package-lock.json | node_modules/express | 4.22.2 | 4.22.3 |
| mcp/package-lock.json | node_modules/hono | 4.13.0 | 4.13.5 |
| mcp/package-lock.json | node_modules/js-yaml | 4.3.1 | 4.3.2 |
| mcp/package-lock.json | node_modules/qs | 6.15.3 | 6.16.0 |
| mcp/package-lock.json | node_modules/sharp | 0.35.3 | 0.35.4 |

## Final local A2 result

5,557 tests: **5,505 passed, 0 failed, 52 skipped**. The override is retained.
The owned synthetic PostgreSQL container was stopped and removed. Final preflight:
0 warnings / 0 hard blocks; script and MCP typechecks passed.
