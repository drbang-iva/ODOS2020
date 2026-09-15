# Rebased DOB guard verification

Exact starting head: `befd48ef2888acf796ad82be7091b09f2b9a17b7`, rebased onto `40c19a9e`. Author verification, NOT EVALUATED. Ran in a fresh isolated worker; root checkout untouched.

D1-D5 each: green 1 pass / 0 fail; deliberate mutant 0 pass / 1 fail; restored 1 pass / 0 fail. Commands and mutation descriptions remain in the parent evidence README. All mutations restored byte-for-byte. UI commands ran from `ui/`.

The complete `guarantorEditor.test.tsx` also passes after restoration, retaining both upstream K4 inert-claim coverage and D4 Person DOB coverage. Exact output is in `editor-restored.tap`. No production changes and no containers started.
