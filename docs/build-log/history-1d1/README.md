# History 1d-1 author evidence

Original base: `ac4dba80046988339e67d15ef3ce9f35585331a7`. Fixback base after PR #531: `69e45eaa6ad8ee6c44a0c5f1dc6780c5b6ffabda`. Branch: `drbang-iva/history-slice-1d1`.

History autosave submits added/changed answers since its last successful save. Failed saves retain the pending delta; queued saves compare against the last completed request. Clears still use the existing void primitive. The endpoint validates only submitted answers against persisted presentation context and renders complete complaint narratives from persisted answers plus the delta. Byte-identical answers cause no answer PUT or review retirement. Unchanged aggregate refreshes also avoid PUTs.

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

## Follow-up prefill fixback

Follow-up prefills are now unrecorded suggestions. Selecting Follow Up saves only the presentation answer. Each suggestion uses the existing sky carry-forward palette and says `suggested from last visit`; tapping one sends exactly that one answer through the ordinary autosave path. Untapped suggestions never enter `latestAnswers`, a request body, persistence, the narrative, or completeness.

`fixback-after.png` is a synthetic component/network preview captured from the rebased worktree. It shows all seven routine glaucoma workup suggestions, History at Started, and a successful save whose intercepted request contained one presentation answer. This is not an application-route or AccessPolicy proof.

### Fixback checks and actual results

- Seven-prefill save and suggestion boundary: 2 pass / 0 fail after restore. The first request contained 1 answer; tapping one suggestion produced a second request containing exactly 1 answer.
- Current-head focused History suites: MCP 50 pass / 0 fail; UI 24 pass / 0 fail; Chromium delta request test 1 pass / 0 fail.
- Original 1a/1b/1c assertions selected from `ac4dba80`: MCP 41 pass / 0 fail; UI 20 pass / 0 fail.
- Original #530 delta assertions: MCP 5 pass / 0 fail; UI 2 pass / 0 fail; Chromium 1 pass / 0 fail. The guard and no-partial-write assertions were not edited.
- PR #531 pagination after rebase: unit 15 pass / 0 fail. Dedicated synthetic Medplum proof: 1 pass / 0 fail; 5,000 rows returned HTTP 200 and 5,001 rows refused with HTTP 409 after 11 pages.
- Real synthetic Medplum #530 boundary proof: 6 pass / 0 fail. The 9-entry and 51-PUT cases returned HTTP 413 with zero transaction submissions and unchanged resources; the exact 8-entry and 50-PUT boundaries persisted.
- Full UI before the final display-only refactor: 1,235 pass / 0 fail / 0 skipped. The final-head broad rerun encountered three unrelated browser timeouts: 1,232 pass / 2 fail / 1 cancelled. Each affected file then passed alone: payment focus 9/9, entry sheets 49/49, responsive chart bar 3/3. Final-head History remained 24/24 and the UI build passed.
- Full ungated MCP unit run at the final local head: 4,189 tests; 4,132 pass / 0 fail / 57 skipped. The harness reported 41 live-stack tests skipped; the focused real-Medplum proofs above were run separately.
- MCP TypeScript build and UI TypeScript/Vite build: exit 0. `git diff --check`: exit 0.

### Fixback Mandate 17

| Mutation | BREAK | RESTORE |
|---|---|---|
| Reinsert automatic prefill persistence | 0 pass / 1 fail; actual HTTP 413 | 1 pass / 0 fail |
| Let untapped suggestions enter the delta | 0 pass / 1 fail; request contained presentation plus 7 `presents-for` answers | 1 pass / 0 fail |
| Conditional limit 8 → 9 | 3 pass / 1 fail | 4 pass / 0 fail |
| PUT limit 50 → 51 | 3 pass / 1 fail | 4 pass / 0 fail |

Every mutant was applied in place and restored before the full checks.

### Multi-answer path sweep

No other single gesture silently adds multiple History answers. `changePresentation` voids inactive persisted answers before recording its one presentation answer. Answer clear removes one answer and uses the existing void path. Complaint and subject-section clears remove an explicitly selected finding or section through the server void primitive; their follow-up save reconciles the remaining state and manufactures no new answers.

### What shipped behaviour does this change?

A follow-up no longer becomes Charted because prior-plan procedures were applied without review. It remains Started until the tech taps at least one required `presents-for` suggestion. This adds an explicit human confirmation step and prevents the chart from claiming that an untapped procedure was recorded today.

## Final-head delta comparison fixback

PR-Agent identified that the delta comparison considered only `value`. A submitted answer could reuse a persisted ID and value while changing a valid complaint, template, section, option, eye, or scope coordinate; the endpoint would then rewrite the aggregate from the submitted coordinates without updating the answer Observation. Delta comparison now covers the complete persisted answer representation and ignores only the server-supplied `observationReference`. When a structural move leaves a patient-scoped section, any no-change review attestation for the prior section is retired with the answer update.

Focused proof: `hpiEndpoint.test.ts` 37 pass / 0 fail. The coordinate regression changes `ocular-pain` to `headache` with the same ID and negative value, then requires the stored answer and aggregate narrative to agree. The review regression moves an answer from Social History to a complaint text section and requires Social's prior no-change attestation to retire.

Mandate 17 mutations:

| Mutation | BREAK | RESTORE |
|---|---|---|
| Restore value-only delta comparison | 0 pass / 1 fail; stored option remained `ocular-pain` | 1 pass / 0 fail |
| Ignore the persisted patient section during review retirement | 0 pass / 1 fail; Social review remained `preliminary` | 1 pass / 0 fail |
