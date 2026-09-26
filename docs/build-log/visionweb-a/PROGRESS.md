# VW-A execution record

Authoritative kickoff: performance-od f3852de3, revision 3. Base: 4afa0b62c34111ce7b799c16a6a013239e6698a7.

P1–P14 verified at base. P1/P2/P4–P8/P10–P13 source files identical to previously reviewed cd05d5c9; P3 registration unchanged. P14 has 19 hits and the watcher/statement Task paths are distinct from lab transmissions. WSDL re-fetched unauthenticated: namespace http://services.visionweb.com; action http://services.visionweb.com/UploadFile; result UploadFileResponse/UploadFileResult, string; all eleven request elements optional, in documented order.

Baseline: `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test`, dedicated synthetic Postgres supplied through ODOS_POSTGRES_URL: 6493 tests, 6434 pass, 0 fail, 59 skipped, exit 0. This is not live authorization proof; 47 skips reported by the live-stack recorder. Typecheck: `npm --prefix mcp exec -- tsc --noEmit -p mcp/tsconfig.json`, exit 0.

Harness correction: standalone preflight initially overlapped the baseline suite's intentional RiskAssessment source probes. Rerun serially; no product changes used to correct this.

No worktree .odos directory existed before the baseline. QA env-file path requested; no credentials opened or transmitted.

Offline implementation and mutation proof complete. 18 deliberate breaks (V1–V17, V8a, V12 twice) each returned exit 1, followed by restored exit 0. Full outputs are summarized in GUARDS.md; V8b depends on L1 and is not claimed.

Final full suite: 6516 tests, 6456 pass, 0 fail, 60 skipped, exit 0. Baseline 6493 + 23 added = 6516. The extra skip is the disabled QA test. Final typecheck exit 0; serial preflight exit 0 with 0 warnings / 0 hard blocks, 976 FHIR operations compared with baseline 972.

L1 remains blocked on the operator-supplied gitignored QA env-file path. No VisionWeb upload or tracking call has run. No capture exists. No PR or evaluation marker is claimed.
