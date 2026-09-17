# W114 isolated consumer dependency proof

The overview dependency had an observability gap: substituting seed definitions still passed the old combined test's Observation-reference assertion. The old test was preserved. One new isolated overview test checks the stored option's label and completeness credit. It fails under the seed-only overview dependency and passes after restoration; full overview is 27/27.

The existing history, previous-exams, and lifecycle tests already catch mutations to their distinct later dependency loads. Each new recipe changes exactly one uniquely anchored load, leaves the earlier setup/capture/void dependency intact, restores the production file byte-for-byte, then reruns the same test. No production behavior changed.

- Ocular Health history: seed-only `readOcularHealth` loses the stored option; the real history assertion fails (1/1 red, then 1/1 pass).
- Previous exams: seed-only `previousExamGroup` loses the practice option display; the real previous-exams assertion fails (1/1 red, then 1/1 pass).
- Undo: seed-only `handleEncounterUndoRequest` incorrectly refuses the practice option as pre-rebuild; its expected 200 becomes 409 (1/1 red, then 1/1 pass). Actual canonical creation and actual void both finish before this independently mutated undo runs.

The first two failures are TypeErrors at the explicit test assertions for the missing returned fact/display, not loader or infrastructure errors. They are retained without relabeling them as assertion errors. Recipes carry commands, exit codes, paired paths and restored source SHA256. Existing assertions are unchanged. Root owns five door/candidate/pick variants; library agent owns eleven MCP variants. The final consumer matrix and guard indexes join their independently sealed evidence.

Author proof only; NOT EVALUATED. No live run or commit was performed for this supplement.
