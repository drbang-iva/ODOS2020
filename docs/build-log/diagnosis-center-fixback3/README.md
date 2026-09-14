# PR #594 fixback 3 — sealed author bundle

Branch: `drbang-iva/dx-status`. Starting PR head: `d0fc229ad66b731bf44ea0d63b850ee887fe0f7b`. Fetched main: `bd7029eb55435655f3e4332b2cc703bfd2d77e7e`. Main merged without conflicts in `0388e531eb15a6b1767cc9ce474fca0c65d5066d`, preserving PR #593's guarantor service-identity entry.

## Changes

- Updated all nine `mcp/src/index.ts` line pins in `scripts/fhir-read-grant-check.ts` to the current call sites. No grants or production routes changed.
- Assessment tracks visit-status and New/Established read errors separately. A newness failure retains a successfully loaded `well-controlled` status in the actual protocol-offer request and ranking. A visit-status failure still suppresses the request's status. The error message reports ranking unavailable only for that failure.
- Both newness handlers return `{ status: 404, body: { error: "Encounter not found." } }` when the Encounter read rejects, matching the existing visit-status endpoint. Both missing and unreadable Encounter cases stop before reading a Condition or storing an override.
- Normalized workstation paths in 30 existing build-log artifacts across `diagnosis-center-slice1`, `diagnosis-center-fixback`, and `diagnosis-center-fixback2`. Both mutation generators normalize working-tree and shared-checkout paths before writing broken and restored output. Escaped the literal pipes in fixback 2's stored-resolution table row.

Changed source/test files: `scripts/fhir-read-grant-check.ts`, `mcp/src/clinical-graph/diagnosis-newness-endpoint.ts`, `mcp/tests/diagnosisNewness.test.ts`, `ui/src/components/charting/AssessmentSection.tsx`, and `ui/tests/diagnosisNewness.test.tsx`. Supporting changes are the two existing mutation generators, normalized historical evidence, and this bundle. `files.txt` lists every fixback file; `source-sha256.json` pins the verified sources.

## Executed checks

| Check | Actual result | Output |
| --- | --- | --- |
| `npm run preflight` | exit 0; 48 resource types, 901 read/write operations; 0 warnings, 0 hard blocks | `preflight.txt` |
| UI focused tests | 53 tests, 53 pass, 0 fail, 0 skipped | `ui-focused.txt` |
| MCP focused tests | 23 tests, 22 pass, 0 fail, 1 skipped | `mcp-focused.txt` |
| FHIR checker tests | 21 tests, 21 pass, 0 fail, 0 skipped | `checker-tests.tap` |
| `npm --prefix ui run build` | exit 0; TypeScript and Vite build complete | `ui-build.txt` |
| MCP `tsc --noEmit --skipLibCheck` | exit 0 | `mcp-typecheck.txt` |

Focused commands (run in the indicated package directory):

```sh
# ui/
node --import tsx --test --test-concurrency=1 tests/diagnosisNewness.test.tsx tests/diagnosisWorkspace.test.tsx tests/diagnosisLinkL2.test.tsx
# mcp/
node --import tsx --test --test-concurrency=1 tests/diagnosisNewness.test.ts tests/diagnosisVisitStatus.test.ts
# repository root
node --import tsx --test --test-concurrency=1 tests/preflight/fhir-read-grant-check.test.ts tests/preflight/fhir-service-transaction-check.test.ts
```

The skipped MCP test requires `ODOS_NEWNESS_TEST_POSTGRES`; no database or migration behavior changed in this fixback. The UI build reports a bundle-size warning. UI proof renders the real Assessment component with synthetic HTTP responses and inspects its protocol request using the real ranking function; it is not an app-route or live AccessPolicy verification.

## Regression and mutation evidence

Before the fixes, the added UI scenario failed with `undefined` instead of `well-controlled` (`ui-before.tap`), and all four Encounter-read cases rejected instead of returning 404 (`mcp-before.tap`). Preflight failed at the stale VisionPrescription call-site pin (`preflight-before.txt`).

| Guard | Deliberate break | Broken | Restored |
| --- | --- | --- | --- |
| Newness error isolation | Make a newness failure suppress visit status again | exit 1; 0 pass, 1 fail | exit 0; 1 pass, 0 fail |
| Visit-status error suppression | Remove visit-status error suppression while newness returns New | exit 1; 0 pass, 1 fail | exit 0; 1 pass, 0 fail |
| Update Encounter mapping | Remove only the update handler's read catch | exit 1; 0 pass, 2 fail | exit 0; 2 pass, 0 fail |
| Read Encounter mapping | Remove only the read handler's read catch | exit 1; 0 pass, 2 fail | exit 0; 2 pass, 0 fail |
| Write inventory | Delete the corrected VisionPrescription entry | exit 1; `Missing FHIR grants: create VisionPrescription` | exit 0; preflight complete |

Each mutation was checked in place and restored byte-for-byte before its green rerun. `mutations.json` records exact replacements and commands; the corresponding `*-broken.txt` and `*-restored.txt` files contain the actual output.

Both existing generators were executed sequentially: 11 fixback guards and 4 fixback-2 guards each returned broken exit 1 and restored exit 0. Every generated artifact was checked for workstation paths, and all source hashes matched after restoration. The older artifacts retain their original execution output with only paths normalized; fresh generator results are recorded in `generator-reruns.json`.

## Review threads addressed

Eight existing review comments are covered by this patch: 4008335145, 4008335162, 4008335172, 4008335195, 4008335200, 4008335239, 4008335246, and 4008335252. Replies and resolution follow the authorized single push. The evaluator-dismissed rate-limiting, database-name, browser-method and MDM-count findings are outside this fixback.

## Remaining CI issue and status

At fixback 3, MCP CI also failed `findingDefinitionStore.test.ts:479`: it expected 99 inline clinical-graph routes but found 101 after the two newness routes were added (`existing-ci-blocker.txt`). This PR-owned failure is corrected in [fixback 4](../diagnosis-center-fixback4/README.md), which documents the routes' status-store dependencies, adds both handler assertions, and records red/green and full-suite verification.

No new decision or terminology value was introduced: `decisions/INDEX.md` and Mandate 14 ledgers need no new entries. No cross-repo change is required.

**Status: scoped author verification complete; independent evaluation pending. NOT EVALUATED — Codex authored these changes. Hand the final pushed head to Fable (high) or Opus (medium) in Claude before merge.**
