# T22 MCP runtime helper — author evidence

Implemented `runMcpWritePaths(): Promise<McpWritePathEvidence[]>` in `mcp/tests/fixtures/r10/mcp-write-paths.ts`, with the bounded synthetic transport in `mcp-runtime-transport.ts`. The helper imports no registering test module. It returns the common `WritePathEvidence` fields plus `controls`, `builderControls`, and separately classified `patchProjections`.

All 11 MCP semantic IDs execute the actual `index.ts` createServer dispatch through the MCP SDK Server, Client, and InMemoryTransport. Exact AST declaration checks select the production schemas/helpers; positive mode uses actual production builders, sidecars, guards, and an actual FhirFindingDefinitionStore. Fixed output injection exists only in explicitly named adversarial controls and retains valid production-schema input.

## Author checks

- Initial red: the probe required every ID while the unimplemented helper returned none; named assertion failed (`mcp-runtime-red.txt`).
- Final positive paths: **11/11**, **34 attempted / 34 persisted resource writes**, **15 persisted Observation versions**. The lifecycle rows each comprise a real canonical fact and panel, and each has exactly two Binary PATCH attempts plus two Provenance PUT attempts. Four patch-result projections are separate metadata, not extra network writes.
- **63 zero-write refusal controls:** 50 shared-body/source/result cases (canonical, panel, negative, legacy-shared, and stored-only shared), two lifecycle legacy-target refusals, and 11 invalid-schema controls. The row's primary `rejection` is a shared-body/legacy refusal; schema refusal is explicitly separate.
- **6 additional real-builder controls:** create VA/refraction, save-section VA/refraction, repeated IOP save proving conditional BodyStructure reuse, and axial-length-only capture without optional radius.
- **5/5 synthetic transport controls:** stale If-Match, failed JSON Patch status test, unsupported operation, successful note-append/status patch counted once, and staging refusal without persistence. This verifies the test transport; it does not assert backend transaction atomicity.
- Strict standalone TypeScript check of both new fixtures: exit 0, empty diagnostics (`mcp-runtime-types.txt`).
- **W114: 11/11 named mutants red (exit 1), all 11 restored green (exit 0)**. The mutants replace one exact tool case's effective definition lookup with the actual store's compiled `seeds`. Generic tools then incorrectly accept the stored-only shared body; lifecycle tools incorrectly reject the canonical practice-only option. Both are designated behavioral assertions, not missing symbol/schema errors.

Every mutation verified exactly one enclosing case and exactly one lookup, and restored `mcp/src/index.ts` byte-for-byte in finally. SHA-256 before and after: `96cd021380dc935871ce38f22b3b1b58ab3a2517bdc915446ca1419e30002fd5`. Each per-tool JSON has executed and replay commands; each red/green log is in `mutations/`. The published probe is the same assertion script with only its relative helper import adjusted from the private working copy.

## Assertion mapping

No existing assertion was removed or changed; these are new reusable fixture assertions and isolated probes.

| New assertion group | Contract |
|---|---|
| Every fixed MCP ID executes a successful real dispatch, with attempted and persisted Observation evidence | §3.11 / T22; W87a registry coverage is integrated by parent |
| Every actual builder result, persisted Observation version, and separate Binary-patch projection is classified using the effective store; no invalid/legacy result in successful calls | §3.11 / T22 |
| Successful unrelated generic/specialty writes, actual sidecar counts, persistent derivedFrom/focus/body references, optional second eye-growth write | V35 / §3.13 |
| Canonical fact and panel attest/amend after Encounter finish; preserve identifier, components, homes/extensions, code and boolean; version advances and amendment note persists | V35 / W115 |
| Generic create/scribe/save-section and all five specialties refuse five shared body classes before associated writes; append refuses each shared source/result | V35 / W116; stored-only variants also W114 |
| Stored-only definition actually merges; practice-added option exists in effective catalog and survives real lifecycle writes | W114 |
| Exact Binary patch request, If-Match and actual patch-result evidence; no double-counted synthetic writes | §3.11 / T22 / W129; static census mutations owned by parent |
| Exact AST selectors and same-type transaction write attribution remain unambiguous | §3.11 real-dispatch evidence integrity |
| Production schema invalid input refuses with zero writes | §3.13 supplemental input-boundary controls, not shared-body proof |
| Synthetic transport If-Match, JSON Patch status test and explicit unsupported-operation handling | Evidence integrity only; no live FHIR/server guarantee |

## Replay

From the worktree root:

```sh
mcp/node_modules/.bin/tsx docs/evidence/r10-a3-1/mcp-runtime/verify.ts
mcp/node_modules/.bin/tsx docs/evidence/r10-a3-1/mcp-runtime/verify-transport.ts
node docs/evidence/r10-a3-1/mcp-runtime/mutate-definitions.mjs
mcp/node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --esModuleInterop --skipLibCheck --types node mcp/tests/fixtures/r10/mcp-write-paths.ts mcp/tests/fixtures/r10/mcp-runtime-transport.ts
```

The mutation runner temporarily edits index.ts: coordinate an exclusive mutation window before replay. It restores bytes even on failed proof.

## Scope and limits

Only the two new fixture helpers and this author evidence were added by this task. The common write recorder is owned by the consumer agent. Release scenarios, checker, registry, and application source retain their owners; the temporary index mutations left no net edit. No commits, live calls, or evaluation marker were produced. MCP responseStatus in the shared evidence shape is a normalized success/refusal category; actual SDK results and refusal text are retained, not an HTTP transport assertion. Tool-list publication is not exercised (`tools: []`). Synthetic transport proof does not establish server atomicity, AccessPolicy enforcement, or live FHIR JSON Patch behavior.
