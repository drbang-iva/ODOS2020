# W54 — legacy pick failure compatibility

The existing diagnosis UI suites had success, demotion-impact and late-response coverage, but no failed-pick behavioral assertion. This slice adds a **new test to the existing** `ui/tests/diagnosisDemotionImpact.test.tsx:356` suite; it does not claim the guard pre-existed.

The test mounts the real default/legacy `DiagnosisPicker`, selects Confirm, and supplies a synthetic HTTP 403 `{ result: "forbidden", error: "Synthetic diagnosis permission refused." }`. It verifies the error remains visible, exactly one pick was sent, no success event fired, no success reload occurred, and Confirm remains available.

## Mutation

Temporarily replace only the legacy `submitDiagnosisPick` body with `return submitDiagnosisPickResult(input)`, changing its return annotation to the actual `Promise<DiagnosisPickResult>` union. The original function was saved before mutation and restored exactly afterward. No mutant remains in production.

Commands from `ui/`:

```sh
node --import tsx --test --test-name-pattern='W54' tests/diagnosisDemotionImpact.test.tsx
./node_modules/.bin/tsc --noEmit --skipLibCheck
```

| State | Behavioral test | Type check |
| --- | --- | --- |
| Original | 1 pass, 0 fail (`baseline-test.log`) | exit 0 (`baseline-tsc.log`) |
| Nonthrowing mutant | 0 pass, 1 fail (`red-test.log`) | exit 2 (`red-tsc.log`) |
| Restored | 1 pass, 0 fail (`green-test.log`) | exit 0 (`restored-tsc.log`) |

The mutant hides the explicit permission error and displays an unavailable charge-impact notice, so the behavioral guard fails. TypeScript independently rejects the union at `AssessmentSection.tsx:353` and `DiagnosisPicker.tsx:158` because their legacy success-path consumers require a demotion-impact-compatible result.

After restoration, the five existing suites run together: **90 tests, 90 pass, 0 fail, 0 skipped, 0 todo** (`restored-tests-final.log`). An intermediate restored run (`restored-tests.log`) recorded 89/90 while the parent tightened pre-pick validation; the sole failure exposed a transport fixture missing its unassigned fact from `searchIndex`. The fixture was corrected to the actual server contract, with no assertion weakened, before the final run.
