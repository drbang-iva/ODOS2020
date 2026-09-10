# ODOS-SEQ-2 precondition author evidence

Base: `0ddc50c4208234e174640fec8677dc38b1b94f2d`. Branch: `drbang-iva/education-seq-2`.

The four existing writes (creation key repair, outcome recording, indeterminate acknowledgement, terminal identifier release) now share `updateEnrollmentResource` with `mutateEnrollment`. Both FHIR 409 and 412 translate to `EducationSequenceAdmissionError("stale-enrollment-version")`, returned as typed HTTP 409. Immediate-send claim and transition implementations are unchanged. No worker code is included in this commit.

Retained the prior session's 81 drafted route-test lines. Eight cases drive the real store through HTTP with UUID If-Match races. Outcome-write recovery proves one provider call across a failed write and resumed reconciliation. Acknowledgement and terminal-release retries are also exercised.

## Commands and results

Prefix for test commands: `npm --prefix mcp test -- --ui-root /Users/ericr.bang/GitHub/ODOS2020/ui`.

- Baseline before drafted tests: `tests/educationEnrollmentApi.test.ts tests/educationEnrollment.test.ts tests/educationSequence.test.ts tests/educationSequenceFhir.test.ts`: 52 tests, 52 pass, 0 fail, 0 skipped.
- Drafted tests before implementation: `tests/educationEnrollmentApi.test.ts`: 42 tests, 34 pass, 8 fail, 0 skipped. All eight failed on actual HTTP 502 versus expected 409.
- After migrating outcome recording first: same API command, 42 tests, 36 pass, 6 fail. Only the other three untranslated paths remained red.
- All four paths corrected: four-file command above, 60 tests, 60 pass, 0 fail, 0 skipped.
- `npm --prefix mcp run build`: tsc exit 0.
- `npm run preflight`: 0 warnings, 0 hard blocks, exit 0.
- `git diff --check`: exit 0.

## Guard 8 break and restore

Mutation: bypass the shared translator only at outcome recording, replacing its helper call with direct `fhir.update` using the same required version header. Confirmed the mutated line in source before running.

Command (same npm prefix): `tests/educationEnrollmentApi.test.ts tests/educationSequenceFhir.test.ts`.

RED: 47 tests, 44 pass, 3 fail, 0 skipped. Two outcome-route cases returned HTTP 502 instead of typed 409; the shared-helper caller inventory detected the bypass.

Restored byte-identical source (`cmp` exit 0). GREEN: 47 tests, 47 pass, 0 fail, 0 skipped.

Guards 1–7 and 9 are worker work and have not run. All nine were checked for reachable scenarios before implementation. Guard 9 requires an unresolved blocker for an acknowledgement hold; a legitimately released row is no longer held.

## Limits

Author checks only, not independent evaluation. Synthetic enforcing FHIR fakes prove route translation and recovery, not live Medplum authorization. No new medical codes or FHIR artifact URLs; no Mandate 14 ledger changes or new design decisions. Independent evaluation remains Claude Opus 5 (EXTRA). No PR, push, or merge authorized.
