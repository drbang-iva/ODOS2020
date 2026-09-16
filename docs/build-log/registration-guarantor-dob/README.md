# Guarantor DOB author evidence

Base: `6d41a717`; no contract-anchor drift. C1/C2 only. NOT EVALUATED.

Each `D*-green.tap`, `D*-red.tap`, `D*-restored.tap` records one test: green/restored 1 pass, 0 fail; red 0 pass, 1 fail. Mutants restored before regression runs.

- D1: make registration DOB optional and remove the date validation; missing DOB is accepted instead of returning 400 before service calls.
- D2: make the create DOB schema optional; missing DOB writes a Person instead of returning 400.
- D3: add Person birthDate to the demographic projection; both child insurance DOBs become the new Person DOB. The restored writer-derived two-child history has two coverages and zero suspected overwrites.
- D4: remove birthDate from the intended Person editor write; the real editor loses the changed DOB. Fixture derives from the registration writer and JSON transport.
- D5: remove birthDate from returned search cards; cards omit the expected DOB and empty string. Fixture derives from the create writer and JSON transport.

Commands (from task worktree root unless stated):

```sh
node --import tsx --test --test-name-pattern=D1 mcp/tests/patientRegistrationAuthz.test.ts
node --import tsx --test --test-name-pattern=D2 mcp/tests/guarantorSearchScreens.test.ts
node --import tsx --test --test-name-pattern=D3 mcp/tests/guarantorDob.test.ts
# from ui/
node --import tsx --test --test-name-pattern=D4 tests/guarantorEditor.test.tsx
# from root
node --import tsx --test --test-name-pattern=D5 mcp/tests/guarantorSearchScreens.test.ts
node --import tsx --test mcp/tests/guarantor*.test.ts mcp/tests/patientRegistration*.test.ts
# from ui/
node --import tsx --test tests/guarantor*.test.tsx tests/patientRegistration*.test.tsx tests/patientIdentity.test.tsx
# from root
npx tsc --noEmit -p mcp/tsconfig.json
npx tsc --noEmit -p ui/tsconfig.json
```

Focused MCP: 190 pass, 0 fail. Focused UI: 107 pass, 0 fail. Both type checks exit 0 with empty output. Full regression, live proof, age setting guards, CI and bot review belong to the integration bundle. No fixture containers started by this worker.
