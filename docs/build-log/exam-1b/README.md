# EXAM-1B — author evidence, needs independent review

Branch: `drbang-iva/exam-1b`. Base: `8dc73c9979fac61a6a1c160cbab975d1657980eb` (`origin/main` refreshed 2026-09-09). The accompanying commit contains the tested code; `verified-files.json` records its file hashes. No independent evaluation marker is supplied.

All Normal records a frozen negative act for each untouched eye. A touched opposite eye is neither asserted nor posted. An empty derived normal stays normal and carries no negative act. Failed structures are named; the save loop attempts the remaining structures, preserves successful saves, and re-clicking the segment's All Normal retries only its failed structures with the same assertion IDs. Copying or editing an eye does not manufacture or copy an assertion.

## Exact server-contract change

Only `eyes.OD.negativeAct` and `eyes.OS.negativeAct` are newly admitted by the otherwise unchanged strict `eyePayloadSchema`. Each optional object is itself strict and contains:

- `id`: assertion UUID, retained on retry.
- `definitionStableKey`, `eye`: must match the route definition and eye.
- `optionCodes`: nonempty literal list of asserted-absent finding codes; not a hash or a catalog-dependent complement.
- `exclusions`: explicit disjoint list of codes not asserted absent.
- `assertedAt`: client event timestamp. The server independently records receipt time.

Actor injection is refused; `actorReference` is server-derived and added on persistence and reads. New scope codes must be active options of the definition. Existing replay preserves its earlier list even after catalog changes; a voided act cannot be replayed as current. Negative acts are restricted to ocular-health normal captures without positive findings or Other text. No seeds, ranks, disposition registry, deferral rules, or 1a derivation changed.

The eye Observation stores a `NEGATIVE_ACT` component containing the explicit metadata, false-valued `NEGATIVE_OPTION::<code>` components, and a `NEGATIVE_CAPTURE_INPUT` snapshot to reject conflicting reuse of the same assertion ID. Conditional creation uses an identity hash under the local `urn:odos:negative-act` identifier; this hash is only a replay key and is never the scope. Provenance is conditionally created against the persisted Observation. These are separate recoverable writes, not an atomic segment transaction.

`dataAbsentReason` was investigated and rejected for this use: missing expected data and a known negative finding are different assertions. See the [two-primary-source verification ledger](../../../data/code-bindings/exam-1b-fhir-verification.md). The ledger is documentary and **not runtime-enforced**.

## Checks and actual exit statuses

[checks.log](checks.log) contains command output excerpts and each command's own exit status; [check-exits.json](check-exits.json) points to complete local logs.

- UI: 1,294 passed, 0 failed, 0 skipped; exit 0.
- MCP strict command: 4,326 passed, 0 failed, 45 skipped; **exit 1** because 41 required live-authorization cases were not configured.
- MCP documented tests-only mode (`ODOS_ALLOW_UNGATED_MCP=1`): 4,326 passed, 0 failed, 45 skipped; exit 0. This is not authorization coverage.
- UI and MCP typechecks: exit 0, no output.
- Preflight: 0 warnings, 0 hard blocks; exit 0.
- Proxy census: all 24 discovered backend families have entries in the 27-entry proxy table; reporting-only, exit 0.

## Mandate 17 — real break/restore results

Each RED and restored GREEN log is included; [mutation-results.json](mutation-results.json) records exact test commands and exit codes. The [mutation probe](mutations.py.txt) restores source in a `finally` block. No mutation remains in the final code.

```text
1-frozen: RED exit 1; restored GREEN exit 0
2-derived: RED exit 1; restored GREEN exit 0
3-per-eye: RED exit 1; restored GREEN exit 0
4-partial: RED exit 1; restored GREEN exit 0
5-replay: RED exit 1; restored GREEN exit 0
6-parent: RED exit 1; restored GREEN exit 0
7-re-edit: RED exit 1; restored GREEN exit 0
8-in-flight: RED exit 1; restored GREEN exit 0
```

1. A synthetic definition is built from its seed, asserted, then rebuilt after a new seed option is added. The new code remains uncovered. Deriving coverage from current options makes the guard fail. [RED](1-frozen-red.log) / [GREEN](1-frozen-green.log).
2. A normal OS record with no act has no negative assertion on read. Inferring an assertion from normal makes the guard fail. [RED](2-derived-red.log) / [GREEN](2-derived-green.log).
3. A touched OD stays untouched while OS is asserted. Reintroducing a whole-structure skip makes the guard fail. [RED](3-per-eye-red.log) / [GREEN](3-per-eye-green.log).
4. React and Chromium checks require a named failure, no whole-segment success claim, and only the failed structure retried with its unchanged assertion ID. Replacing the error with a success message fails both checks. [RED](4-partial-red.log) / [GREEN](4-partial-green.log).
5. Extra replay guard: removing conditional Observation creation produces a second assertion and fails. [RED](5-replay-red.log) / [GREEN](5-replay-green.log).

6. Parent notification guard: discarding previously saved structure keys on retry fails. [RED](6-parent-red.log) / [GREEN](6-parent-green.log).

7. Re-edit guard: after A succeeds and B fails, editing A then retrying B must leave A explicitly unsaved and must not notify the parent until A is saved. Removing the completion guard fails. [RED](7-re-edit-red.log) / [GREEN](7-re-edit-green.log).

8. In-flight edit guard: completion compares the latest form against the persisted snapshot. Using the pre-request form instead falsely completes the save and fails. [RED](8-in-flight-red.log) / [GREEN](8-in-flight-green.log).

Review fixbacks also reproduce a reverted failed edit and corrupt persisted assertion metadata before repair (both exit 1), then pass after repair. Failed keys are pruned when edits are reverted; other segment failures remain visible. Previously successful keys reach the parent on final retry. Persisted assertion metadata is validated and corruption explicitly refuses history instead of silently becoming derived normal. [UI GREEN](review-ui-green.log) / [MCP GREEN](review-mcp-green.log).

Restored test output:

```text
EXAM-1B FROZEN: added synthetic seed option is NOT covered; original explicit codes preserved
EXAM-1B DERIVED: empty normal has NO negative act; explicit negative has actor and frozen scope
EXAM-1B PARTIAL: named failure; 3 initial writes, 1 retry, 0 successful structures reasserted
EXAM-1B BROWSER: Failed: Synthetic Beta visible; only Beta retried with unchanged assertion ID
EXAM-1B REPLAY: Provenance failure repaired; 1 Observation, 1 Provenance after 3 attempts
```

## Disposable Medplum and browser proof

Medplum 5.1.30, isolated Docker network/database, loopback port 19503. The browser uses the existing entry-sheet component fixture on port 19521; intercepted requests invoke the actual custom-section handlers and an authenticated FHIR client against that server. The FHIR principal is the disposable administrator; this is storage/handler proof, not production role-policy proof or a full RouteSwitch walkthrough.

The real server first exposed a defect hidden by a fixed-clock fake: proposed resource IDs changed between retries, so conditional create failed with `Resource ID did not match resolved ID`. The fake now advances the clock and enforces that behavior; conditional negative writes omit proposed resource IDs. [Live RED](live-replay-red.log) / [Live GREEN](live-replay-green.log).

```text
LIVE MEDPLUM 5.1.30: 4 concurrent initial submissions + 4 concurrent replays => 1 Observation, 1 Provenance; frozen codes and authenticated actor round-trip
LIVE BROWSER + MEDPLUM: touched Lens OD not posted; 3 structures attempted; Cornea OS failure named; only Cornea retried with identical IDs; 6 total Observations (1 original + 5 negative), no duplicate OD after partial structure failure; persisted assertions survive reload
```

[Before](browser-before.png) · [Named partial failure](browser-partial-failure.png) · [After reload](browser-after.png). [Browser probe source](live-browser-probe.ts.txt) documents the fixture and assertions; its temporary configuration contained disposable credentials and is intentionally excluded.

## Historical ambiguity and remaining boundaries

A read-only aggregate census of the pre-existing local `odos-history-1d5` database found **0 current rows, 0 live rows** matching ocular-health `EXAM_STATE=normal` without `NEGATIVE_ACT`. The root checkout points at `localhost:8103`, which had no listener; the reachable synthetic stack is a different instance. Consequently **the configured installation's historical count remains unverified**, not zero. No records were backfilled, migrated, or classified by guessed clinician intent. Historical records without the new field cannot distinguish an old explicit All Normal click from derived normal.

PerformanceOD follow-up is recorded in draft commit `8bb142a8` on `drbang-iva/exam-1b-carrier`, `documents/drafts/2026-09-09-odos-exam-1b-negative-carrier.md`. Its AGENTS.md prohibits Codex directly editing canon, so Fable's adjudication must promote the carrier rationale and update `decisions/INDEX.md`; this implementation session added no accepted decision.

Status: **needs-review**. Independent Fable/Opus evaluation at the PR's exact head remains required before merge. Strict live-authorization gating and the configured installation's historical census remain explicit gaps. No deployment or merge was performed.
