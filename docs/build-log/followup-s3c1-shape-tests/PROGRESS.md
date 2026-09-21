# S3c-1 REV 2 execution record

Base: 91f5446407163aba633d278957dde60fde733ebe.
Branch: drbang-iva/followup-s3c1-shape-tests.
P1–P7 verified at origin/main. P8 corrected: 8 tests; caller inventory 58.

- Baseline: UI 1828 pass; MCP 6146 pass, 55 skip, zero fail. Three typechecks pass; preflight zero warnings/blocks.
- Implementation: endpoint supplies tests from selected profiles; store freezes and merges by orderable plus focus. Legacy absence preserved. No live profile reads in the store.
- TDD: two new endpoint tests failed before implementation, then passed. Focused suite: 52 pass, zero fail.
- G1–G5 and G7: each broken red, restored green; G7 also proves the original explicit-shape survivor assertion. Additional best-effort guard broken red and restored green. G6 is verification only.
- Real synthetic Medplum proof: old 3 tests unchanged after edit/retirement; new visit 1 edited test; explicit visit 3 tests; legacy no recorded tests and no rewrite.
- Final MCP: 6155 pass, 55 existing skips, zero failures. All three typechecks and preflight pass. UI final: 1828 pass, zero fail/skip, matching base.
- Both odos-s3c1-proof and odos-s3c1-postgres stopped; volumes retained. Unrelated services left alone.
- PR and automatic bot reviews pending. Independent evaluation remains Claude Opus 5; NOT EVALUATED.

No outside-scope edit required. Initial MCP invocation lacked Postgres; the complete configured rerun used task-owned Postgres and the prior slice's documented ODOS_ALLOW_UNGATED_MCP=1 command. Credential-dependent skips are disclosed and are not live authorization proof.
