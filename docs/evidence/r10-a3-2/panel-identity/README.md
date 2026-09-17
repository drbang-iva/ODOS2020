# Returned panel identity — approved A3.2 scope exception

Implements §13 “Ruling 09-17 (PR-Agent panel-replay finding)” read from performance-od origin/main. Only executePanel's non-created branch changes: the returned existing Observation must carry the requested panel identifier and command patient/encounter references before replay is credited or audited. The fact path and A3.1 branch are unchanged.

Five W71/W112/W117 cases exercise the actual conditional-return branch: foreign-valid-panel, different-eye-valid-panel, foreign-subject, foreign-encounter, same-panel. Initial red: 1 pass / 4 fail. Restored: 5/5. Genuine replay returns already-applied twice and has exactly one audit. Rejected returns have zero subsequent writes and zero audits; the conditional request itself has already occurred.

Mutations require exactly one anchor and restore source bytes in finally. Removing identifier matching yields 4 pass / 1 fail (the different-eye valid panel is incorrectly credited); restoring yields 5/5. Removing subject/encounter matching yields 3 pass / 2 fail; restoring yields 5/5. This second mutation loses the explicit verify-read identity refusal: the pre-existing envelope validator still rejects these mismatched-reference fixtures with zero writes. It is not evidence that removing this redundant defense alone permits an audit leak. The deliberate missing-anchor probe exits 1 and names the missing anchor/file; no code change is made.

Focused suites: currentFindingWriter 50/50, r10A3Library 56/56, r10A3OcularDoor 62/62, r10A3DoorGuards 14/14, r10A3ReleaseScenarios 16/16. Combined 198/198; zero failures/skips/todo. Full output and exact counts are alongside this file.

The assertion ledger compares d6a98fee5483c6b5173ebb1fa2ae3e5b15ecea06 to this change: 84→96 assertion expressions, one new parameterized test group; existing assertions unchanged. Full checks, the clean-head served proof, W148, SSE, CI live lanes and review are sealed after commit under `.odos/r10-a3-2-panel-identity/`.

NOT EVALUATED

Coded-by: Codex — GPT-6 Astra, high effort
