# ODOS-SEQ-1 implementation evidence

Status: needs independent review. Codex authored this slice; this is author-side verification, not an independent verdict. Intended evaluator: Claude Opus 5 (medium).

Base: `2047ace47bf31ba1a28759075af05157668f6081`. Branch: `drbang-iva/education-seq-1`.

## Result

Added enrollment-owned scheduled rows and sequence activations, idempotent admission, whole-activation caps, and lifecycle cancellation. Existing immediate-send fields and historical outcomes remain; pending cancelled work gets a distinct `not-sent` outcome. Future-only enrollment is accepted. Multiple activations can be started/stopped independently. Stage transitions persist the stage, cancellation, and new activation in one versioned Basic update. Unknown earlier attempts hold new automation until reconciliation or explicit practitioner acknowledgement. Original enrolling sender is preserved during recovery.

No worker, sweep, scheduled claim/execute path, fire-time recipient resolution, suppression integration, analytics, chart UI, definition sync, VisionForge, or seam change was added. No new FHIR resource type or AccessPolicy row was needed. Existing Basic storage and permissions remain the persistence boundary.

## Files

- `mcp/src/comms/education-enrollment.ts`: Basic persistence, version preconditions, admission and lifecycle store operations, additive cancellation outcome.
- `mcp/src/comms/education-sequence.ts`: types, validation, stable identity, caps, lifecycle mechanic.
- `mcp/src/comms/comms-api.ts`: create/transition admission, activation start/stop, shared lifecycle entry checks, practitioner acknowledgement, reservation sender preservation.
- `data/canonical-extensions/registry.json`: two sequence extensions, sliceConsumer `education-sequence-1`.
- `mcp/tests/educationEnrollment.test.ts`, `educationEnrollmentApi.test.ts`, `educationSequence.test.ts`, `educationSequenceFhir.test.ts`: behavior, opaque UUID versions and stale-write refusal.
- This directory: command output and mutation evidence.

## Checks

Initial baseline: four existing education/catalog/reminder test files, 38 passed / 0 failed / 0 skipped.

Final command:

```sh
npm --prefix mcp test -- tests/educationEnrollment.test.ts tests/educationSequence.test.ts tests/educationSequenceFhir.test.ts tests/educationEnrollmentApi.test.ts tests/educationCatalog.test.ts tests/commsApi.test.ts tests/commsConfig.test.ts tests/commsPersistence.test.ts tests/commsSuppression.test.ts tests/reminderEngine.test.ts
```

Actual output: `tests 176`, `pass 176`, `fail 0`, `skipped 0`; exit 0. See `final-tests.txt`.

`npm --prefix mcp run build`: tsc, exit 0 (`final-build.txt`).

`npm run preflight`: 0 warnings / 0 hard blocks, exit 0 (`final-preflight.txt`). This static check does not prove live policy criteria; its output states that limitation.

`node .claude/skills/tier0-census/scripts/check-proxy-coverage.mjs`: 24 backend route families, 27 proxy entries; every discovered family covered. Advisory only.

`git diff --check`: exit 0.

## Mandate 17

Store mutation command: `npm --prefix mcp test -- tests/educationSequence.test.ts tests/educationSequenceFhir.test.ts`. Each mutation was isolated and restored. The `guard-*-red.txt` and `guard-*-green.txt` files retain actual output.

| Guard | Deliberately broken result | Restored result |
|---|---|---|
| 1 Admission idempotency | 10 pass / 2 fail; duplicate admission produced 4 rows instead of 2 | 12 pass / 0 fail |
| 2a Activation cap | 10 pass / 2 fail; whole 65-delivery activation admitted in memory and FHIR fixture | 12 pass / 0 fail |
| 2b Lifetime cap | 11 pass / 1 fail; crossing activation admitted after four 64-row activations | 12 pass / 0 fail; prior history preserved and stop still works |
| 3 Registry | Delete scheduled-send entry: preflight exit 1, one `odos-extension-url-shape` hard block | Before and restored: exit 0, 0 warnings / 0 hard blocks |
| 4 Dispositions versus sent | 11 pass / 1 fail; deliberately contaminated test query counted 2 instead of 1 | 12 pass / 0 fail |
| 5 Transition cancellation | Remove shared lifecycle checks from transition entry: 10 pass / 2 fail; prior rows remain scheduled in memory and FHIR | 12 pass / 0 fail; cancellation and stage persist together |

Guard 2c measured 256 typical scheduled rows: **254,771 serialized bytes + 409,600 reserved bytes = 664,371 bytes**, below 1,048,576. No oversized row was manufactured. Larger actual context, retained extensions, or event history can approach the budget. Final admission checks include the complete candidate Basic, including preserved metadata/extensions, immediate sends and context. Stop/reconciliation writes are not subject to admission caps. The reserve is a product allocation, not a bound on all future history growth.

Guard 4 is explicitly a test-only query over a parsed, persisted Basic carrying a historical sent outcome and scheduled dispositions, including closed. No enrollment analytics query existed or was introduced. Source inventory: EngageSheet's education-sent label reads one-shot dispatch outcomes; communications-client validates those outcomes; reservation sent state requires provider message identity; suppression counting searches Communication with completed status and a sent timestamp. Unrelated lab, Rx, referral and office sent labels have separate inputs. The mutation demonstrates the prohibited mixing; it is not evidence of production analytics implementation.

Guard 5 API coverage additionally exercises create replay after stop, transition, resume after stop, and refusal of enrollment-context one-shot dispatch. Ordinary standalone one-shot dispatch remains supported. Reserved sequence row identities cannot be used on the one-shot send path, including print.

Additional sender mutation: 27 pass / 1 fail when the later practitioner replaces the original reservation sender; restored 28 pass / 0 fail. Withdrawn-content acknowledgement: 26 pass / 1 fail before repair; restored 27 pass / 0 fail at that test stage. Subsequent final suite includes both protections.

## API contract and follow-ups for ODOS-SEQ-2

Sequence-bearing create/transition and activation admission require a caller-stable `requestId`. Reusing the binding is a retry; restarting requires a new request identity. Sequence steps have explicit stable `stepIndex`, channel/lane, pinned content, recipient reference, planned/effective instants, required latestUsefulTime, anchor/offset, and timezone/calendar interpretation. The slice validates and stores those supplied timing fields; it does not advance a clock.

Additional routes under the existing communications family: `POST /communications/education/enrollments/:enrollmentId/sequences` and `POST /communications/education/enrollments/:enrollmentId/sequences/:activationId/stop`. Stop requires a reason. Print remains a staff task; electronic sequence dispatch is unavailable in this slice.

SEQ-2 must implement attempt keys and binding, version-competing claims, frozen-attempt outcome reconciliation, fire-time recipient/consent/suppression checks, predecessor acceptance timing, pause-on-visit, latest-useful-time handling, and paginated per-record fault isolation. Preserve row IDs, activation IDs, original senderReference and append-only events. Do not treat scheduling disposition or closed as delivery evidence. Scheduled work must never inherit the staff quiet-hours exemption or drive patient stage transitions.

Explicit practitioner acknowledgement now works without a current content lookup. Ordinary automatic recovery still uses existing dispatch preparation; fully frozen recovery without current catalog/recipient/provider preparation remains worker-related follow-up. No new scheduled attempt exists here.

FHIR concurrency tests use enforcing UUID-based fakes; they do not prove the deployed Medplum instance or AccessPolicy behavior. The real-FHIR If-Match release gate remains separate. No live server test or independent evaluation ran in this slice.

No new medical terminology codes or externally defined FHIR artifact URLs were introduced; no Mandate 14 terminology ledger rows were required. No new cross-product decision was authored, so the companion decisions index was not changed. Dependency manifests and lockfiles are unchanged. No PR, push, merge, or deployment was performed.
