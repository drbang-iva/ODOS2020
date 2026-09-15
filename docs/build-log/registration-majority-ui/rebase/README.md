# UI guard re-verification after rebase

Source under test: `befd48ef2888acf796ad82be7091b09f2b9a17b7`, rebased onto `40c19a9e`. Author-side verification only; NOT EVALUATED.

All commands ran from `ui/` in a fresh isolated worker at that source. No production or test changes are included. `git diff --exit-code -- ui/src ui/tests` returned exit 0 after restoration.

| Guard | Mutation | Command | Red | Restored |
| --- | --- | --- | --- | --- |
| D6 UI | Replace shared-resolver calculation in `isMinorOn` with `+ 18` | `node --import tsx --test --test-name-pattern='D6' tests/ageOfMajority.test.tsx` | 1 test, 0 pass, 1 fail; exit 1 | 1 test, 1 pass, 0 fail; exit 0 |
| D7 UI missing | Use 18 when `isMinorOn` receives no setting | `node --import tsx --test --test-name-pattern='D7 UI missing' tests/ageOfMajority.test.tsx` | 1 test, 0 pass, 1 fail; exit 1 | 1 test, 1 pass, 0 fail; exit 0 |
| D7 UI duplicate | Remove loader's multiple-singleton refusal | `node --import tsx --test --test-name-pattern='D7 UI duplicate' tests/ageOfMajority.test.tsx` | 1 test, 0 pass, 1 fail; exit 1 | Included in final full guard run below |

Initial green and final restored: `node --import tsx --test tests/ageOfMajority.test.tsx tests/practiceSettings.test.tsx` — both 8 tests, 8 pass, 0 fail; exit 0. Exact output is in the adjacent logs.
