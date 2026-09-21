# S3c-2a implementation record

Base: 9adec598a7d012729ca239cce11aab1b726171f0 (fetched).
Branch: drbang-iva/followup-s3c2a-queue-view.
Coder: Codex, GPT-6; recommended high effort, runtime variant and effort not exposed.
NOT EVALUATED. Evaluator designated by operator: Claude Opus 5.

R1: Operator authorized overlap with PR #647 in index.ts; insertion must stay immediately after exam-view-state and below all grant pins. If #647 merges, rebase and repeat full verification. No script pin edits.

P1–P11 verified from origin/main before implementation. Protocol files are under mcp/src/clinical-graph. P6's precedent additionally filters actionType=follow-up; the queue uses order as specified. P4's proposed write belongs to findings, not plan actions. P8: highest grant pin 7945; route block ends 8684. P9: 58 callers. P10: entry keyboard test returns from Engage without advancing past it. P11: chart harness dispatches fetch by URL; no existing test selects Follow-up.

Plan: baseline suites/typechecks/preflight; freeze + server guards; lazy tab + UI guards; all mutation red/restored-green runs; real synthetic stack/browser proof; full candidate verification; PR and bot review; handoff NOT EVALUATED.

Guard-path sweep: G1–G8 queue endpoint; G9 overview endpoint; G10 scope store; G11–G13 queue component; G14 queue client. All in allowlist.

Full suite baseline checks are running. No production edits yet.

Baseline blocker: full MCP run omitted ODOS_POSTGRES_URL and reached the default unavailable port 5433. claimReadModelStore had setup-hook failures; educationCatalogCiPresence.test.ts:14 then failed its existing G25 child-exit assertion (1 !== 0). Child educationCatalogSnapshotStore and visionforgeEducationCatalog persistence tests reported ECONNREFUSED. Rule 12 requires stopping on that assertion; no assertion was edited. A dedicated odos-s3c2a-suite-postgres container was created on port 29857 during diagnosis, then stopped on discovering the assertion failure. Remedy requires no file expansion: restart that container, export ODOS_POSTGRES_URL to its isolated port, and rerun the full baseline before implementation. Awaiting operator ruling to resume after the rule-12 stop.

Root, MCP and UI typechecks emitted no diagnostics. Preflight: 0 warnings, 0 hard blocks. UI and MCP baseline runs are being allowed to finish to preserve complete summaries. Only this evidence directory is untracked; no production/test edits, commits or PR.

R2: Operator voided the original MCP baseline and authorized dedicated PostgreSQL for base/head/full-suite mutations, matching CI's environment. Dedicated odos-s3c2a-suite-postgres is bound to localhost:29857. CI also sets ODOS_REAL_WEASYPRINT_TEST=1; pinned WeasyPrint 69.0 was installed in a disposable Python 3.12 environment. The first R2 attempt was deliberately interrupted before completion while this prerequisite was prepared; it is not baseline evidence. Corrected full MCP baseline is running with both dependencies and ODOS_ALLOW_UNGATED_MCP=1 (live Medplum skips remain explicit).

Pre-build contract conflict found at base: ui/tests/examOverviewBoard.test.tsx:3424 test title says four tabs; line 3429 asserts tabs.findAllByProps({role:"tab"}).length === 4 while entry is open. Required Follow-up adds a fifth tab. Rules 5/12 and section 4 prohibit changing this existing assertion. Requested narrowly scoped authorization for count 4 to 5 plus title four to five, preserving remaining assertions. No source/test changes made.

R2 baseline complete: 6210 tests, 6156 pass, 0 fail, 54 skipped. Dedicated Postgres stopped; docker ps shows only vf-prac1b-walk-db (Up 2 days). Waiting for the four-to-five-tab assertion amendment.

R3: Operator authorized examOverviewBoard.test.tsx:3429 count 4 -> 5 and test title four -> five only. Accepted R2 baseline is final base: MCP 6210/6156 pass/0 fail/54 skip; UI 1828/1828 pass/0 fail.

Implementation now present (uncommitted): freeze schema reuses profileTestSchema shapes; resolver copies label/reason/resultSection/choice/profileLabel; first-entry merge comment; pure deriveFollowUpQueue plus staff Encounter/action reads, service scope/fee reads and fail-closed endpoint; exactly one index route block; typed UI client, lazy queue, tab after Engage, mounted surface, row CSS. Three permitted frozen expectations extended; R3 count/title applied; caller inventory 59; one chart fetch branch plus appended G11 integration test.

Tests added: G9 endpoint automatic+explicit persistence test; new queue endpoint file with 10 tests G1-G8/G10 plus separation/status mapping; new UI file with five tests G11-G13/empty/loading/malformed/stale responses. Freeze RED 1 fail then GREEN 53/53; queue RED missing-module then GREEN 10/10. Initial adapted glaucoma profileLabel expectation was corrected to the actual seed label before green. MCP and UI typechecks clean; candidate preflight zero warnings/blocks.

RULE 12 STOP: focused UI run 134 tests / 131 pass / 3 fail. Existing C1 panel is available off the structure stage (3458) and C1 modal editor still suppresses the panel (3467) both assert ExamRightPanelSurface count 2; adding required Follow-up produces 3. These are panel-count assertions, not the tab-count assertion covered by R3. Both left unchanged. No further implementation until ruling. New G12 test also fails because text(status.props.children) JSON.stringify encounters React Fiber cycle; repair this new helper by reading p children or recursive ReactTestInstance text, preserving the scoped status assertion. No production failure implied by that helper error.

Next after authorization: amend only two panel counts 2 -> 3, preserve modal count 0; fix own G12 helper; add full-field first-entry merge guard; implement all G1-G14 mutation red/restored green evidence; full suites with R2 environment; synthetic stack/browser proof; PR/bot review and NOT EVALUATED handoff. Existing proof/weasyprint wrapper unused (native Python 3.12 WeasyPrint 69.0 used instead). Dedicated suite Postgres stopped at this stop. docker ps only vf-prac1b-walk-db Up 2 days. No commits or PR.

R4: Operator authorized only existing panel counts at 3458 and 3467 from 2 to 3. Applied. Modal suppression 3470 remains 0 and Photos remains first/active at 3459. Follow-up moved after Engage; all right-panel siblings remain gated by rightPanelForward.

Own G12 helper fixed by reading status paragraph children, avoiding circular React Fiber serialization. Focused server 64/64 and focused UI 134/134 passed. All 17 mutation cases covering G1-G14 passed red/restored-green, recorded in mutations.json with reproducible proof/mutations.py. Includes separate G3 state+encounter, G12 empty+alert, and extra full-field first-wins merge mutation. Runner initially used root tsconfig for UI tests, causing React-is-not-defined on restore; corrected to ui cwd and reran all cases successfully. No un-restored mutations remain.

Candidate MCP full suite: 6222 tests, 6167 pass, 1 fail, 54 skipped (6210 + 12 = 6222). Existing findingDefinitionStore.test.ts:481 fails clinicalRoutes.length 106 !== 105. New GET is naturally counted by the clinical-graph route inventory. File is outside section 4; rules 3/12 require STOP. No change to it. Requested scope expansion solely count 105 -> 106, preserving definition dependencies 50 and procedure dependencies 6. Do not change route syntax to evade the inventory.

All three candidate typechecks and preflight passed; full UI is completing. Built MCP/UI successfully. Live harness prepared under .odos/s3c2a-proof, project odos-s3c2a-proof, ports in manifest. Bootstrap created synthetic project, patient, provider/staff identities; throttled in seedUiRuntime. Stack was stopped on rule-12 discovery; bootstrap ended. Live proof script written but not executed; no real queue responses/screenshots yet. On resume, run stack up (idempotent bootstrap) then serve, live.ts and browser proof. Build exists but source files must stay unchanged or rebuild. Native WeasyPrint 69.0 path remains the disposable Python environment. Dedicated suite Postgres stopped too. vf-prac1b-walk-db unchanged. No commits or PR.

Final UI 1834/1834, 0 fail (1828 + 6 = 1834). Bootstrap process ultimately exited 0 with synthetic identities ready; prior note about interruption was inaccurate. Stack remains stopped.

R5: Applied only route inventory 105 -> 106 plus one authorized comment; dependency counts remain 50 and 6. Full MCP rerun: 6222 tests, 6168 pass, 0 fail, 54 skipped. All 20 mutation cases passed red/restored green, including R3 tab count, R4 both surface counts, R5 route inventory and G1-G14.

Real synthetic live proof passed: frozen glaucoma/macula JSON, protocol order route HTTP 200, real queue HTTP responses, absent vs empty. Browser proof passed both visits at 1440 and 390 widths, request counts 0/1/2, no row buttons or tab alerts, no page errors. Phone navigation uses the existing Photos launcher to summon the panel before selecting Follow-up; no launcher was added. Own live harness initially expected the wrong macula row order and was corrected to stored order (OCT retina, Retina photos, ERG); production unchanged. New endpoint test provenance fixture corrected to the existing InstanceProvenance shape.

Both task stacks stopped. docker ps: vf-prac1b-walk-db Up 2 days. PR preparation at origin/main 9adec598a7d012729ca239cce11aab1b726171f0, #647 OPEN. No rebase required. See BUNDLE.md and RULINGS.md for final evidence.

PR 650 opened at 5a19dfaa2be2e3aad518a0051af19a1a7a6458ad. CodeQL flagged missing rate limiting; fixed within the one permitted route block with existing express-rate-limit. Real API/browser proof repeated successfully; 121-request limiter proof returned initial 401 and final 429. Rebuilt served/source hashes replaced. Full MCP repeated 6222 total / 6168 pass / 0 fail / 54 skipped. Three typechecks and preflight clean. Both task stacks stopped again; vf-prac1b-walk-db untouched.

Full UI after rate-limit correction: 1834 / 1834 pass / 0 fail. All required local verification complete on the corrected source.
