# T22 endpoint runtime evidence

Implementation helper: `mcp/tests/fixtures/r10/endpoint-write-path-runtime.ts`, export `runEndpointWritePaths(): Promise<WritePathEvidence[]>`. Shared test recorder/types/classifier: `mcp/tests/fixtures/r10/write-path-recorder.ts`. Neither imports node:test or registers tests. No production files, existing tests, release test, registry or checker were changed in this task.

Isolated verification:

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs docs/evidence/r10-a3-1/t22-endpoints/verify.ts
```

Result: **5 recorder probes passed; 13 endpoint IDs returned; 33 attempted and 33 persisted positive writes; all 13 rejection rows have zero attempted and persisted writes.** Exact output: `verification.log`; per-ID counts, Observation kinds and rejection reasons: `runtime-summary.json`.

Covered IDs: door-put, door-audit-repair, pick-condition, oh-save-fact, oh-save-panel, oh-negative-act, carry-condition, carry-plan, carry-link, carry-facts, carry-lineage, void, undo. Each invokes its real exported handler with real reader/writer mechanics and effective FHIR definition-store data. The door path resolves a stored practice-added option. Pick records transaction and tally writes without creating Observation evidence. Audit repair records only Provenance writes and preserves the owner's version/content.

The five carry IDs intentionally share one actual successful pull and one actual closed-Encounter rejection. Their `scenarioId` exposes this overlap. Phase write attribution is disjoint and exhaustive: Condition, plan Provenance, Encounter link, facts with their mutation audits, and lineage Provenance. The helper verifies both eyes, qualifiers, homes, conditional identity, preserved source owners, and lineage versions.

Recorder probes cover persistence despite a lost response, distinct attribution of two identical-type transaction POST bodies through actual response locations, refusal of ambiguous attribution, a Binary PATCH attempt associated with its persisted Observation result, and rejection of a legacy Observation naming its path. The Binary probe tests recording only; MCP helper owns actual JSON Patch transport.

Attempts are captured before delegation; persisted snapshots are computed in finally, including writes followed by exceptions. Transaction response IDs/locations and target URLs take precedence over unique-body matching; ambiguous attribution fails. Classification checks attempted and persisted Observations and preparation traces against the effective definitions. Rejection preparation is explicit; it is outside each zero-write refusal window.

Parent owns integration into T22, exact registry matching, census mutations, broad checks and live execution. This evidence is in-memory author verification, not real AccessPolicy proof or independent evaluation. **NOT EVALUATED.**
