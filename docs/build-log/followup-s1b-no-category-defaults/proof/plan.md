# S1b implementation and proof plan

Spec: attached kickoff, REV 2. Base aa73bf4d711f6c4a0649e04fe4fe2fa5a50abfad.

- Capture full baseline suites and Settings picker at 1440 on isolated synthetic stack.
- Add guards to existing MCP/UI test files: legacy defaults inert; legacy parse/save; strict create/update rejection; real atomic writer live/clear unpins; S1 invariants; Settings create/edit/deactivate without categories.
- Remove category defaults from the endpoint, store, UI types, Settings and chart recompute only.
- Run each G1–G6 production mutation, retain failure output, restore, retain passing output. G4 content helper has zero permanent diff.
- Run full suites/build, prove Settings and comprehensive chart routes, inspect captures.
- Stop owned stack, seal evidence, commit/push requested branch, open PR with NOT EVALUATED and Coded-by line; poll existing automated reviews. No merge or evaluator marker.

No new architectural decision, clinical codes, terminology assertions, Iris access, follow-up profiles, shelf/search, scheduling changes, or migration.
