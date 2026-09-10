# PR #569 narrow fixback evidence

Status: needs independent re-evaluation by Claude Opus 5 (EXTRA). Codex authored this fixback; no independent verdict is claimed.
Base: `3613ee949cc4e792120c050e11a0ad8eac774dd4`. Branch: `drbang-iva/education-seq-1`.

## Changes

- `mcp/src/comms/education-sequence.ts`: recursively sort enumerable object keys using lexical string comparison, retain primitive values, map arrays without reordering, then JSON-serialize and SHA-256 hash only the request fingerprint.
- `mcp/src/comms/education-enrollment.ts`: translate upstream 409/412 from admitSequence and stopSequence into the existing EducationSequenceAdmissionError with reason `stale-enrollment-version`. The existing HTTP handler already maps this type to 409 `{outcome: "refused", reason: "stale-enrollment-version"}`. No HTTP handler change or automatic retry is needed.
- `mcp/tests/educationSequence.test.ts`: reordered nested object keys replay with identical enrollment, one activation and two rows; legacy activation ID equality; divergent content and reversed steps still conflict without a write.
- `mcp/tests/educationEnrollmentApi.test.ts`: four real local HTTP requests exercise admission and stop against the production FHIR store backed by an enforcing UUID-version fake. The fake changes the persisted version between read and update, rejects the stale If-Match, and verifies one update attempt, unchanged clinical extensions, and zero sends.
- `mcp/tests/educationSequenceFhir.test.ts`: existing concurrent-writer assertion now expects the typed conflict instead of raw 412.
- This directory: six mutation logs, three final check logs and this bundle.

The kickoff's isFhirConflict and transition line citations name comms-api.ts; those helpers actually reside in education-enrollment.ts. The requested behavior is implemented at that existing store boundary.

## Identity and persistence

The shared hash function, activation ID input `[enrollment.id, requestId]`, and row ID input remain unchanged. Canonicalization is scoped to the fingerprint only. The regression compares the activation ID byte-for-byte with the pre-fix SHA-256/JSON algorithm; it passes. Array order is preserved and reversing steps remains a request-id-conflict.

There is no persisted production sequence data to migrate under the operator's explicit unmerged-slice premise. This task used only synthetic in-memory fixtures and did not inspect or mutate a live database. No migration or compatibility shim was added.

## Verification

Full original ten-file npm command: see `fixback-final-tests.txt` for exact command and output. Result: 182 tests, 182 pass, 0 fail, 0 skipped; exit 0 (previous suite 176 plus six new tests).
`npm --prefix mcp run build`: tsc, exit 0.
`npm run preflight`: 0 warnings, 0 hard blocks; exit 0.
`git diff --check`: exit 0.

All three guards are reachable and guard existing production surfaces. None was replaced with a test-only production substitute. Every mutation was restored byte-identically before the green run.

| Guard | Broken result | Restored result |
|---|---|---|
| Reordered keys replay: restore order-dependent fingerprint | 41 pass / 1 fail; request-id-conflict | 42 pass / 0 fail |
| Divergent body still conflicts: fingerprint ignores content | 40 pass / 2 fail; missing expected rejection | 42 pass / 0 fail |
| HTTP race: remove typed conversion from both sequence mutations | 38 pass / 4 fail; HTTP 502 instead of 409 for admit/stop, upstream 409/412 | 42 pass / 0 fail |

Mutation command: `npm --prefix mcp test -- tests/educationSequence.test.ts tests/educationEnrollmentApi.test.ts`. Each red exits 1; each restored run exits 0. Full raw outputs are `fixback-guard-{1,2,3}-{red,green}.txt`.

## Scope and risks

No worker, clock, transition call path, new schema field, resource type, AccessPolicy row, dependency, migration, or unrelated behavior change. No new decision: decisions/INDEX.md unchanged. No new clinical code or artifact URL: no Mandate 14 ledger rows required. Divergent-body rejection, caps and cancellation continue to pass the ten-file suite.

The race tests prove HTTP mapping with a version-enforcing fake, not live Medplum policy/proxy behavior. The standing real-instance If-Match release gate remains separate. Existing node_modules symlinks are untracked pre-existing worktree setup and are not included. No merge or deployment. After push, independent re-evaluation must bind to the new PR head; the old PASS remains retracted.
