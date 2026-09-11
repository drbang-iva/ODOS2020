# MATRIX-2 sealed author bundle

**Current handoff: [Fixback round 2](fixback-round-2/README.md).** The material below records the original implementation at its stated source head. Round 2 supersedes the confirmed-save rule: suppression-locked cells are excluded, leaving stored preferences and Consent scope untouched for those cells. Original mutation logs remain historical evidence, not newly executed round-2 checks.

Communication preferences now appear in Edit demographics and New Patient, drive Engage channel choices, show the chart STOP chip, and expose a role-gated Consent evidence report with CSV export. In-dialog writes report opaque Patient versions so the editor can preserve unsaved demographics while adopting only its own confirmed write.

Branch: `drbang-iva/comms-matrix-2`. Base: `87e8e5b8a4649f73dfe84a9ddab3b98419b16325` (#577). All verified premises held at this base. Final implementation source: `4f99d7aa38378733a9920b778589baf3e085a467`. The evidence-only commit containing this bundle does not change application source. The PR URL and final publication SHA are sealed in the PR description and handoff.

**Status: implemented and author-verified; NOT independently evaluated.** Claude Opus 5 (extra) owns the independent evaluation. No merge, label, or evaluator marker is authorized here.

[Review fixes](review-fixes.md) · [Files](files.md) · [Step commits](commits.md) · [Existing-test changes](existing-test-changes.md) · [Screenshots](screenshots.md) · [Version source proof](version-source.md) · [M1–M15 mutations](mutations/README.md)

## Full-suite comparison

Every reported command's own exit was captured; no reported command was piped. Base runs used a clean detached worktree, with the same environment and locked dependencies as the task branch. No dependencies changed.

| Revision | Command | Tests | Passed | Failed | Skipped | Exit |
|---|---|---:|---:|---:|---:|---:|
| Clean base | `npm --prefix mcp test` | 4640 | 4627 | 8 | 5 | 1 |
| Branch | `npm --prefix mcp test` | 4666 | 4653 | 8 | 5 | 1 |
| Clean base | `npm --prefix ui test` | 1341 | 1341 | 0 | 0 | 0 |
| Branch | `npm --prefix ui test` | 1417 | 1417 | 0 | 0 | 0 |

[Failure-name table](failure-diff.md): **zero branch-only failures** in both suites. [MCP comparison](checks/mcp-failure-diff.json), [UI comparison](checks/ui-failure-diff.json). Captured suite summaries and full failure blocks are under `checks/`. The MCP source was unchanged after its full run; final UI run includes all review fixes.

| Additional verification | Result |
|---|---|
| `npm --prefix mcp run build` | exit 0 |
| `npm --prefix ui run build` | exit 0 |
| `npm run preflight` | clean base and final source: 0 warnings, 0 hard blocks, exit 0 |
| Proxy coverage census | 24 backend families, 27 proxy entries; all covered, exit 0; advisory only |
| Real Medplum version-source proof | exit 0; matching opaque versions |
| Browser capture harness | exit 0; 12 states and conditional demographics save |
| Actual evidence route and CSV download | 1/1, exit 0 |
| M1–M15, including M5a/b | 24 mandated mutations plus 2 supplementary mutations; each red exit 1, restored exit 0 |
| Final patch applicability | all 26 mutation diffs apply |

## Scope and limits

Screenshots and browser flows prove rendering, route wiring, payloads and client behavior against synthetic HTTP transport. The separate Medplum proof establishes the real transaction response shape. They do not establish deployed AccessPolicy enforcement or real delivery. Baseline live-policy/fixture failures remain visible and unchanged; a green UI suite is not a live authorization verdict.

The existing server remains the send authority. When Engage cannot read the matrix, it displays an explicit notice and lets dispatch enforce preferences; suppression checks remain in place. The adjacent withholding companion protects the removed legacy UI gate.

No new medical terminology, FHIR artifact URL, dependency, vocabulary code, or strategy decision is introduced. No ledger addition or decision-index edit is needed. Deferred: membership backfill, evidence-only capture UI, portal/kiosk/partner capture, later consent phases, retraction, and recall/product-pickup senders.

Public disclosure review covered added source/test lines, commit subjects, evidence text and all screenshots. Only synthetic data is present. Bot and CI results belong to the final PR head and will be reported separately; author checks are not an evaluator verdict.

The paper-form date cutoff remains UTC to match the existing server validation. A local-calendar cutoff requires a coordinated server/client contract change outside S1/S2; this is an explicit evaluator follow-up. When registration cannot read defaults, it now explains that server defaults apply and permits creation without a preference payload.
