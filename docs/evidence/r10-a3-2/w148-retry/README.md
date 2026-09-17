# W131/W148 final Retry fix — retain the submitted capture

The final fix retains the original capture and notice ids alongside the frozen request body. An identical Retry marks only that original capture pristine; edits and replacement notices staged after the original submission remain unsaved. Editing stays possible during the first request, preserving the unchanged EXAM-1B in-flight-edit test. All Normal cannot alter the unresolved Retry state.

CodeRabbit's outside-diff in-flight edit finding is accepted. Its suggested editing lock was tried at 9adf0396, but the full UI suite reported 1,750 pass / 1 fail: EXAM-1B in-flight edit remains unsaved after the older request completes. That requirement is preserved, with no assertion edit. The failed candidate was not pushed. The final snapshot fix uses CodeRabbit's alternative of retaining the submitted snapshot with the frozen body.

Focused set: 13/13 including the unchanged EXAM-1B guard. Initial regression: 0 pass / 1 fail. Replacing the frozen submitted capture with current edits: 11 pass / 2 fail, restored 13/13. Replacing frozen notice ids with the current notice ids: 12 pass / 1 fail, restored 13/13. Exact single-anchor mutations and byte restoration are recorded. W148 notice removal remains red/green as recorded in ../w148; render behavior is unchanged.

Tests: W131/W148 identical Retry retains its original capture and leaves later edits unsaved; W148 retrying an older All Normal request retains a later replacement notice as unsaved. The earlier W148 OD/OS notice, remarks and retry-notice tests remain. all-assertion-ledger.json is the complete final assertion ledger versus 3222c6f2: 57 -> 88 assertion expressions, five changed groups, W133/W148 and W131 mappings. No pre-existing assertion was weakened or deleted; candidate-only lock assertions were replaced when the candidate was rejected by the unchanged full-suite guard.

The inline encounter-navigation review finding is rejected for the actual route: App.tsx keys EncounterCharting by encounterId, remounting its entire editor state on visit navigation. Individual reply remains on PR621. No app routing or MCP source changes.

Final full checks, clean-head served (a)-(h), W148 screenshots, SSE and CI/review evidence are in .odos/r10-a3-2-w148-sealed. HELD OPEN; never merge.

NOT EVALUATED

Coded-by: Codex — GPT-6 Astra, high effort
