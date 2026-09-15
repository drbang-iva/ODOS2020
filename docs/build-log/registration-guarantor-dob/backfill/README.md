# MRN backfill age-setting integration

Author check, NOT EVALUATED. The downstream MRN backfill caller now receives the same coded setting. The CLI reads it from the authenticated active project and refuses duplicate rows. The shared resolver runs before adapter reads or writes.

`node --import tsx --test tests/setup-wizard/patient-mrn-backfill.test.ts`: 20 pass, 0 fail.

Mutation runs use `--test-name-pattern="majority setting21"` and `--test-name-pattern="majority missing"` on that file. Each green/restored run: 1 pass, 0 fail. Each red: 0 pass, 1 fail.

- setting21 mutant replaces the resolved age argument with literal 18; a nineteen-year-old receives a self guarantor incorrectly.
- missing mutant falls back to literal 18; missing configuration no longer refuses before any write.

`npm run typecheck:scripts`: exit 0. `git diff --check`: exit 0. No runtime or Iris operations performed.
