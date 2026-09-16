# UI age-of-majority guard evidence

Commands ran from `ui/`, using writer-built, JSON-round-tripped fixtures. These are author checks, not an independent evaluation.

- Green: `node --import tsx --test tests/ageOfMajority.test.tsx` — 6 tests, 6 pass, 0 fail.
- Restored: `node --import tsx --test tests/ageOfMajority.test.tsx tests/practiceSettings.test.tsx` — 8 tests, 8 pass, 0 fail.
- D6 red: replaced the shared-resolver call in `isMinorOn` with the previous `+ 18` calculation. `node --import tsx --test --test-name-pattern='D6' tests/ageOfMajority.test.tsx` — 1 test, 0 pass, 1 fail. Restored: 1 pass, 0 fail.
- D7 red: changed `isMinorOn` to use 18 when its setting is absent. `node --import tsx --test --test-name-pattern='D7 UI missing' tests/ageOfMajority.test.tsx` — 1 test, 0 pass, 1 fail. Restored with all guards green.
- D7 duplicate red: removed the multiple-singleton refusal from the UI loader. `node --import tsx --test --test-name-pattern='D7 UI duplicate' tests/ageOfMajority.test.tsx` — 1 test, 0 pass, 1 fail. Restored with all guards green.

The unchanged guard assertions also exercise actual EngageSheet rendering: a 19-year-old uses guardian recipients at configured 21; missing, invalid, duplicate, and deleted-on-reopen settings expose no recipient labels and show the explicit unconfigured message. The settings save check inspects the real FHIR update request's If-Match header and writer-built resource.

Full UI regression on the worker's integrated UI changes: `npm test` from `ui/` — 1565 tests, 1565 pass, 0 fail (198713.956 ms). The later semantic styling replacement does not change behavior. The root task must rerun the full integrated suites at its final head.
