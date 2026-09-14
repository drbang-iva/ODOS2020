# Correct operation UUID fallback proof

With `crypto.randomUUID` unavailable, the existing Correct handler failed before sending its POST. The new component regression reproduced this: two explicit clicks yielded zero requests. [Before-fix TAP](before-fix.tap) records the failed request-count assertion; the native UUID path passed in the same run.

Implementation commit `4bc9091d7849fb6c96e558d4c4bdd12c37f0a7cc` keeps native `randomUUID()` when available. Otherwise, this operation helper obtains 16 bytes from `crypto.getRandomValues`, sets the UUIDv4 version and variant bits, and sends the formatted ID alongside the existing correction reason. No dependency or other UUID caller changed.

The [Web Cryptography API specification](https://w3c.github.io/webcrypto/#crypto-interface), accessed 2026-09-14, marks `randomUUID` as requiring a secure context and leaves `getRandomValues` available without that restriction. Section 10.1.1 specifies cryptographic random bytes; section 10.1.2 specifies the version and variant bits and hexadecimal formatting used here. This is a Web API compatibility repair and introduces no clinical code or FHIR artifact URL.

The fallback test clicks the actual Responsible parties Correct control twice after entered text. The transport refuses each request with HTTP 409, retaining the same pending Task and reason for the next explicit click. Each POST carries the entered reason and a distinct valid v4 UUID. Its `getRandomValues` wrapper calls the real CSPRNG, then forces the two reserved bytes to non-v4 values so deleting either bit mask fails deterministically. A separate test verifies that an available native UUID is used without calling the fallback.

## Checks

Only two tests were appended to `ui/tests/guarantorLinkOperations.test.tsx`; its original twelve tests and fixture remain a byte-identical prefix. The existing editor, propagation, and demographics concurrency test files were untouched.

[Focused TAP](focused.tap) records **48 tests, 48 passed, 0 failed**: operation guards 14, editor 9, propagation 22, demographics concurrency 3. TypeScript checking returned exit 0 with no output. [results.json](results.json) records the exact commands, counts, implementation commit, and source hashes.

All four source mutations produced their intended failure, and every restored run passed both targeted tests:

| Mutation | RED | Restored GREEN |
| --- | --- | --- |
| Remove UUID fallback | [Exit 1](fallback-removed-red.tap): zero Correct requests | [2/2](fallback-removed-restored.tap) |
| Remove version mask | [Exit 1](version-mask-removed-red.tap): invalid v4 UUID | [2/2](version-mask-removed-restored.tap) |
| Remove variant mask | [Exit 1](variant-mask-removed-red.tap): invalid v4 UUID | [2/2](variant-mask-removed-restored.tap) |
| Remove native preference | [Exit 1](native-preference-removed-red.tap): fallback called despite native method | [2/2](native-preference-removed-restored.tap) |

The eleven TAP files preserve the actual output, with absolute worktree paths replaced by `<worktree>` and whitespace-only diagnostic lines blanked. Original logs remain ignored. These checks use synthetic transport and are author evidence. Browser captures, live FHIR/policy proof, and independent evaluation remain separate; none was changed or run for this repair.
