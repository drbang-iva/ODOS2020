# Communications conflict fixback — round 2

Author verification only. Independent evaluation remains required from Claude Opus 5 (extra).
Branch: `drbang-iva/comms-conflict-409`. Starting head: `f1a8f5f354baf13e6efebbe9b8fa39bbd4fd0860`.

## Behavior and scope

After an accepted email or SMS, a recipient version conflict returns HTTP 200 with `outcome: sent` and `chartUpdate: conflict`. The recipient stays unchanged, Provenance is persisted, and its source text does not falsely claim the chart was updated. The staff wrapper alone adds the response metadata; the exported actor dispatch, enrollment outcome type, serializers, and sequence worker retain their existing shapes. The same handling covers already-sent reservations.

EngageSheet shows the requested success status and clears pending confirmation. Print plus a chart-update request still returns 400 before any Provenance, output URL, or FHIR write.

Post-send Communication persistence conflicts return 502 after the existing three-attempt writer exhausts its retries. The same post-send wrapper covers Provenance persistence, including sent-reservation reconciliation: an accepted message must not acquire a reload-and-retry instruction there either. Non-conflict failures retain their behavior. No conflict predicate was narrowed.

The single authorized existing expectation change replaces `conflict mapping: education recipient If-Match returns 409`. No other existing test expectation changed. New fixtures obtain 412 errors through the real `createOperatorScriptFhirClient` and its error conversion against a synthetic HTTP server.

System refusal test: `system actor cannot request a chart update or produce chart metadata` in `mcp/tests/educationDispatchActor.test.ts`. It proves refusal before provider/resource access, then confirms an ordinary system send has no `chartUpdate` property.

## Changed files

- `mcp/src/comms/comms-api.ts`: staff-only result metadata, recipient conflict handling, post-send persistence boundary.
- `mcp/tests/commsApi.test.ts`: email/SMS recipient, print refusal, compose/email/SMS persistence and email/SMS Provenance conflict tests.
- `mcp/tests/educationDispatchActor.test.ts`: system actor boundary.
- `ui/src/lib/communications-client.ts`: dispatch result type only.
- `ui/src/components/comms/EngageSheet.tsx`: sent-success status.
- `ui/tests/engageSheet.test.tsx`: real client/component with fetch stub only; status, no alert, pending cleared.
- `docs/evidence/comms-conflict-409/round2-*.png` and this verification record.

## Commands and outcomes

| Command | Result | Exit |
| --- | --- | --- |
| `npm --prefix mcp test -- tests/commsApi.test.ts tests/educationDispatchActor.test.ts` | 83 passed, 0 failed | 0 |
| `cd ui && node --import tsx --test tests/engageSheet.test.tsx` | 16 passed, 0 failed | 0 |
| `npm --prefix mcp test` (initial; no PostgreSQL configured) | 4,465 passed, 6 setup failures, 58 skipped | 1 |
| `ODOS_POSTGRES_URL=<task-owned disposable PostgreSQL> npm --prefix mcp test` | 4,484 passed, 0 failed, 46 skipped; 4,530 total | **1** |
| `npm --prefix ui test` (initial) | 1,339 passed, 1 browser timeout, 0 skipped | 1 |
| `npm --prefix ui test` (before parser follow-up) | 1,340 passed, 0 failed, 0 skipped | 0 |
| `npm --prefix ui test` (final, with parser follow-up) | 1,341 passed, 0 failed, 0 skipped | 0 |
| `npm --prefix mcp run build` | TypeScript completed | 0 |
| `npm --prefix ui run build` | TypeScript and Vite completed; existing chunk-size warning | 0 |
| `node .claude/skills/tier0-census/scripts/check-proxy-coverage.mjs` | 24 families / 27 proxy entries; all covered, advisory | 0 |
| `git diff --check` | Clean | 0 |

The local MCP command remains exit 1 because the harness refuses 41 missing-live-stack skips (46 total skips). The disposable PostgreSQL rerun resolved all six setup failures; it does not establish live Medplum enforcement.

Commands were run directly with stdout/stderr redirected to individual logs. Each exit status is from the command process; no reported command was piped. No live-stack opt-out flag was used.

Initial server RED: 63 passed / 5 failed, exit 1. The two post-send recipient tests returned 409 instead of 200; all three Communication persistence tests returned 409 instead of 502. The print test already passed. Separate Provenance RED: both channels returned 409 instead of 502.

## Mutation evidence

Each mutation below was confirmed by `rg -n`, run RED, restored byte-identically in a `finally` block, and run GREEN. Source paths in the confirmation are the corresponding changed file described above. R2 moves the print update below Provenance; it does not change print's refusal.

### R1

Command: `npm --prefix mcp test -- tests/commsApi.test.ts` (from the repository root).

Confirmed mutation:

```text
2352:    throw error; // R1 mutation
```

RED (exit 1):

```text
not ok 63 - post-send recipient conflict: sms remains sent with provenance
  error: |-
    409 !== 200
  expected: 200
  actual: 409
not ok 64 - post-send recipient conflict: email remains sent with provenance
  error: |-
    409 !== 200
  expected: 200
  actual: 409
# tests 70
# pass 68
# fail 2
# skipped 0
```

Restored GREEN (exit 0):

```text
# tests 70
# pass 70
# fail 0
# skipped 0
```

### R2

Command: `npm --prefix mcp test -- tests/commsApi.test.ts` (from the repository root).

Confirmed mutation:

```text
1137:        await persistAfterSend(() => persistEducationSendProvenance(staff.fhir, {
1160:    await persistEducationSendProvenance(staff.fhir, {
1169:      await updateEducationRecipient(staff.fhir, recipient, body, staff);
1171:    return { outcome: "print", url };
1231:      await persistAfterSend(() => persistEducationSendProvenance(staff.fhir, {
1274:      await persistAfterSend(() => persistEducationSendProvenance(staff.fhir, {
1353:    await persistAfterSend(() => persistEducationSendProvenance(staff.fhir, {
1396:    await persistAfterSend(() => persistEducationSendProvenance(staff.fhir, {
2345:  ...args: Parameters<typeof updateEducationRecipient>
2348:    await updateEducationRecipient(...args);
2356:async function updateEducationRecipient(
2383:async function persistEducationSendProvenance(
```

RED (exit 1):

```text
not ok 65 - print chart update refuses before provenance or output
  error: |-
  expected:
  actual:
# tests 70
# pass 69
# fail 1
# skipped 0
```

Restored GREEN (exit 0):

```text
# tests 70
# pass 70
# fail 0
# skipped 0
```

### R3

Command: `node --import tsx --test tests/engageSheet.test.tsx` (from `ui/`).

Confirmed mutation:

```text
224:      } else if (false /* R3 mutation */) {
```

RED (exit 1):

```text
not ok 16 - chart contact conflict is sent success and clears pending using real dispatch client
  error: |-
  expected:
  actual: 'Exam overview Chart remains visible behind this sheet Entry sheet Engage Cancel Engage — Ella Jenkins Recipient Ella Jenkins +18645550101  ·  ella@example.test SMS text preferences Clinical texts  —  OK Front-desk texts  —  OK Record opt-out — patient asked… Education sent. Understanding dry eye video Text Email Print Dry eye treatment options handout Marketing consent not on file Text Email Print Home care guide handout Text Email Print'
# tests 16
# pass 15
# fail 1
# skipped 0
```

Restored GREEN (exit 0):

```text
# tests 16
# pass 16
# fail 0
# skipped 0
```

### R4

Command: `npm --prefix mcp test -- tests/commsApi.test.ts` (from the repository root).

Confirmed mutation:

```text
2340:    throw error; // R4 mutation
```

RED (exit 1):

```text
not ok 66 - post-send persistence conflict: compose remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 67 - post-send persistence conflict: sms remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 68 - post-send persistence conflict: email remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 69 - post-send provenance conflict: sms remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 70 - post-send provenance conflict: email remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
# tests 70
# pass 65
# fail 5
# skipped 0
```

Restored GREEN (exit 0):

```text
# tests 70
# pass 70
# fail 0
# skipped 0
```

### C1

Command: `npm --prefix mcp test -- tests/commsApi.test.ts` (from the repository root).

Confirmed mutation:

```text
1508:    if (false) {
```

RED (exit 1):

```text
not ok 56 - conflict mapping: record toError returns 409 without Patient or Provenance writes
  error: |-
    502 !== 409
  expected: 409
  actual: 502
not ok 57 - conflict mapping: record transaction-entry returns 409 without Patient or Provenance writes
  error: |-
    502 !== 409
  expected: 409
  actual: 502
not ok 58 - conflict mapping: clear toError returns 409 without Patient or Provenance writes
  error: |-
    502 !== 409
  expected: 409
  actual: 502
not ok 59 - conflict mapping: clear transaction-entry returns 409 without Patient or Provenance writes
  error: |-
    502 !== 409
  expected: 409
  actual: 502
# tests 70
# pass 66
# fail 4
# skipped 0
```

Restored GREEN (exit 0):

```text
# tests 70
# pass 70
# fail 0
# skipped 0
```

### C2

Command: `npm --prefix mcp test -- tests/commsApi.test.ts` (from the repository root).

Confirmed mutation:

```text
506:      /* C2 status removed */
```

RED (exit 1):

```text
not ok 57 - conflict mapping: record transaction-entry returns 409 without Patient or Provenance writes
  error: |-
    502 !== 409
  expected: 409
  actual: 502
not ok 59 - conflict mapping: clear transaction-entry returns 409 without Patient or Provenance writes
  error: |-
    502 !== 409
  expected: 409
  actual: 502
# tests 70
# pass 68
# fail 2
# skipped 0
```

Restored GREEN (exit 0):

```text
# tests 70
# pass 70
# fail 0
# skipped 0
```

### C3

Command: `npm --prefix mcp test -- tests/commsApi.test.ts` (from the repository root).

Confirmed mutation:

```text
1508:    if (true) {
```

RED (exit 1):

```text
not ok 19 - a failed education send leaves recipient telecom unchanged
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 33 - opt-out clear uses the caller-bound FHIR client for the Patient write
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 34 - opt-out state uses the caller-bound FHIR client for the Patient read
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 51 - a post-send FHIR failure leaves a durable unknown outcome and blocks duplicate dispatch
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 60 - conflict mapping: toError 500 remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 61 - conflict mapping: malformed batch-response remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 62 - conflict mapping: malformed transaction-response remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 66 - post-send persistence conflict: compose remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 67 - post-send persistence conflict: sms remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 68 - post-send persistence conflict: email remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 69 - post-send provenance conflict: sms remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
not ok 70 - post-send provenance conflict: email remains 502
  error: |-
    409 !== 502
  expected: 502
  actual: 409
# tests 70
# pass 58
# fail 12
# skipped 0
```

Restored GREEN (exit 0):

```text
# tests 70
# pass 70
# fail 0
# skipped 0
```

### C4

Command: `node --import tsx --test tests/smsOptOutControl.test.tsx` (from `ui/`).

Confirmed mutation:

```text
165:          const nextState = state!; // C4 reread removed
```

RED (exit 1):

```text
not ok 14 - conflict mapping: record 409 closes the form and re-reads SMS state
  error: |-
  expected:
  actual:
not ok 15 - conflict mapping: clear 409 closes the form and re-reads SMS state
  error: |-
  expected:
  actual:
# tests 15
# pass 13
# fail 2
# skipped 0
```

Restored GREEN (exit 0):

```text
# tests 15
# pass 15
# fail 0
# skipped 0
```

## Browser evidence

`round2-before.png` and `round2-after.png`: real EngageSheet on separate verified loopback Vite ports, same synthetic patient, viewport (1150 by 850), catalog and email click path. The base response is the former 409; the proposed response is sent with chart conflict. Before shows a red retry prompt and pending confirmation; after shows green success and no pending confirmation. Captured with Chromium and inspected visually. These are component captures with intercepted HTTP responses, not a live Medplum or authenticated app-route race.

## Limitations and follow-ups

The provider acceptance and FHIR write are not atomic. This patch does not add automatic resend or alter idempotency storage. Post-send persistence failures remain 502 rather than falsely promising a safe retry. Local live Medplum enforcement is not claimed. CI and independent evaluation are separate delivery states.

The first C-guard attempts encountered intermittent unrelated `fetch failed` errors. The complete final guard run above passed every restoration. The first full UI run had a Social History browser timeout; a focused retry failed its existing Started assertion, while the unchanged starting head passed. No expectation or History code was modified.

No terminology, registry, ledger, dependency, policy, enrollment serialization, or worker changes. No new decision was made; decision-index and Mandate 14 additions are not applicable.

Status: author verification; stop at PR #576 for independent evaluation. No merge, label, or author evaluation marker.

## Automated review follow-up

The review at `bd65784c82f5b8079f3dc7e71183ab28b3659c76` identified an out-of-diff runtime guard omission: `chartUpdate` could contain an invalid value while narrowing to the dispatch type. The sent-response guard now requires absence or `conflict`. A new client test checks an unknown string, boolean, and null; existing missing-field and valid-conflict cases remain covered.

`cd ui && node --import tsx --test tests/engageSheet.test.tsx`: before the guard, 16 passed / 1 failed, exit 1 (`Missing expected rejection`); after, 17 passed / 0 failed, exit 0. The runtime check is at `ui/src/lib/communications-client.ts:296`. No server, enrollment, worker, or existing test expectation changed in this follow-up. The generic docstring coverage warning is not adopted: repository style defaults to no comments unless the reason is non-obvious.

Final parser mutation: removed the metadata condition, confirmed by `rg -n` at line 296 (`parser guard mutation: metadata unchecked`). The client test failed with `Missing expected rejection`: 16 passed / 1 failed, exit 1. Restored byte-identically: 17 passed / 0 failed, exit 0. Final full UI suite: 1,341 passed / 0 failed / 0 skipped, exit 0; UI build exit 0. MCP code remains byte-identical to the full-suite-tested fixback commit.
