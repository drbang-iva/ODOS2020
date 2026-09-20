# S3a REV 2 — full-suite allowlist blocker

NOT EVALUATED

The REV 2 corrections were implemented. The full UI suite exposes one additional allowlist dependency. Work stopped under kickoff §1.3, §1.5 and §1.10; the existing assertion was not edited or bypassed. Historical BLOCKED.md and premise-probe.mjs remain intact.

## Identity and required scope expansion

- Branch: `drbang-iva/followup-s3a-profiles`.
- HEAD/base: `b217714c2f8963a3c87d537fd00910133257c2a8`.
- Application and evidence changes are uncommitted. No push or PR.
- Needed outside §4: `ui/tests/clinicalGraphRouting.test.tsx:41`.
- The existing test inventories source files calling `clinicalGraphApiBase()` and asserts exactly 56 callers. The required new profile API client correctly uses that shared helper and becomes caller 57. All per-caller import and non-duplication assertions remain applicable.
- Proposed narrow correction: update the enforced caller count from 56 to 57, retaining every other assertion. This has NOT been applied. Renaming/aliasing the helper to evade the inventory would conceal the new caller and is not an acceptable workaround.

## Verification results

Full UI command, before and after: `npm --prefix ui test`.

```text
base:  tests 1808; pass 1808; fail 0; skipped 0
after: tests 1811; pass 1810; fail 1; skipped 0
base 1808 + added 3 = total 1811
not ok - clinical-graph requests share the literal Vite route and Medplum authorization helpers
Expected values to be strictly equal: 57 !== 56
```

Full MCP command from each checkout's mcp directory, matching the CI full-suite invocation, with ODOS_POSTGRES_URL set to the disposable stack's synthetic Postgres:

```sh
node --import tsx --test --test-concurrency=1 'src/__tests__/**/*.test.ts' 'tests/**/*.test.ts' '../tests/boundaries/**/*.test.ts' '../tests/observation-status-machine/**/*.test.ts' '../tests/setup-wizard/**/*.test.ts' '../tests/preflight/**/*.test.ts' '../tests/smart/**/*.test.ts' '../tests/cds/**/*.test.ts' '../tests/agentops/**/*.test.ts' '../tests/bulk-data/**/*.test.ts' '../tests/mandate-8/**/*.test.ts'
```

```text
base:  tests 6144; pass 6089; fail 0; skipped 55
after: tests 6159; pass 6104; fail 0; skipped 55
base 6144 + added 15 = total 6159
```

The 55 skips are existing gated tests, not newly skipped assertions. This does not claim credentialed live-authorization coverage. Earlier attempts to combine all MCP lanes using the npm wrapper failed because the disposable database was initially absent and then restricted practice credentials/global project configuration were inappropriate for that combined invocation. No test or guard was changed to resolve those attempts; the repository's CI lane separation was used.

`npx tsc --noEmit` in ui and mcp: exit 0 before and after.
`npm run preflight`: before and after, 0 warnings, 0 blocks, exit 0.
MCP/UI production build: exit 0.
`git diff --check`: exit 0.

## Guards and real-stack proof

G1–G8 and three additional Settings mutations: all 15 deliberate breaks exit 1; all 15 restored checks exit 0. Commands, quoted summaries and original/mutant hashes are in [mutations.json](mutations.json), reproduced by [mutations.mjs](mutations.mjs). The three revised G5 cases are independently covered: stale caller version, competing new profiles, and competing first seed overlays.

G1 resides in `mcp/src/__tests__/follow-up-profile-keys.test.ts`; it reads the actual ocular-health builders, constructor group seeds, and the UI BuiltInSectionId type through the TypeScript AST. G2 enforces the seed orderables; seed keys are not an unenforced list.

G9 remains a verification, not a mutation. No chart implementation file changed, and every base UI test remains present unchanged. G9 is NOT green because of the caller-count assertion above.

Proof 1–3: not completed. Proposed Settings/browser proof stopped at this full-suite gate.
Proof 4: only the base chart screenshots at 1440 and 390 were captured; see browser-before.json and screenshots/. No before/after visual equivalence claim is made.
Proof 5: results above; full UI is blocked.

P1–P10 premise evidence and unavailable source keys remain in historical BLOCKED.md. REV 2 supersedes that document's P1 concurrency model and G9 count interpretation. The new store follows exam-scope-store's caller-version/conditional-create pattern; the section-group store is unchanged.

## Files, scope and remaining risks

Changed application files are precisely the nine new application/test files and four narrow existing-file edits authorized in §4: new profile store, endpoint, extension, Settings component, API client, store test, endpoint test, key test and Settings test; edits to index.ts, registry.json, Caddyfile and ChartFieldsSettings.tsx. Evidence and proof helpers are confined to this build-log directory. No CSS file changed. No outside-allowlist file was edited.

The implementation remains uncommitted and has not completed live Settings persistence/reset/read-only proof or independent evaluation. The existing section-group concurrency weakness remains an operator follow-up. The new top-level endpoint has the required Caddy block; a Vite proxy addition is outside the current allowlist and remains a development-route follow-up to assess. No decision file is repaired by this catalogue-only slice; no companion file or decisions index was changed. Mandate 14 ledger additions: 0; no new medical/billing code or interval was asserted.

NOT DONE, intentionally: shape record; What are we following picker; board reading profiles; test queue; right-panel Follow-up tab; changes to visit opening or rendering.

## Cleanup

`node docs/build-log/followup-s3a-profiles/proof/stack.mjs stop` exited 0. Task containers stopped; synthetic volumes retained for resumption.

```sh
docker ps --filter name=odos-s3a- --format 'table {{.Names}}\t{{.Status}}'
```

```text
NAMES     STATUS
```

Coded-by: Codex — gpt-6-astra, high effort

blocked
