# Guarantor cleanup B — author evidence

Contract: CL-B (B1–B3), E1/E2/V1/R1, R3/R4 in the PerformanceOD cleanup kickoff. Base was fetched and every anchor verified at `0255cc5ba1d8e097ee5b129c3219e7030fd49802`; no drift was found before coding. Branch: `drbang-iva/guarantor-cleanup-loose-ends`. PR: <https://github.com/drbang-iva/ODOS2020/pull/610>.

Education contact updates now preserve RelatedPerson children linked to a guarantor Person, continue SMS/email/print delivery, and return a displayed notice naming the guarantor record. Sent replays use the same guard. Provenance records that the child was not updated. Patient and unlinked guardian writes retain their prior behavior. Registration rejects all three invalid new-guarantor DOB inputs before a transaction. Age-of-majority writes are Admin-only; read grants are unchanged.

## Files changed

| File | Change |
| --- | --- |
| `mcp/src/comms/comms-api.ts` | Shared owner guard, sent/replay/print notices, truthful chart-update provenance. |
| `ui/src/lib/communications-client.ts` | Typed and validated notice metadata. |
| `ui/src/components/comms/EngageSheet.tsx` | Display and deduplicate notices. |
| `mcp/tests/commsApi.test.ts` | Real guarantor attach, JSON-round-tripped writer fixtures, preserved child/classification, delivery/replay and ordinary writes. |
| `ui/tests/engageSheet.test.tsx` | SMS/email/print notice rendering and invalid metadata rejection. |
| `mcp/tests/patientRegistrationAuthz.test.ts` | Route-level invalid-DOB guards, built from the real registration writer. |
| `mcp/src/authz/roles.ts` | Move majority write rule from shared scheduling grants to Admin. |
| `mcp/tests/ageOfMajorityConfig.test.ts` | Direct and composite role create/update guards; retained reads. |
| `mcp/tests/schedulingRbacGrants.test.ts` | Majority config belongs to the read-only scheduling allowlist. |
| `mcp/tests/ageOfMajorityAuthzLive.test.ts` | Separate create/update assertions and cleanup of unexpected successful creates. |
| `docs/build-log/guarantor-cleanup-b/` | Exact guard outputs/diffs, live policy evidence, regression summaries, synthetic screenshots/capture fixtures. |

## Guard proof

All mutations ran in disposable worktrees; source was restored afterward. Counts below are passing/failing tests, not test-file counts. Guard commands and full TAP output are preserved alongside their mutant diffs in [guards](guards/). The guard source head was `de3079f4e89ce01b00bcb1c2f4e35392f0190467`. The R1 live proof ran at `2575055875bb7d7590c572025f62da8a5565d030`; its production and live-test files are identical to the later source head.

| Guard | GREEN | Deliberate break / RED | Restored GREEN |
| --- | --- | --- | --- |
| E1 | 3 pass | Delete owned-child guard: 3 fail | 3 pass |
| E2 | 4 pass | Skip every education recipient write: 4 fail | 4 pass |
| V1 | 3 pass | Delete DOB validity check inside `validateRegistration`: 3 fail, HTTP 201 instead of 400 | 3 pass |
| R1 unit | 4 pass | Restore shared majority create/update rule: 4 fail | 4 pass |
| R1 live | 65 pass, 0 skip | Restore and apply shared grant: 61 pass / 4 TAP failures / 0 skip; Staff create returns 201, update 200 instead of 403 | 65 pass, 0 skip |

R1's four TAP failures are the two staff operation assertions and their parent subtests. Provider/Admin cases remained green. Supplemental notice guards: rendering 3 pass → 3 fail → 3 pass; response validation 1 pass → 1 fail → 1 pass.

## Removed RBAC rules and real policy proof

Removed `AGE_OF_MAJORITY_CONFIG_WRITE_RULE` from the shared scheduling grant; Admin now receives it explicitly. In the synthetic live dry run, the removed rules were:

- `ODOS Staff`: `Basic`, interactions `[create, update]`.
- `ODOS Composite Provider + Staff`: two compiled `Basic` rules, interactions `[create]` and `[update]`.

All three use the existing criterion `Basic?code=https://odos2020.com/fhir/CodeSystem/age-of-majority-config|odos-age-of-majority-config`. Provider, Admin, and Provider+Staff+Admin matched without changes. All five policies matched after restoration; no membership change was needed. Reads/search/history/vread stay as before.

[Live evidence](live/README.md) includes the exact policy deltas, canonical/mutant/restored apply results, complete live-authz outputs, and the task-only adapter. The ordinary bootstrap sync identity received AccessPolicy PATCH 403 after role repair; the privileged seeder received ProjectMembership GET 403. A narrowly scoped synthetic adapter used admin reads and operator conditional policy writes to update only the two observed policies. This proves the local policy delta and R1 guard; it is not a production migration recipe. No application permission was widened for this fixture. No Iris sync occurred.

## Regression results

Exact commands and output footers: [checks.txt](checks.txt).

| Suite | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: |
| Full MCP, task-only PostgreSQL | 5,089 | 52 | 0 |
| Full UI, run from `ui/` | 1,621 | 0 | 0 |
| Comms / education | 430 | 3 | 0 |
| Focused MCP registration / majority / RBAC / comms | 165 | 0 | 0 |
| Focused UI EngageSheet / guarantorEditor / registration / majority | 62 | 0 | 0 |
| Restored credentialed live authorization | 65 | 0 | 0 |

The standalone MCP run explicitly skipped unconfigured live lanes; the credentialed live suite above is separate. Full UI used identical UI source before B2/B3 integration. Preflight: 0 warnings / 0 hard blocks. Scripts typecheck, MCP build, and UI production build exited 0. `git diff --check` passed. Final-head CI, its blocking credentialed live-authz step, bot status, and container stop verification are bound to the exact delivered SHA in the PR body and delivery bundle, after the evidence commit.

## Visible evidence and limits

[Before/after evidence](visual/README.md) uses the real EngageSheet and communications client with synthetic intercepted responses. It proves notice rendering in a component fixture, not the full app route or a real FHIR send. The SMS pair is the primary PR comparison. The supplemental print pair covers rendering only: the existing print confirmation does not expose the chart-update checkbox. Baseline print requests with `alsoUpdateChart` for Patient/unlinked guardians still return the existing 400; this change preserves that behavior.

## Delivery boundary

**NOT EVALUATED.** Codex authored this change. A separate Claude Opus session must evaluate the exact final head before merge. No evaluator marker, operator override, merge, deployment, or Iris sync is part of this task. Task-owned fixture containers are to be stopped, retained, and verified at handoff; final confirmation belongs in the delivered bundle.

This implements an existing decision. No new decision or `decisions/INDEX.md` entry, medical code, canonical URL, or Mandate 14 ledger row was added. No cross-repo code follow-up is required. The constrained post-repair sync identities above remain an explicitly reported operational limitation, not a hidden policy broadening.
