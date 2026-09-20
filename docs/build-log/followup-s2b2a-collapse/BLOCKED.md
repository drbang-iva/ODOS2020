# S2b-2a sealed pre-implementation bundle

Status: blocked — contract clarification pending; NOT EVALUATED.

## Summary

The fetched base is exactly `da799f4eb9c290cf6e6e270b0031562e2b432d8a`.
P1–P11 were re-read at `origin/main`; the baseline UI suite, UI typecheck and preflight are green.
No application code or existing tests changed. No commit, push or PR was made.
Section 3.2 names one proven-empty editor from every definition-backed family, including `procedure:*`.
The real procedure writer stores a Procedure; the real overview endpoint never reads that resource type.
The diagnostic below demonstrates a saved procedure leaving the overview projection unchanged.
Section 4 forbids the server edits needed to make that proof possible; the fail-closed fallback permits `unknown`.
Implementation is paused pending clarification that every `procedure:*` editor may remain `unknown` in this slice.

## Identity and scope

- Branch: `drbang-iva/followup-s2b2a-collapse`.
- HEAD and refreshed origin/main: `da799f4eb9c290cf6e6e270b0031562e2b432d8a`.
- PR URL: none. New commits: none.
- Open PR scope check: #634 and #626; no overlap with the kickoff's allowed files.
- Files added: this report and `docs/build-log/followup-s2b2a-collapse/procedure-projection-probe.mjs`.
- Application files, existing assertions, decisions/INDEX.md and Mandate 14 ledgers: unchanged. No new medical codes, artifact URLs or clinical rules were introduced.
- Canonical design read from performance-od commit `9e1913b4`, under `documents/drafts/2026-09-19-follow-up-exam-final/`.

## Contract issue and concrete amendment

The two relevant instructions are:

> §3.2: the eight hand-table editors, and one editor of each definition-backed family (`ocular-health:*`, `dry-eye:*`, `custom:*`, `procedure:*`) — each proven by a test that saves through the real writer or the real stored definition and reads the projection … and … proves clearing the value returns the editor to empty.

> §4: Not allowed: anything under `mcp/`.

The same §3.2 also directs editors without proof to `unknown`. It is unclear whether that fallback permits omitting the explicitly requested procedure-family example. No permission to weaken that example was inferred.

Proposed narrow amendment: **All `procedure:*` editors have an explicit `unknown` registry decision and are collapse-only. The procedure-family save/clear proof is deferred until procedure evidence reaches the overview. G5 still enumerates and enforces the procedure-family decision.** No server expansion is proposed for S2b-2a.

Evidence at the exact base:

- `ui/src/scenes/EncounterCharting.tsx:733`: procedure inventory comes from active catalog rows with `resourceKind === "procedure"`.
- `mcp/src/clinical-graph/procedure-definition-store.ts:216`: `buildProcedureFromDefinition` returns a Procedure.
- `mcp/src/clinical-graph/procedure-definition-endpoint.ts:181`: the capture endpoint creates that Procedure and its Provenance, without an Observation.
- `mcp/src/clinical-graph/exam-overview-endpoint.ts:87`: overview queries Observations, Conditions and supporting Basic records; it supplies observations to the projection at line 119.
- `mcp/src/clinical-graph/exam-overview-projection.ts:185`: projection input has no Procedure collection.

The probe uses the real stored-definition loader, capture endpoint and overview endpoint with an existing in-memory persistence fixture. It is not a live-server test. It asserts successful saving before inspecting projection visibility; a failed save cannot satisfy it.

Command:

```sh
node --import tsx docs/build-log/followup-s2b2a-collapse/procedure-projection-probe.mjs
```

Successful diagnostic output (exit 0):

```json
{
  "editor": "procedure:aesthetics:neurotoxin-glabella",
  "captureStatus": 201,
  "savedProcedures": 1,
  "savedObservations": 0,
  "overviewStatus": 200,
  "beforeFindings": 0,
  "afterFindings": 0,
  "overviewSearchedResourceTypes": ["Basic", "Condition", "Observation", "Provenance"],
  "projectionUnchanged": true,
  "limitation": "Real endpoint functions with in-memory persistence; no live-server proof."
}
```

This is evidence of missing projection coverage, not a passing save/clear guard. The required procedure-family proof cannot currently reach its saved-data assertion. No guard was weakened or substituted.

## P1–P11 re-verification

| Premise | Result at origin/main |
| --- | --- |
| P1 | Confirmed: fixed sheet rows, drawn editor union, inventory partition, FindingRow/EmptyEditorRow and ShelfEntry match the cited board source. |
| P2 | Confirmed: all eight explicit mappings and fallback candidates match; all four named helpers are local to the board. |
| P3 | Confirmed: unmapped groups render under Other findings; carried findings remain drawn, with existing assertions in examShelf. |
| P4 | Confirmed: board and SpineNav use chartEditorInventory; the rail renders grouped inventory entries, including on-demand entries. |
| P5 | Confirmed: opened editor state, encounter reset, group editor union, board props, fallback mount and return strip match. |
| P6 | Confirmed: no `collapsed` or `isCollapsed` match under ui/src; the cited preference helper directly accesses localStorage without catching errors. S3 state is not present in the examined board/encounter path. |
| P7 | Confirmed in source and existing UI baseline: content-based group refusal remains HTTP 409, board rows use exam scope, and shelf partitions the inventory. No new server/live-authorization proof was run. |
| P8 | Confirmed: the eight keys occur in the stated writer/definition modules; NewPatient imports the MCP age-of-majority helper. Import feasibility and full save/clear pins for all eight were not yet established. |
| P9 | Confirmed: hardcoded-style patterns are blocking; no baseline entry exists for the board/new files, hence a zero allowance. The baseline file was not edited. |
| P10 | Confirmed: CI runs UI typecheck, npm test and build; preflight runs npm run preflight. Local baseline: 1,779 passed, zero skipped, typecheck and preflight green. |
| P11 | Confirmed: the five direct board/inventory test or fixture importers match; entrySheets and examChartBarResponsive launch Chrome against the listed fixtures. Existing identifiers and copy remain unchanged. |

## Checks, counts and assertion migration

Dependencies installed from unchanged lockfiles using `npm ci`, `npm --prefix ui ci`, and `npm --prefix mcp ci`; each command exited 0.

| Command | Before implementation | After implementation |
| --- | --- | --- |
| `npm --prefix ui test` | Exit 0; 1,779 tests passed; 0 failed; 0 cancelled; 0 skipped; 0 todo. | Not applicable: implementation did not start. |
| `cd ui && npx tsc --noEmit` | Exit 0; no diagnostics. | Not run after implementation. |
| `npm run preflight` | Exit 0; 0 warnings; 0 hard blocks. | Not run after implementation. |

UI summary:

```text
1..1766
# tests 1779
# suites 0
# pass 1779
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 213657.126291
```

Preflight summary:

```text
ODOS preflight complete: 0 warning(s), 0 hard block(s).
```

Assertion-migration table: none; no existing assertion changed or disappeared.
Outside-allowlist files needed by these baseline checks: none.
G1–G11 mutation proofs: not run; no implementation exists to mutate. No red/green or enforcement claim is made.
Proof 1–4 and 1440/390 screenshots: not done. Proof 5: baseline only, as above.

## Registry and deferred work

No registry was implemented. No editor is newly certified false-capable. All eight requested writer keys remain unproven by this task: `entrance:cover`, `entrance:color`, `entrance:stereo`, `intraocular_pressure`, `cup_disc_ratio`, `manual_keratometry`, `auto_refraction`, `hpi_ros`.

The proposed `unknown` procedure-family classification is pending operator clarification. Final false-capable/unknown/never-shelvable lists have not been produced; presenting them as implemented would be inaccurate.

Collapse, expand, to-shelf and per-encounter view persistence: not implemented.
Second browser/device behavior: the requested eventual behavior is an expanded view until S3 migrates the preference; this task has not implemented or tested it.
F9 signed-record/print import trace: not performed. No printed-record claim is made.

Explicitly not done: S2b-2b search box and adapters; S3 profiles and shape record; S5 Same today and carried-finding writes; server changes; SpineNav behavior changes; promoting an unknown editor without the required evidence.

Cross-repo follow-up: kickoff author to resolve the procedure-family proof requirement. No design/decision file was changed.

## Docker cleanup

No task Docker stack was started, so none required stopping. Existing operator/other-task containers were left intact. `docker ps --filter name=odos-s2b2a- --format 'table {{.Names}}\t{{.Status}}'` returned only the header.

Final `docker ps --format 'table {{.Names}}\t{{.Status}}'`:

```text
NAMES                                STATUS
vf-prac1b-walk-db                    Up 27 hours
odos-matrix-proof-medplum-server-1   Up 4 days
odos-matrix-proof-postgres-1         Up 4 days (healthy)
odos-matrix-proof-redis-1            Up 4 days (healthy)
odos-matrix-1-medplum-server-1       Up 4 days
odos-matrix-1-postgres-1             Up 4 days (healthy)
odos-matrix-1-redis-1                Up 4 days (healthy)
odos-consent-safety-redis-1          Up 4 days (healthy)
odos-consent-safety-postgres-1       Up 4 days (healthy)
odos-history-1d5-postgres-1          Up 4 days (healthy)
odos-history-1d5-redis-1             Up 4 days (healthy)
```

blocked
