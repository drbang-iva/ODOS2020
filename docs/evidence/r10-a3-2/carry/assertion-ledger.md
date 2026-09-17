# Carry assertion ledger

Base: a211b36887b49139ab29cf2d811a5a30f261034d. No commit created by this subtask.

## Existing assertions changed

`ui/tests/diagnosisCarryForward.test.tsx`, test `checked prior diagnoses select without POST while unchecked pulls are idempotent and row-specific`, two exact body assertions:

- Before first: `{sourceEncounterReference: "Encounter/recent", sourceConditionReference: "Condition/source-a"}`.
- After first: those same fields plus `commandId`; a new preceding assertion requires UUIDv4 format.
- Before second: `{sourceEncounterReference: "Encounter/older", sourceConditionReference: "Condition/source-b"}`.
- After second: those same fields plus `commandId`; a new preceding assertion requires it differ from the first command.
- Mapping: W142 and kickoff section 3.5 (required UUIDv4 command and identity-preserving replay). No existing source-reference, row-state, selection, concurrency, pagination, or authorization assertion weakened or removed.

## New tests and mutations

- W142 partial result: steps visible, no premature selection, same serialized body and command on Finish carrying. Mutation regenerating commands: 2 failed, 0 passed across W142 tests.
- W142 dropped response: identical resend, completed selection only after confirmation.
- W143: pending reload prevents POST; completed reload precedes new UUID command and replan:true. Skip reload mutation: 2 failed, 0 passed. Missing replan mutation: 1 failed, 1 passed. Reused command mutation: 1 failed, 1 passed.
- W143 failed reload: prior carry remains, no new POST.
- W145: count 2 displays notice even with empty encounters, count 0 suppresses it. Ignored count mutation: 1 failed, 0 passed.

Initial restored dedicated suite: 20 passed, 0 failed, 0 skipped. This predates the five carry integration follow-up cases; final dedicated suite is 25 passed, 0 failed, 0 skipped (carry-integration/carry-integration-green.log). Baseline run with unchanged tests: 5 failed (the added W guards). All mutations restored using exact source anchors and finally cleanup.

## Limitations

The live A3.1 previous-exams endpoint does not emit unscopedCount; PreviousExams renders it if supplied. Actual definition-wide Ocular Health history emits it. No server changes were made. Harness/browser proof is a separate obligation.

## Exact final-head reconciliation

Current test name is `read-only checked prior diagnoses select without POST while provider pulls are idempotent and row-specific`. See carry-integration/assertion-ledger.md for the capability fixture change and `../all-assertion-ledger.json` for exact base/final assertion source. The checked-row no-POST promise now applies to read-only selection; a provider verifies persisted carry completion through the existing server command before selection. Mapping V25/V36/W143.
