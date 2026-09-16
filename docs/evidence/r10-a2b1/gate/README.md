# R10 A2b.1 A3 release gate — author evidence

Base `15722129`; isolated branch `drbang-iva/r10-a2b1-gate`. NOT EVALUATED. No containers, live systems or clinical data used.

## Gate

`node mcp/scripts/check-r10-a3-release.mjs --strict` exits 1 and names every open T1–T22. The default invocation also exits 1 while the release is blocked. Fixed expected IDs and suite requirements live in the checker, independently of the manifest. The manifest cannot remove a requirement by deleting its row. Every expected suite must have exactly one literal scenario declaration and exactly one completed TAP result. The checker refuses todo, skip, failure, missing/duplicate/wrong-suite entries, child failure and malformed/truncated TAP. Child processes clear Node's inherited test-worker context so nested execution emits real TAP.

The isolated green fixture lives under `mcp/tests/fixtures/r10/a3-checker-green/`; its mock scenarios test checker behavior only, never clinical behavior. `--root` selects that fixture for checker testing. Root-level UI files are untouched.

## Scenarios

16 actual MCP scenarios call existing production paths with synthetic canonical findings. All retain `{ todo: "R10 A3" }`, including T12 (void/undo) and T20 (no exam-PDF consumer found) whose current assertions pass. The other 14 currently expose gaps. They are not release proof and do not claim those gaps fixed.

UI-only slots T4/T5/T6/T15/T16/T18 remain missing by design until A2b.2/A3. T17/T21/T22 require both MCP and UI; their UI slots also remain missing. The checker lists every missing slot.

T21 probes Ocular Health history/capture; T22 probes section finding writes. Their broad “every consumer” / “every production finding write path” acceptance requires a complete inventory and additional executable probes in A3. These bounded probes do not establish those universal claims. The todo markers must not be lifted until that work is complete. No extra inventory policy was invented in this slice.

## Verification

- `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/r10A3ReleaseChecker.test.ts mcp/tests/r10A3ReleaseScenarios.test.ts`: 30 tests; 14 pass, 0 fail, 16 todo, 0 skip; exit 0. See `combined.txt`.
- Initial checker test-first red: missing implementation module. Footer-completion regression: 13 pass, 1 fail before enforcement; final checker: 14/14.
- W40 green fixture mutations: delete T1 test; delete T1 test AND manifest entry; mark T1 skipped. Each exits 1 naming T1; each restored fixture exits 0 naming all T1–T22. Separate red/green captures are included.
- Additional checker tests reject duplicate test, wrong suite, todo, failed assertion, child failure, malformed header, incomplete footer, inconsistent plan and duplicate TAP numbering.
- `npm --prefix mcp run build`: exit 0 (`build.txt`).
- `git diff --check`: exit 0.
- Actual release checker: expected exit 1; all T1–T22 open (`release-check-expected-red.txt`).

## Assertion and scope ledger

No pre-existing file/assertion was modified. All checker/fixture assertions map to §9 and W40. Each new scenario's assertions map to its same-numbered §9 T row. No clinical code values or FHIR artifact URLs were introduced; fixtures reuse existing builders/constants and synthetic identity values. No Mandate 14 ledger change or new strategy decision. UI slots and broad A3 scenario expansion are cross-slice follow-ups.
