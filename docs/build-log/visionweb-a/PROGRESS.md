# VW-A execution record

Authoritative kickoff: performance-od f3852de3, revision 3. Base: 4afa0b62c34111ce7b799c16a6a013239e6698a7.

P1–P14 verified at base. P1/P2/P4–P8/P10–P13 source files identical to previously reviewed cd05d5c9; P3 registration unchanged. P14 has 19 hits and the watcher/statement Task paths are distinct from lab transmissions. WSDL re-fetched unauthenticated: namespace http://services.visionweb.com; action http://services.visionweb.com/UploadFile; result UploadFileResponse/UploadFileResult, string; all eleven request elements optional, in documented order.

Baseline: `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test`, dedicated synthetic Postgres supplied through ODOS_POSTGRES_URL: 6493 tests, 6434 pass, 0 fail, 59 skipped, exit 0. This is not live authorization proof; 47 skips reported by the live-stack recorder. Typecheck: `npm --prefix mcp exec -- tsc --noEmit -p mcp/tsconfig.json`, exit 0.

Harness correction: standalone preflight initially overlapped the baseline suite's intentional RiskAssessment source probes. Rerun serially; no product changes used to correct this.

No worktree .odos directory existed before the baseline. QA env-file path requested; no credentials opened or transmitted.

Offline implementation and mutation proof complete. 18 deliberate breaks (V1–V17, V8a, V12 twice) each returned exit 1, followed by restored exit 0. Full outputs are summarized in GUARDS.md; V8b depends on L1 and is not claimed.

Final full suite: 6516 tests, 6456 pass, 0 fail, 60 skipped, exit 0. Baseline 6493 + 23 added = 6516. The extra skip is the disabled QA test. Final typecheck exit 0; serial preflight exit 0 with 0 warnings / 0 hard blocks, 976 FHIR operations compared with baseline 972.

R6–R10 supersede the offline checkpoint: captures now precede parsing; a read-only history result was empty, permitting the one R9 new-ID submission. HTTP 200 SOAP service error contained a real username echo. R10 code redacted it into the V8b fixture, preserved the private raw capture, and proved the parser and leakage guard offline. No further calls. See BUNDLE.md for reachability versus acceptance and GUARDS.md for exact mutation results. No independent evaluation marker is claimed.


R10 verification: the first full run reported 6521 tests, 6459 pass, 1 fail, 61 skipped. The only failure was the explicitly permitted educationEnrollmentApi.test.ts fetch-failed flake; its one file-alone rerun passed 56/56, exit 0. This worktree's preflight-only .odos reports were then moved aside and the full run repeated to satisfy rule 11 exactly. No expected values or product requests were changed for this harness correction.

Final isolated R10 suite: 6521 tests, 6460 pass, 0 fail, 61 skipped, exit 0 (base 6493 + 28). Typecheck exit 0; unchanged fixturePhiGuard 1/1.


CodeRabbit's first exact-head review found one prism-direction aggregation defect. Missing/non-string prism bases could throw before reporting collected validation errors. A new regression test was RED (1 failure), the guard was fixed without changing existing assertions, and the serializer/adapter group was GREEN (14/14); typecheck exit 0. The final full suite is recorded in BUNDLE.md.

R10 harness correction: the first classifier edit command used the wrong working directory. The test stopped at its explicit-phase guard without sending a request. The corrected command explicitly disabled VISIONWEB_QA_LIVE and enabled only the offline classification lane. No VisionWeb requests were made under R10.

Final post-review full suite: 6522 tests, 6461 pass, 0 fail, 61 skipped, exit 0 (base 6493 + 29).
