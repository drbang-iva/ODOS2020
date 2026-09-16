# PR617 bot adjudication

NOT EVALUATED. These are author responses, not the independent Claude Opus verdict. PR remains HELD OPEN through A3.

CodeRabbit's review at346d0b8bb5c1227d9c5913945810e8f78d6e08f4 raised13 threads. PR-Agent completed with no actionable inline findings. Final-head review/check status is recorded in the PR description after the bots finish.

| Comment ID | Outcome |
|---|---|
| 4028970470 | Normalized local paths in initial-red evidence. |
| 4028970486 | Normalized findings mutation evidence and made run-guards.py normalize future output. All17 runner guards rerun red then green. |
| 4028970492 | Normalized gate checker evidence. |
| 4028970505 | Regenerated current live green artifacts from actual runs with resourceType derived from reference; no historical diagnostic fields hand-edited. |
| 4028970517 | Normalized live/reader evidence; reran live W7 red then green. |
| 4028970526 | Normalized pick/pagination evidence. |
| 4028970535 | Normalized remaining pick diagnostics. |
| 4028970545 | Normalized pick type/consumer evidence. |
| 4028970558 | Normalized capture/parity evidence. |
| 4028970568 | Fixed normalized-path containment in the A3 checker; UI rows cannot traverse into MCP tests. |
| 4028970580 | Deferred pre-existing writer deleted-target classification; approved §3.4 does not authorize changing it. See below. |
| 4028970584 | Deferred pre-existing audit authenticity limitation; requires an expanded persistence/validation contract outside §3.4/§4. See below. |
| 4028970599 | Corrected local unassigned response type from source to kind; assertions unchanged. |

All comment links use https://github.com/drbang-iva/ODOS2020/pull/617#discussion_r followed by the comment ID. Replies on each thread record the implemented correction or explicit deferral; resolution means adjudicated, not that deferred behavior was fixed.

## Checker regression and assertion mapping

New W40 test maps UI manifest rows through ui/tests/../../mcp/tests/scenarios.test.mjs and supplies all22 scenario names in the MCP file. Before: checker falsely exits0 with PASS T1–T22, so the new expected-exit1 assertion fails (traversal-red.tap:1 test,0 pass,1 fail). After: resolve the candidate path and require containment beneath the resolved suite/tests directory; checker refuses the UI rows. Restored checker plus findings suite:60 tests,60 pass,0 fail/skip/todo (checker-findings-green.tap). Checker count increases14→15. The second assertion verifies the specific T4 wrong-ui-file refusal. Both map W40. No existing assertion changes.

The findings response type source→kind aligns the declaration with the existing unchanged row.kind assertion (W-c). The separate canonical-policy fixture correction and its two new W7 assertions are documented in ../ci-fixback/README.md.

## Evidence normalization

sanitize_evidence.py replaces workstation home/worktree prefixes with <repo>/<home>, preserving relative filenames, line numbers, diagnostics, assertions, test counts and exit status. Historical red failures remain historical; normalization is presentation-only and also removes trailing horizontal whitespace. The findings guard runner applies the same sanitizer to future captures. Current live green aliases are explicitly identified in ../live/README.md. Raw logs remain private; no credentials or patient data are added.

## Deferred writer follow-ups for independent evaluation / A3

4028970580: origin/main4b3f6d7c already has404-only direct legacy/reassert reads (lines225/267) and409/412 recovery classification (lines345/365). A2b.1 preserves these decisions while adding the approved typed cause/clinicalWrite fields. §3.4 explicitly amends reader410 handling and says nothing else in these reader/writer files changes; it does not authorize writer status reclassification. Direct410 classification deserves a separate ruling. In ambiguous write recovery, a subsequent missing resource alone cannot establish that no clinical write occurred, so broad conversion to a zero-write conflict also needs a precise recovery contract. No claim that this limitation is fixed.

4028970584: matchesFindingAudit in current-finding-identity.ts is unchanged from origin/main and validates deterministic audit key plus target reference. That key is not authentication of actor/activity/recorded/full target set. The requested stronger matcher and stable reassert timestamp witness would change audit acceptance and persistence; identity.ts is outside §4, mutation audits must remain unchanged, and old untagged reassert audits stay valid under rev3.2. The new command witness follows the explicit operator ruling; it is not a signature. This is a real pre-existing audit-authenticity limitation, retained visibly for independent Opus judgment and a separately scoped fix before release. No security assurance is inferred from green tests.

Final focused parity:170/170 from the required mcp working directory (parity.tap). An initial invocation from repository root produced169/170 because the wrapper subprocess resolves tests/fixtures relative to cwd (parity-wrong-cwd.tap); no code or assertion changed to correct the invocation. Preflight:0 warnings/0 hard blocks. MCP build:exit0.

Final review atabffc6f9 added one evidence-only thread4029196322: Linux home prefixes were not normalized. Extended both regexes to Users|home, retaining repository-before-home ordering. Four-case check:before2/4,after4/4 (linux-sanitizer.txt); macOS and CI behavior retained. No application code or clinical assertion changed. Total dispositions:14 threads,12 addressed,2 explicitly deferred.
