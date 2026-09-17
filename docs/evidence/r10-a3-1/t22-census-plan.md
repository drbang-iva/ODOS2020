# §3.11 T22 census / registry implementation plan (read-only reconnaissance)

No registry/checker code changed. This plan is for the later §3.11 beat, after consumer paths stabilize.

## Observed inventory and gaps

Ran `.odos/r10-a3-1/write-census-inventory.mjs` against the current task worktree. Output `write-census-inventory.json`, `write-census-inventory-summary.json`: **72 candidate sites, 38 files**, including 13 index dispatch sites. These are candidates, not 72 proven Observation writers: the reconnaissance deliberately includes every executeTransaction and executeTransactionAsActor. In index, `tool:mark_condition_entered_in_error` is a Condition-only transaction candidate and must be explicitly excluded after body inspection. The other 12 index sites are Observation paths (11 tools; eye growth has two sites).

The current inventory is insufficient as the final census:

1. It only inventories CALL expressions. It does not inventory Binary/Observation transaction entry object literals in `buildAttestationTransaction`, `buildAmendmentTransaction`, `buildAppendObservationTransaction`, `buildSectionSaveBundle`, or endpoint-generated bundles. W129 would otherwise be decorative.
2. The known protocol wrappers `updateProjected` and `projectionRestore` evade its member-call rule: `updateProjected` aliases `fhir.update` into a local `update` function, and restore invokes the wrapper with a variable resourceType. Inventory those call sites explicitly, including a stable function/ordinal identity.
3. FHIR wrappers in `fhir-client.ts` accept generic Resource inputs; final census must state where generic transport ends and domain sites begin, with explicit exclusion reasons instead of silently omitting them.
4. Shared writer mechanics support multiple semantic paths. A path id is not a one-to-one source-file list. The fact writer update/create sites serve door-put, oh-save-fact and carry-facts; the panel mechanic serves oh-save-panel; audit-repair is Provenance-only. The registry must cover every semantic path with a real handler scenario even where one mechanic is shared.
5. Consumers are still being implemented. Re-run inventory after §3.4–§3.8 land; do not freeze line numbers/counts from this snapshot.

## Fixed semantic path IDs

Define an independent frozen id list in executable test/checker code. Do not derive it from JSON.

Contract's 22 IDs:
`door-put`, `door-audit-repair`, `pick-condition`, `oh-save-fact`, `oh-save-panel`, `oh-negative-act`, `carry-condition`, `carry-plan`, `carry-link`, `carry-facts`, `carry-lineage`, `void`, `undo`, `protocol-commit`, `protocol-unapply`, `protocol-restore`, `mcp-attest`, `mcp-amend`, `mcp-create-observation`, `mcp-scribe-write`, `mcp-append-context`, `mcp-save-section`.

Five observed specialty IDs (recommended literal names):
`mcp-smoking-status`, `mcp-dry-eye-questionnaire-score`, `mcp-meibography`, `mcp-ortho-k-fit`, `mcp-eye-growth`.

Total expected semantic IDs from this census: **27**. `mcp-eye-growth` covers two distinct call-site ordinals; test both the axial and optional corneal outputs, including refusal of a prohibited second output before the first is written. Questionnaire and meibography tests also assert zero earlier associated-resource writes on refusal.

## Registry structure and exact call-site identities

`finding-write-paths.json`: each semantic id has its scenario locator and explicit sites. A site key is `{file,function,ordinal,kind}`; line is diagnostic only, not identity. Multiple path ids may explicitly share a mechanic site; do not require one id per physical site. Each discovered site must have at least one explicit path mapping OR one explicit exclusion, never both. Reject duplicate mappings within a path and duplicate exclusion keys. Exclusions need a substantive reason and exact key, never file-wide or function-wide wildcards.

Source owner names should be deterministic: named function/method; MCP case owner `tool:<tool name>`; transaction entry constructions retain their builder/endpoint owner. Separate candidate kinds: `resource-write`, `transaction-submit`, `observation-entry`, `observation-json-patch-entry`, `known-wrapper-call`. Ordinals count matching candidate sites within owner and kind, not every arbitrary call. This catches a newly added second Observation/Binary entry inside an already registered function.

Use TypeScript AST/type checker for the direct writes already recognized by reconnaissance. Add transaction entry detection for an Observation resource by inferred `resourceType`/explicit discriminant, and Binary JSON Patch resources whose request URL targets an Observation, including builder forms (`jsonPatchBinaryResource`, `versionAwareRequest(observation,"PATCH",observationReference(observation))`). Register those known wrappers by executable matcher, not by trusting a comment. Scan all `mcp/src` and reject any new discovered key not classified. Document that this does not prove arbitrary dataflow or aliases beyond the registered wrapper patterns.

Known lifecycle entry sites in unchanged `mcp/src/fhir/scribeAttestation.ts`:
- `buildAttestationTransaction`: Binary PATCH Observation, Provenance PUT.
- `buildAmendmentTransaction`: Binary PATCH Observation, Provenance PUT.
- `buildAppendObservationTransaction`: Observation PUT plus Provenance entries.
Only Observation writes/patch entries participate; retain transaction-submit sites separately to catch alternate submission paths.

## T22 runtime scenarios

Real endpoint handlers for door, pick, capture, carry, void, undo and protocol. Real production createServer/CallTool registration through SDK transport for MCP; for lifecycle use real builders. Reuse the new §3.13 dispatch harness but move reusable harness code to a fixture rather than importing a test file (which registers extra tests and would violate the release checker's expected T-slot count).

Per semantic ID, record attempted writes separately from persisted writes; apply transaction responses and JSON Patch to in-memory resource state (not just recording a Binary). Classify every resulting Observation with effective stored definitions + current catalog. Assert no `legacy-*`, `unresolved-legacy`, or `invalid`; unrelated section-owned outputs remain valid controls. Assert every required id actually executed a scenario. For Provenance/Condition-only paths, assert the relevant resource writes and zero Observation writes. Negative/refusal scenarios must verify zero associated writes, not only zero Observation writes. Replays must distinguish no-op from new persistence.

Generic tools have fixed builders and generally cannot accept an arbitrary Observation body in input. Keep the builder-boundary shape matrix explicit (existing §3.13 tests force canonical/panel/negative/legacy outputs at each production dispatch boundary), plus positive calls using actual fixed builders. Avoid claiming shape injection is public-schema input coverage.

## Release checker and mutations

- Resolve real paths of candidate and expected suite root before grouping or spawning. Missing/broken symlink -> named T-id failure. Reject realpath outside suite root, even if lexical path is inside. Group by canonical realpath only after containment validation.
- Correct MCP T17 to derive `Condition/${body.condition.id}`.
- W87a: delete one registry semantic id; fixed independent set and T22 both identify missing ID.
- W87b: add an Observation write in an already registered owner; new ordinal must be named as unmapped.
- W129: remove an attest/amend Binary entry mapping; add a second Binary JSON Patch targeting Observation inside its registered builder; both fail with exact site key.
- W86: symlink outside root and broken-link candidate each produce strict exit 1 with the relevant T-id. Restore and show green after each.

The implementation must maintain the UI slots open; server green is not full release green. Run the final strict checker and report the precise remaining UI IDs, not a release PASS.
