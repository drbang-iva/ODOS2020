# History 1d-1 author evidence

Base: `ac4dba80046988339e67d15ef3ce9f35585331a7`. Branch: `drbang-iva/history-slice-1d1`.

History autosave submits added/changed answers since its last successful save. Failed saves retain the pending delta; queued saves compare against the last completed request. Clears still use the existing void primitive. The endpoint validates only submitted answers against persisted presentation context and renders complete complaint narratives from persisted answers plus the delta. Identical values cause no answer PUT or review retirement. Unchanged aggregate refreshes also avoid PUTs.

Both capture paths check the complete bundle before submission: conditional entries permit at most 8 total entries; all bundles permit at most 50 PUTs. Excess returns HTTP 413 with no transaction submission. The count includes aggregate updates, duplicate cleanup, review retirements, and provenance. No chunking or changes to stored answer/review shapes.

## Measured before/after

The same Chromium component fixture, loaded with two saved answers:

| Gesture | Base answer count in POST | Proposed answer count in POST |
|---|---:|---:|
| Unchanged aggregate refresh | 2 | 0 |
| Tick one new chip | 3 | 1 |

Exact request bodies are in `browser-requests.txt`. `before.png` and `after.png` show the same visible state; this is a persistence change. Screenshots were captured from separate base/proposed worktrees. The browser test mounts the real HpiSection, with synthetic API responses intercepted at the network boundary. It is not a full application-route or live-policy walkthrough. The separate live proof invokes the real capture endpoint and FHIR client against local Medplum; authentication is supplied by the synthetic proof harness, so this does not prove role enforcement.

## Checks and actual results

- Untouched 1a/1b/1c History baseline: MCP 41 pass / 0 fail; UI 20 pass / 0 fail.
- Expanded focused History suites: MCP 50 pass / 0 fail; UI 22 pass / 0 fail; Chromium request test 1 pass / 0 fail.
- `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test`: 4,170 tests; 4,114 pass / 0 fail / 56 skipped. Harness reported 40 credential-dependent skipped tests. This is an explicitly ungated unit run, not authorization evidence.
- `npm --prefix ui test`: 1,233 pass / 0 fail / 0 skipped.
- `npm --prefix mcp run build`: `tsc`, exit 0.
- `npm --prefix ui run build`: TypeScript and Vite, exit 0; existing bundle-size warning remains.
- `node .claude/skills/tier0-census/scripts/check-proxy-coverage.mjs`: 24 backend families, 27 proxy entries; every family covered. Advisory census.
- `git diff --check`: exit 0.

## Real Medplum proof

With synthetic stack environment variables provided, run:

```sh
node --import tsx mcp/scripts/prove-history-delta.ts
```

Requires `MEDPLUM_BASE_URL`, `MEDPLUM_ADMIN_EMAIL`, and `MEDPLUM_ADMIN_PASSWORD`. The script refuses non-loopback hosts. It creates only synthetic resources; it does not alter schemas or policies. The existing Colima contract stack at port 18103 was reused without restarting services.

`live-proof.txt` records 6 pass / 0 fail: 9 conditional-inclusive entries and 51 ordinary PUTs returned 413 with zero transaction submissions and unchanged resources/versions; 8 entries and 50 PUTs persisted; identical/empty deltas preserved dates and reviews; one changed answer retired only Social's review.

## Mandate 17

`mutations.txt` records verified-in-place mutants and source-hash restoration:

| Guard | BREAK | RESTORE |
|---|---|---|
| UI resends snapshot | 0 pass / 1 fail | 1 pass / 0 fail |
| Retirement ignores value change | 0 pass / 1 fail | 1 pass / 0 fail |
| Conditional limit 8 → 9 | 3 pass / 1 fail | 4 pass / 0 fail |
| PUT limit 50 → 51 | 3 pass / 1 fail | 4 pass / 0 fail |
| Guard moved after write | 0 pass / 1 fail | 1 pass / 0 fail |

The refusal tests assert persisted resource state before checking response status; a write followed by refusal fails. Original regression assertions were not edited.

## What shipped behaviour does this change?

The request now carries only the delta. Unchanged answer dates and review acts survive autosave. Oversized write units are refused before submission. Omitted answers remain in the complaint narrative, and an unchanged aggregate avoids a redundant write. No change to the clinical gestures, ROS, Family History, void primitive, or stored review/answer shapes.

No new clinical terminology, FHIR artifact URL, or regulatory assertion was introduced; Mandate 14 ledger additions: zero. The accepted 1d rescope and design-review amendment remain the authority; no new decision or decisions/INDEX.md update. Read pagination and bulk progress-ledger work remain subsequent slices.

Status: author evidence only; independent final-head evaluation required before merge. No deployment performed.
