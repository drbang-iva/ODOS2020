# Ocular Health door (§3.4) author evidence

Shared-definition capture now accepts a frozen command plan, validates both eyes before writes, and writes canonical facts/panels through the existing writer. Non-shared capture/history remains on the original path. Shared encounter and patient-wide history projects the reader, exposes revive baselines/audit debt, and retains read-only legacy rows. Negative acts remain explicit, use original-actor/time audit recovery on replay, and participate in command outcomes and execution order.

Owned files: `mcp/src/clinical-graph/custom-section-endpoint.ts`, `mcp/tests/customSectionEndpoint.test.ts`, `mcp/tests/r10A3OcularDoor.test.ts`, and this evidence directory. Parent owns the small custom-route header forwarding hunk in index.ts. No commits.

## Checks

- Initial new focused suite: 20 tests, 0 pass, 20 fail, before implementation.
- Final scoped regression command: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/customSectionEndpoint.test.ts mcp/tests/r10A3OcularDoor.test.ts mcp/tests/r10A3Library.test.ts mcp/tests/r10A3DoorGuards.test.ts mcp/tests/currentFindingWriter.test.ts mcp/tests/currentFindingReader.test.ts` — 240 tests, 240 pass, 0 fail, 0 skipped.
- `npm --prefix mcp run build` — exit 0.
- Owned-file `git diff --check` — exit 0.
- 17 mutation variants W66–W70, W72, W91, W96–W100, W110, W114, W120–W122 — every variant exit 1 at the designated behavioral assertion, restored exit 0. Existing mutation runner verifies byte restoration. Raw guard outputs are sibling `../mutations/ocular-*-red.txt` and `*-green.txt`; manifest/results are here.
- Existing assertion inventory: 485 before, 278 retained, 207 changed/removed, 207 exact before/after ledger rows, 0 unmapped. Original seed assertions and six non-shared dry-eye cases retained; new canonical and legacy tests replace obsolete shared snapshot/resave expectations. Numeric qualifier values are typed numbers with the unit retained in the effective definition; canonical writer does not duplicate that unit in the raw component.

## Limits and handoff

Author checks only, NOT EVALUATED. No containers/live lane/served browser proof ran in this assignment. The allowed negative-act race remains: a positive arriving after the final positive read and before conditional negative creation can coexist; the endpoint never derives current Normal. Parent retains full A3.1 release checking, §7 live proof and downstream consumers. §3.5 was not started by this agent.
