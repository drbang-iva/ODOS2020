# W114 overview dependency guard

The original combined completeness/overview test asserted only that the overview displayed the Observation reference. A seed-only overview dependency still satisfied that assertion. The original assertion remains unchanged; one isolated test now checks the practice-added option label and its clinical completeness credit through the real overview handler.

The mutation replaces the unique `deps.findingDefinitions()` call in `exam-overview-endpoint.ts` with `buildFindingDefinitionSeeds()`. The stored practice option remains in the fixture. The isolated guard fails because `sheetFindings` is absent (1 test, 0 pass, 1 fail); after byte-exact source restoration the same guard passes (1 test, 1 pass, 0 fail). Full overview suite: 27 tests, 27 pass, 0 fail/skip/todo. No permanent production change or existing assertion edit.

Recipe, command, exact source restoration hash, and paired logs are in `overview-stored-dependency-mutations.json` and `W114-overview-dependency-{red,green}.tap`. Full restored run: `overview-final-27-green.tap`. This is author proof, not independent evaluation.
