# Education sequence live conditional-write proof

Author-side verification of production source at `cf3a4f0a`; not an independent evaluation or a deployment verdict. Run on 2026-09-10 in the separate `drbang-iva/seq2-live` worktree.

## Isolation

New Docker Compose project: `odos-seq2-live`. Reused installed images: Medplum `5.1.8`, Postgres `16-alpine`, Redis `7-alpine`, Alpine `3.21`. Services bind only loopback: Medplum `18603`, Postgres `15932`, Redis `16879`.

Explicit new volumes: `odos_seq2_live_postgres`, `odos_seq2_live_redis`, `odos_seq2_live_binary`. The existing `odos-history-1d5` stack and all other stacks were untouched. A new Compose project alone would not isolate the checked-in DR template's explicit volume names, so this run used a separate generated Compose file and explicit new names.

Signing keys, server configuration, and Compose configuration were generated privately. The reusable test generates new synthetic account credentials in memory and creates a new synthetic Medplum project on each invocation. It does not load `.env`, use existing accounts, configure an external provider, or send a message. Generated signing configuration is ignored and not committed.

## Instrument

`mcp/tests/educationSequenceLiveWrite.test.ts` is opt-in and requires an explicit loopback base URL plus both disposable-run switches. It uses the production FHIR client, enrollment store, scheduled admission/claim helpers, worker, and communications route.

Four substantive subtests (five TAP tests including the parent):

1. A raw stale `If-Match` PUT returns actual HTTP **412**. A PUT using the fresh version succeeds and cancellation remains persisted.
2. Stale scheduled admission and stale scheduled claim after a committed stop both receive real transport **412**, translated by the production helper to `EducationSequenceAdmissionError("stale-enrollment-version")`. Cancellation events remain present; enrollment stage/status remain unchanged.
3. The actual worker searches the live project, prepares its due row, and loses a race to a stop committed inside the preflight callback. It receives transport **412** and makes **zero** adapter calls. Its search is restricted to the test's enrollment ID to keep independent subtests isolated after deliberate mutations.
4. The actual Express stop route performs a real conditional update after an injected competing real FHIR write. It returns HTTP **409** and `{ "outcome": "refused", "reason": "stale-enrollment-version" }`; the refused stop does not land.

The route's staff identity and audit recorder are test adapters. This proves real persistence and route error translation, not live practice-role AccessPolicy enforcement. The worker's authentication callback is a no-op because its FHIR client already owns the new synthetic project's token. Suppression, provider receipts, and later runtime wiring are outside this bounded proof.

## Commands and results

From the worktree root, with the installed Node 22.22.3 runtime:

```sh
ODOS_SEQUENCE_LIVE_WRITE=1 \
ODOS_SEQUENCE_LIVE_DISPOSABLE=1 \
ODOS_SEQUENCE_LIVE_BASE_URL=http://127.0.0.1:18603/ \
npm exec --no -- /Users/ericr.bang/.local/bin/node --import tsx --test mcp/tests/educationSequenceLiveWrite.test.ts
```

Baseline: **5 pass / 0 fail / 0 skipped**. The four subtests established raw 412, fresh-version success, typed stale admission/claim, zero adapter calls, retained history, and route 409.

Mutation: replace the production shared `updateEnrollmentResource` helper's `enrollmentVersionHeaders(resource)` argument with `{}`. Result: **1 pass / 4 fail / 0 skipped**, exit 1 (three substantive failures plus the enclosing parent):

- Missing expected typed-conflict rejection: stale admission was allowed.
- Worker adapter count **1 instead of 0** after the clinician stop.
- Route status **200 instead of 409** after the competing writer.

The raw stale-header control stayed green because it supplies its header directly. The source mutation was restored byte-for-byte; no production source changes are included in this evidence commit.

One preliminary mutation run exposed cross-subtest contamination: the worker encountered another deliberately damaged enrollment before its target. Restricting that subtest's real query to its own enrollment made the final red result specifically demonstrate one forbidden adapter invocation. One restored run was refused during fixture setup with `auth/newproject: HTTP 429`; Medplum's default login/newuser/newproject rate limit is five per minute. That run did not reach the tests and is not counted as application evidence. A preliminary npm invocation also selected a cached/downloaded Node runtime; the sealed mutation/restoration commands explicitly select the installed Node 22.22.3 executable and disallow npm package installation. No manifests or lockfiles changed.

Final restored result and stack shutdown are recorded below after execution.

## Sealed restored result

Final restored run: **5 tests / 5 pass / 0 fail / 0 skipped**, exit 0, duration 933 ms. Synthetic project `a90e4922-e3c3-46b6-b320-dfe622b4497f`.

```text
Raw HTTP 412; fresh If-Match update succeeded; cancellation retained
Admission + claim: real transport 412 -> stale-enrollment-version; cancellation histories retained
Actual worker enumerated real FHIR; stop after read; transport 412; adapter calls=0
Actual route HTTP 409 stale-enrollment-version from real Medplum HTTP 412
```

Opt-in disabled control: **0 pass / 0 fail / 1 skipped**, exit 0; no server access. `npm exec -- tsc --noEmit --pretty false` in `mcp/`: exit 0. The mutation target has zero diff from `cf3a4f0a` after restoration.

Owned stack stopped using `docker-compose -p odos-seq2-live -f <private-compose-path> stop`. No volumes were deleted. Retained volumes contain only generated synthetic proof fixtures. No PR, push, merge, production deployment, or independent evaluation marker.
