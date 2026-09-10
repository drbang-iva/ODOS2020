# PR #569 fixback 2: shared enrollment conflict translation

Status: needs independent re-evaluation by Claude Opus 5 (EXTRA); tier unchanged. Codex authored this change and does not claim an independent verdict. No merge or deployment.

Branch: `drbang-iva/education-seq-1`. Base: `71557027182638f14fb5259d5182329a6b1191d8`. Isolated task worktree: `/private/tmp/odos-seq-1-fixback-2`; the existing detached evaluation worktree and root checkout were not modified. Refreshed ODOS origin/main: `2047ace47bf31ba1a28759075af05157668f6081`; no rebase onto main. Kickoff read in full from the verified companion checkout and from its commit `18392b48`; its explicit expansion of the previous fixback is consistent with that earlier kickoff.

## Change and files

- `mcp/src/comms/education-enrollment.ts`: move the existing conflict translation to the awaited If-Match update inside mutateEnrollment. Remove the admitSequence and stopSequence wrappers. No other production change.
- `mcp/tests/educationEnrollmentApi.test.ts`: append two lifecycle HTTP races, upstream 409 and 412. All four existing admit/stop races remain byte-identical.
- `mcp/tests/educationSequenceFhir.test.ts`: append an AST guard locating every direct helper caller and verifying that the helper's single update is awaited in the translating try, with the existing typed conflict and non-conflict rethrow.
- `docs/build-log/education-seq-1/fixback-2-*`: six break/restore logs and three final check logs; this bundle is `fixback-2.md`.

The lifecycle fixture creates an enrollment, claims its immediate send, admits a held sequence, and acknowledges the indeterminate original attempt through real production store methods. POST resume then reaches enforceEducationLifecycle and attempts to release the held row. The version-enforcing fake advances its UUID version between read and update. Each HTTP test asserts the exact 409 refusal body, one update attempt, all persisted content unchanged except the competing version, the row still held, no Provenance, and zero SMS/email sends. An explicit subsequent HTTP retry with the race disabled releases the row with exactly one additional write. No store.transition call or clock behavior was added.

## Break-and-restore proof

Before implementation, the new lifecycle tests returned 502 for both upstream statuses; the structural guard failed because the helper had no translating try (39 tests: 36 pass, 3 fail).

Each recorded mutation was verified in place; each red log includes its actual diff from the fixed source. Each restored run checks byte-identical source restoration and records its SHA-256. Commands and full outputs are embedded in the logs. No mutant remains.

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| 1: lifecycle HTTP | Remove shared translation | 2 tests, 0 pass, 2 fail; actual 502, expected 409; exit 1 | 2 pass, 0 fail; exit 0 |
| 2: unchanged admit/stop HTTP | Remove shared translation, wrappers still absent | 4 tests, 0 pass, 4 fail; actual 502, expected 409; exit 1 | 4 pass, 0 fail; exit 0 |
| 3: structural coverage | Restore original production file: translation back in admit/stop, existing third caller applyLifecycle untranslated | 1 test, 0 pass, 1 fail: shared write has no translating try; exit 1 | 1 pass, 0 fail; exit 0 |

Guard 3 is reachable as specified. The third untranslated caller already exists, so restoring the original arrangement supplies the requested bypass without adding an artificial fourth method. The AST guard binds coverage to the shared awaited write and enumerates direct callers; adding a caller requires updating that explicit census. This is a bounded structural guard, not a proof about arbitrary future JavaScript, aliasing, or unrelated writers.

Targeted commands:

```sh
npm --prefix mcp test -- '--test-name-pattern=sequence HTTP lifecycle lost' tests/educationEnrollmentApi.test.ts
npm --prefix mcp test -- '--test-name-pattern=sequence HTTP (admit|stop) lost' tests/educationEnrollmentApi.test.ts
npm --prefix mcp test -- '--test-name-pattern=mutateEnrollment structurally' tests/educationSequenceFhir.test.ts
```

Full original ten-file suite, exact command in `fixback-2-final-tests.txt`:

```text
1..185
# tests 185
# suites 0
# pass 185
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Exit 0; prior suite 182 plus three new tests. `npm --prefix mcp run build`: tsc, exit 0. `npm run preflight`: 0 warnings, 0 hard blocks, exit 0. Preflight's scope-scanner limitations remain in the full output; it does not establish live policy enforcement. `git diff --check`: exit 0.

## Complete caller census after change

All locations below are in `mcp/src/comms/education-enrollment.ts`.

| Caller | Line | Coverage |
|---|---:|---|
| admitSequence | 322 | shared translation at 1032-1037; unchanged 409/412 HTTP races |
| stopSequence | 325 | shared translation at 1032-1037; unchanged 409/412 HTTP races |
| applyLifecycle | 327 | shared translation at 1032-1037; new 409/412 HTTP races |

Helper declaration: 1019. Exactly three direct calls, one shared awaited update at 1033.

## Other version-checked writes found, all unchanged

Search scope: education-enrollment.ts, education-sequence.ts and comms-api.ts. Seven other writes were found; none is in the authorized helper-refactor scope.

| Write | Location after change | Existing handling and scope decision |
|---|---|---|
| create: repair immediate-send keys after server-assigned enrollment ID | education-enrollment.ts:315 | Uses enrollmentVersionHeaders; raw failures propagate. Out of scope. |
| claimImmediateSend | education-enrollment.ts:358 | On conflict re-reads and returns claimed:false. Distinct claim contract; out of scope. |
| recordImmediateSendOutcome | education-enrollment.ts:389 | Version checked, raw failures propagate. Distinct outcome persistence; out of scope. |
| transition | education-enrollment.ts:404 | Typed stale-from-stage conflict. Explicitly excluded, untouched. |
| markImmediateSendIndeterminate | education-enrollment.ts:434 | Version checked, raw failures propagate. Distinct acknowledgement persistence; out of scope. |
| clearTerminalActiveIdentifier | education-enrollment.ts:450 | Version checked, raw failures propagate. Distinct terminal identifier release; out of scope. |
| updateEducationRecipient | comms-api.ts:2095 | If-Match update of Patient/RelatedPerson telecom; raw failures propagate. Different resource and operation; out of scope. |

These are disclosed deferred surfaces, not silently converted to the sequence admission error. No claim that every write in ODOS uses this helper or this error contract.

## Preserved contracts, risks and next step

EducationSequenceAdmissionError and its message are unchanged. comms-api.ts, including its existing 409 refusal mapping, is byte-identical to base. The transition method, stale-from-stage semantics, and its existing tests are unchanged. No new field, resource type, AccessPolicy row, worker, clock, dependency, or unrelated behavior.

The tests exercise real local HTTP routes and production store code backed by a version-enforcing synthetic FHIR fake. They do not prove live Medplum If-Match/AccessPolicy enforcement, a served front-door proxy, or deployment. Independent evaluation remains required at the pushed head; old PASS markers cannot apply. Per the operator's explicit push-and-stop instruction, bot completion is not claimed and no new PR is opened.

No new design decision: decisions/INDEX.md unchanged. No clinical codes or FHIR artifact URLs added: no Mandate 14 ledger rows required. Cross-repo follow-up: Claude Opus 5 (EXTRA) independently re-evaluates the updated head; no new design work is proposed.
