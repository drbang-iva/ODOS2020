# Editor DOB validation fixback

Source head: `1af5a4d2b10879459fa14dbfee8b50bc131af8b4`. Author checks; NOT EVALUATED.

The finding about missing runtime DOB validation is accepted. Requiring DOB for chart edits would contradict C1/R1: existing guarantors are not forced to supply it. The editor therefore refuses malformed, impossible and future nonblank dates before any write, while allowing today, blank clearing and legacy records without DOB. Empty DOB clears the Person field instead of serializing an invalid empty date. No child projection or hash change.

Writer-derived, JSON-round-tripped tests: 2 pass, 0 fail. Initial tests: 0 pass, 2 fail. Removing validation: 1 pass, 1 fail; restored 2 pass, 0 fail. Forcing DOB on optional edits: 1 pass, 1 fail; restored 2 pass, 0 fail.

Commands:

```sh
node --import tsx --test --test-name-pattern='Editor DOB' mcp/tests/guarantorDob.test.ts
node --import tsx --test mcp/tests/guarantorDob.test.ts mcp/tests/guarantorOwnedRecovery.test.ts mcp/tests/guarantorLinkOperation.test.ts mcp/tests/guarantorPhoneRecovery.test.ts
# from ui/
node --import tsx --test tests/guarantorEditor.test.tsx tests/guarantorPhoneForm.test.tsx tests/guarantorLinkOperations.test.tsx tests/guarantorPropagation.test.tsx
# from root
npx tsc --noEmit -p ui/tsconfig.json
```

Focused MCP: 62 pass, 0 fail. Focused UI: 52 pass, 0 fail. UI typecheck and diff whitespace check exit 0. Local paths in logs normalized to `<workspace>` / `<home>`. No containers started or runtime operations performed.

D4 reproof after validation (source `e7712e146e03207dd8246676532b61a1d994aadf`): remove the shorthand `birthDate` field from the intended Person write. Green 1 pass / 0 fail; mutant 0 pass / 1 fail; restored 1 pass / 0 fail. Command from `ui/`: `node --import tsx --test --test-name-pattern=D4 tests/guarantorEditor.test.tsx`. Mutation restored byte-for-byte.
