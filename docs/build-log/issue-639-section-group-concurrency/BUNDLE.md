# Issue 639 — section-group store concurrency

NOT EVALUATED. Author: Codex — gpt-6-astra, high effort. Independent evaluator: Claude Opus 5.

Settings catalogue writes now carry the caller's loaded FHIR version.
Stale edits return the existing 409 concurrent-edit response and preserve the first writer.
Catalogue creation and first seed overlays use identifier-keyed conditional creation and write-token winner checks.
Override creation uses the existing code + subject identity; no identifier was added.
All original S1/S1b assertions remain; the shipped narrower concurrency guard keeps its meaning.
The override endpoint's read-modify-write lost-update window is an explicitly accepted limitation.
The original BLOCKED.md is retained unchanged; REV 2 resolves its three questions.

## Branch, base, and scope

Branch: `drbang-iva/section-group-store-concurrency`.
Fetched base: `b92ed979848c055ffca1eafbb0bc023980f3539d`.
PR/head are reported in the handoff; `verification.json` seals the four application-file hashes and the actual served artifact hashes.

Files:
- `mcp/src/clinical-graph/finding-section-group-store.ts`
- `mcp/src/clinical-graph/finding-section-group-endpoint.ts`
- `mcp/tests/findingSectionGroup.test.ts`
- `mcp/tests/findingSectionGroupConcurrency.test.ts` (new)
- `ui/src/lib/finding-section-groups.ts`
- `ui/src/components/settings/FindingSectionGroupsSettings.tsx`
- `ui/tests/findingSectionGroups.test.tsx`
- This build-log directory: original blocked record, proof harness, summaries, mutation evidence, and three synthetic screenshots.

No outside-allowlist files were changed or are needed. No new clinical codes, FHIR artifact URLs, or policy decisions were introduced; no Mandate 14 ledger rows or companion decisions/INDEX.md change was needed.

## P1–P8 at origin/main

| Premise | Re-verification |
|---|---|
| P1 | Confirmed: catalogue create and first seed overlay were unconditional; update took the store's freshly read version. |
| P2 | REV 2 confirmed: override create was unconditional. Reads deterministically resolve duplicates by lastUpdated and id; the losing row still leaks. |
| P3 | Confirmed: shipped profile store uses caller versions, conditional create, random write token and 412 translation. The group store retains its existing flat JSON shape, adding the token without changing domain parsing. |
| P4 | Confirmed and preserved: 409, concurrent-edit, exact section-group reload-and-retry wording. UI uses the shared reload-and-reapply message. |
| P5 | Confirmed and preserved: endpoint merges existing fields with parsed changes. The explicit expectedVersion is passed separately; domain validation excludes metadata from stored domain fields. |
| P6 | Confirmed: no UI version before this change. Catalogue records now carry it; edits, deactivation and reactivation send it. |
| P7 | Confirmed: inventory remains 57; unchanged routing test and per-caller loop pass. |
| P8 | Confirmed: strict schemas remain strict. expectedVersion is explicit and required; a version alone does not qualify as an edit. |

## Guards

[GUARDS.md](GUARDS.md) quotes every red and restored-green summary and the G8 verification output; [mutations.json](mutations.json) is the machine-readable record. All 11 mutations returned exit 1, followed by exit 0 after restoration: G1–G7 and four UI payload/message mutations. G8 is verification only.

G5 asserts one physical row, not the resolved returned value. A separate test races against an identifier-free legacy override row and verifies it remains the only row.

G6 still injects the version bump between the store read and update, asserts refusal and unchanged saved data, and checks both exact If-Match headers. Only the catalogue error assertion changes from raw 412 to its required translated 409; override behavior stays unchanged.

## Proof of done

1. Real Settings route, two independent browser contexts, same loaded version: base saves `[200, 200]` and persists `Second editor label`; proposed saves `[200, 409]` and persists `First editor label`. The rejected draft remains in the dialog with the shared message. The screenshots show the second editor in both cases.
2. Real chart route: clicked Dry Eye Workup in the overview shelf, received 200, observed its drawn Symptoms editor, and verified persisted overrideGroupKeys. Saved synthetic symptoms through the real capture endpoint (200); attempted removal returned `409 section-group-has-content`. Reload retained both contentPinnedGroupKeys and effectiveGroupKeys, plus the visible pin. The finding save was an authenticated HTTP action; pull-in and reload were browser actions.
3. Full suites, typechecks and preflight passed before and after. All base test names remain present. Counts and served artifact hashes are in [verification.json](verification.json).

The browser proof uses the untouched base in a separate worktree and separate verified ports (base 32692, proposed 32691), with the same synthetic stack and data. Captures were inspected. No mocks intercept application requests in this proof.

## Commands and exact summary counts

UI: `npm --prefix ui test`

```text
base:  # tests 1811  # pass 1811  # fail 0  # skipped 0
after: # tests 1813  # pass 1813  # fail 0  # skipped 0
1811 + 2 added = 1813
```

MCP, from mcp, against the disposable local PostgreSQL service:

```sh
ODOS_POSTGRES_URL=<disposable-local-postgres> node --import tsx --test --test-concurrency=1 \
  'src/__tests__/**/*.test.ts' 'tests/**/*.test.ts' \
  '../tests/boundaries/**/*.test.ts' '../tests/observation-status-machine/**/*.test.ts' \
  '../tests/setup-wizard/**/*.test.ts' '../tests/preflight/**/*.test.ts' \
  '../tests/smart/**/*.test.ts' '../tests/cds/**/*.test.ts' \
  '../tests/agentops/**/*.test.ts' '../tests/bulk-data/**/*.test.ts' '../tests/mandate-8/**/*.test.ts'
```

```text
base:  # tests 6160  # pass 6105  # fail 0  # skipped 55
after: # tests 6166  # pass 6111  # fail 0  # skipped 55
6160 + 6 added = 6166
```

`npx tsc --noEmit` from root, mcp, and ui: base and proposed exit 0, no diagnostics.
`npm run preflight`: base and proposed `ODOS preflight complete: 0 warning(s), 0 hard block(s).`
Focused MCP: 33 passed, zero failed. Focused UI plus clinicalGraphRouting: 21 passed, zero failed.
`git diff --check`: exit 0.

Initial harness attempts failed due to a missing copied fixture import and the old project-name assertion; both were corrected only in this build-log harness. An early MCP baseline overlapped the failed startup and reported 18 database-connection failures; it was discarded and rerun in the clean base worktree against the ready stack. No test was skipped or weakened to remedy infrastructure failures. The retained baseline above is the complete successful rerun.

## Accepted limitation and follow-ups

I agree with REV 2's bounded scope: caller-version plumbing on the override path would require chart files outside this allowlist. The endpoint still reads a set, modifies it, and later writes it; another writer can win between those reads. Conditional creation prevents a second physical row but can return the existing winner's set to a losing caller. It does not promise that both requested additions survive. This is the accepted #639 follow-up, not a claim of complete override concurrency safety.

Existing duplicate rows are not removed by this change. Their deterministic resolution stays unchanged. Existing catalogue pagination and malformed-row handling are also unchanged. Settings clients loaded before deployment must reload to obtain/send expectedVersion.

The local full MCP lane retains 55 gated skips; real-stack browser proof covers the requested local paths, not every skipped integration/authz scenario. CI and automatic bot results belong to the exact PR head and are reported separately. Author checks are not independent evaluation.

Not done: S3b follow-up shape record/picker; S3c test queue; issues #640, #641, #642; section-group meaning changes; S1 content-pin changes; S1b category-removal changes. No merge or deployment performed.

## Stack shutdown

Both owned app servers were stopped; all odos-639-proof containers were stopped, with volumes retained.

```text
$ docker ps --filter name=odos-639- --format '{{.Names}}\t{{.Status}}'
(no rows)
```

needs-review
