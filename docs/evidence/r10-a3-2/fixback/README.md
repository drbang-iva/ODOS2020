# PR621 independent-review fixback

Coded-by: Codex — GPT-6 Astra, high effort

NOT EVALUATED. HELD OPEN. Review baseline4e351b1642a94f0603fb4a70fbc5d10e544e9a8a. The previous GPT-5 setup turn only fetched/read state; GPT-6 Astra authored this fixback.

The adopted evaluator items are implemented in order. Pending All Normal acts survive compatible edits; overview expectations are mandatory; the response proxy streams non-dropped replies; saved diagnoses retain truthful partial-success messages; proof paths/browser configuration and missing carry errors are repaired. DiagnosisWorkspace source and its existing assertions are unchanged.

- `test-counts.json`: actual red/restored counts for every item; `*-mutation-case.json` are executable exact-one-anchor cases through `mutate.py`.
- `anchor-miss.log`: a deliberately absent anchor fails loudly before touching source. Every mutation restores original bytes in finally.
- `all-assertion-ledger.json`: every changed assertion versus4e351b16, with V/W mappings. New tests have empty before lists.
- `overview-expectation-delta.json` and `overview-expectation-review.md`: the missing14 literal expectations and their review against fixture inputs, V27. No production MCP file changed in this fixback.
- `checks.json`: full UI1747/1747, MCP5952pass/0fail/53skip of6005, both builds, scripts typecheck, preflight, strictT1–T22.
- The core MCP wrapper uses CI=true and ODOS_ALLOW_UNGATED_MCP=1 to acknowledge the same credential-dependent skips as the CI core lane. It is not live-authorization proof. Final GitHub CI live integration and authorization lanes remain separately required.
- Initial helper-test logs ending `.fixture-invalid` lacked a window shim and are excluded from proof; corrected tests and their mutation are recorded separately. No assertion was weakened.

Final clean-commit route proof, SSE initialization through the real front door, exact-head CI/bot dispositions, and container shutdown are recorded after the final commit under `.odos/r10-a3-2-fixback/` and summarized in the PR description. Those outputs are deliberately outside tracked paths so identity.json can attest dirty:false at the actual PR head. Step(a) is the exact#619 comparison; steps(b)–(h) use the final PR application.

The positive-selection editor regression checks act removal and handling of a server refusal response. The refusal response is injected in that UI test; unchanged MCP negative-scope guards remain the server authority. It does not claim that every request without a negativeAct is refused.
