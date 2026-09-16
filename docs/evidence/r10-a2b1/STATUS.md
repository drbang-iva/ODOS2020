# R10 A2b.1 partial implementation checkpoint

**BLOCKED pending operator scope ruling. NOT EVALUATED. No PR opened or pushed. Never merge this slice.**

Base and freshly fetched origin/main: `4b3f6d7c25fb40268e216dcd22ad03a866d03643`. Task branch `drbang-iva/r10-a2b1`. All eleven §2 premise groups checked at the exact baseline. Wording caveat: missing resource/id in the reader previously returned `missing`, whereas other malformed pages returned `refused`; §3.4/3.9 authorize both becoming `upstream`.

## Completed bounded work

Reader §3.4: 410 → missing; audit lookup and malformed entry/link errors → upstream; projection exposes preRebuild. Reader assertion ledger and TDD outputs are in `reader/`. Writer partial §3.4 and its evidence are in `writer/`. No endpoint, UI, policy, route or clinical terminology edits.

## Author verification

Integrated reader + writer + parity: **252 tests, 252 pass, 0 fail, 0 skip** (34 reader, 48 writer, 170 parity). W38 and W44 each: mutated 1 test / 1 fail, restored 1 test / 1 pass. Integrated MCP build exit 0; git diff --check exit 0. Integration corrected TypeScript narrowing of the captured initial incomplete state. See raw evidence. Commits: reader `0f1f884c`; writer `6eb7cbde`.

Files changed: `mcp/src/clinical-graph/current-finding-reader.ts`, `mcp/src/clinical-graph/current-finding-writer.ts`, their two test files, and evidence under this directory. All within §4.

## Scope blocker

The command replay classifier cannot detect a reassertion command reused with a changed baseline using the existing audit payload. The stored tag is SHA256(commandId | target | kind | digest), with no separately recoverable command/target/baseline witness. The executed probe applies reassertion C at version 1, changes the source version, and retries C with the fresh baseline: classification is not-replay and the existing library writes a second audit. This library behavior was not silently changed.

Operator question pending: authorize a command/target/digest witness on newly written reassertion audits, extending §3.4 audit payload scope, or return the gap to Opus. No audit payload format change has been made.

## Approved guard adjustment

W38's specified [fact, fact] fixture has submitted order [0, 1] and execution order [0, 1], even when outcomes are applied/conflict. Operator explicitly approved the existing library [legacy-retire, fact] fixture for the ordering mutation, retaining the two-fact partial-failure test. This does not permit legacy targets through the diagnosis door.

## Not run / outstanding

Findings GET/PUT, repair route, candidates, pick, pagination, live-authz suite registration, A3 checker/scenarios, endpoint guards, full MCP/UI checks, preflight, live concurrency/retry proofs, rebase verification, push and PR remain outstanding. The contract's amendments-first order was preserved. Reader and writer checks are author verification, never independent evaluation.

No containers were started; none require stopping. No new decision was made in this checkpoint, so no decisions/INDEX.md change. No medical codes or FHIR artifact URLs were introduced, so no Mandate 14 ledger rows. Follow-up: operator/Opus ruling on the replay audit witness, then resume this branch and complete §3.1–3.9 and the required evidence.
