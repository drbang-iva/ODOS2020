# Leap-day fixture regression

Base source: `1af5a4d2b10879459fa14dbfee8b50bc131af8b4`. Test-only correction: the synthetic 19-year-old now uses January 1 of the year 19 years before today. That is a valid birth date throughout the year and preserves both D6 thresholds (adult at configured 18; minor at configured 21). Production code is unchanged.

Commands ran from `ui/`. The committed preload mocks Date for both fixture construction and EngageSheet's current-date calculation. The exact mocked timestamp is printed in each log.

```sh
ODOS_MAJORITY_TEST_DATE=2028-02-29T12:00:00.000Z node --import ../docs/build-log/registration-majority-ui/leap-day/mock-clock.mjs --import tsx --test tests/ageOfMajority.test.tsx
ODOS_MAJORITY_TEST_DATE=2026-09-15T12:00:00.000Z node --import ../docs/build-log/registration-majority-ui/leap-day/mock-clock.mjs --import tsx --test tests/ageOfMajority.test.tsx
```

- Leap day green: 6 tests, 6 pass, 0 fail; exit 0.
- Ordinary day green: 6 tests, 6 pass, 0 fail; exit 0.
- Mutation: restore the old year-minus-19 plus current-month/day fixture expression, then repeat the leap-day command. Its invalid `2009-02-29` date is refused by the real patient writer before the suite loads: 1 test-file failure, 0 pass, exit 1, `Date of birth must be a valid YYYY-MM-DD date.`
- Restore January 1 and repeat leap-day command: 6 tests, 6 pass, 0 fail; exit 0.

Author evidence only. NOT EVALUATED.
