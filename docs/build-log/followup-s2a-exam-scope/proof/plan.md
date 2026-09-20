# S2a implementation plan

Goal: choose encounter exam scope independently of scheduling and billing, per REV 2 and REV 3.

- [x] Record base suite summaries and real before screenshots.
- [x] Add failing scope, persistence, permission, independence, and copy tests.
- [x] Implement one encounter Basic store with actor/time and guarded writes; unknown scope remains unconfigured.
- [x] Replace category projection input with scope and add chart.write mutation route.
- [x] Add always-present header picker, reload board after saving, preserve fallback and findings.
- [x] Demonstrate G1–G8 with temporary mutations and restored green outputs.
- [x] Run full suites and builds; capture 1440px synthetic proof and stop only this task's stack.
- [ ] Commit summaries and screenshots; open PR marked NOT EVALUATED, poll automatic reviews, do not merge.

Review focus: concurrent first writes; scope read failure vs absent record; permission denial before writes; encounter navigation during requests; preserving finding and billing resources.

Allowed production files and tests follow kickoff §4. No profiles, shelf, search, three states, census, unmatched/carried finding repair, or recall changes.
