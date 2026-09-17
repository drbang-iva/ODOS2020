> Historical stop record: resolved by the operator’s published W147 ruling on resume. See w147-summary.json for implementation proof. This file describes the prior stop, not current status.

# R10 A3.2 — BLOCKED before implementation

Status: **BLOCKED / NOT EVALUATED**. No application code changed. No PR opened, commit created, push, or merge.

## Verified identity

- Worktree: `/Users/ericr.bang/GitHub/ODOS2020/.worktrees/r10-a3-2`
- Branch: `drbang-iva/r10-a3-2`
- Base and current HEAD: `a211b36887b49139ab29cf2d811a5a30f261034d` (requested A3.1 PASS head).
- Freshly fetched ODOS `origin/main`: `c742b2e4b543e0706b24f66aec6883a82f0d18a3`.
- Freshly fetched PerformanceOD `origin/main`: `7548b9c83628b8024e6104bb359e1aea1fda1374`.
- Read the kickoff sections 3.4–3.6, 5–6, 9–10 and 13, plus A3.1 evaluation and re-evaluation records from that remote ref.
- Open PR inventory: #617, #619, #620 are the expected held-open stack. GitHub diff requests exceed its size limits; local stacked UI paths inspected instead.

## Blocker and reproducible evidence

An open encounter can contain an individually signed live-present fact. The history handler returns `encounterEditable: true` and `panel.editable: true`, with the fact itself read-only. A Remarks-only save which preserves that fact in both `loaded` and `selected` returns **422 signed-or-cancelled**, before any write.

| Same Remarks-only request, changing only initial fact status | Preliminary control | Final fact |
|---|---:|---:|
| History encounter editable | true | true |
| History panel editable | true | true |
| Save status | 200, complete | 422 signed-or-cancelled |
| Writes (panel plus audit) | 2 | 0 |
| Remarks persisted | yes | no |
| Original fact unchanged | yes | yes |

Run from the worktree root:

```sh
node --import tsx docs/evidence/r10-a3-2/readonly-loaded-probe.ts
```

Output: [readonly-loaded-probe.log](readonly-loaded-probe.log). This executes the real history and capture handlers against the existing synthetic in-memory FHIR fixture. It is evidence of endpoint prevalidation behavior, **not** Medplum AccessPolicy or served-browser proof. No network, credentials, PHI, or containers are involved.

Code at this exact head:

- `mcp/src/clinical-graph/custom-section-endpoint.ts:697–700`: checks editability of every loaded claim even when unchanged and not a write target.
- `mcp/src/clinical-graph/custom-section-endpoint.ts:773–775`: panel editability is independent of signed facts.
- `mcp/src/clinical-graph/diagnosis-findings-endpoint.ts:163–176`: signed owner yields `signed-or-cancelled`.

The kickoff §3.4 requires B (`loaded`) to contain the loaded live-present facts; dropping the signed fact to get a 200 would violate that contract. Disabling the entire eye would override the independently editable panel and sibling facts and needs an explicit scope ruling. The requested per-eye Remarks/measurement workflow cannot simply follow the returned editability flags.

**Requested ruling — Claude Opus, extra:** should unchanged read-only facts be permitted as loaded witnesses while remaining immutable, or should history/the contract mark the whole affected eye read-only? Recommended: permit unchanged witnesses while retaining baseline validation and rejecting all attempted mutations of read-only facts. This is a proposed contract resolution, not an implemented decision. A server fix belongs to A3.1 or a separately authorized scope; no `mcp/` file was edited here.

Stopping authority: the operator task explicitly says a needed change elsewhere, including any `mcp/` file, means “stop and report.” No new approval requirement was inferred from a skill.

## Files and assertion ledger

Only files under `docs/evidence/r10-a3-2/` were created: this bundle, the reproduction script and output, baseline UI log, baseline UI/MCP build logs, preflight log and release-checker output. Dependencies and build outputs are ignored. No existing assertion changed or removed; therefore no before/after assertion mapping is applicable. No new decision, decisions/INDEX.md change, or Mandate 14 terminology ledger row was made.

## Checks and outstanding deliverables

- Dependency installation: root 10 packages, MCP 261, UI 150; each audit reported zero vulnerabilities.
- Reproduction: two asserted cases completed, exit 0; results above.
- `npm --prefix ui run build`: exit 0; Vite 332 modules transformed; existing large-chunk warning.
- `npm --prefix mcp run build`: exit 0.
- `npm run preflight`: exit 0, 0 warnings / 0 hard blocks.
- `git diff --check`: exit 0 (no tracked edits).
- `node mcp/scripts/check-r10-a3-release.mjs --strict`: exit 1; expected baseline release blockers: missing UI T4–T6/T21/T22 declarations and TAP, T15–T18 TODO. Full output in `release-base.log`.
- Full UI baseline: exit 1; **1,685 tests, 1,673 pass, 8 fail, 4 TODO, 0 skipped**, 202,053.854792 ms. These are the carried customSections (2), examOverviewBoard (3), ocularSweepValueOnly (1), and encounterVoid (2) failures; no source/test changes preceded this run.
- Full MCP test suite and live lanes: not run; stopped at the contract boundary before implementation.
- W130–W146 red/green: not implemented or run.
- Eight carried UI failures and R10 release slots: not repaired.
- Served-route (a)–(h), build identity, resource ids/versions and requested screen screenshots: not run/captured. The UI build above is not claimed as served proof.
- CI MCP/UI job counts/run URL: none; no new PR or head.
- CodeRabbit/PR-Agent terminal review and thread dispositions: not applicable; no A3.2 PR opened.

## Preservation and cleanup

Worktree and all evidence are preserved, uncommitted. Shared checkouts and other agents’ worktrees were not edited. **Docker containers started: 0; stopped: 0.** No harness service was started. The baseline UI test process was allowed to finish; no other agent’s services were stopped.

Cross-repo follow-up: resolve the contract in PerformanceOD and authorize the corresponding server scope before resuming A3.2. A3.2 remains HELD OPEN in intent; nothing was merged or deployed.
