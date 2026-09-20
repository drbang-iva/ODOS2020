# S3b-1 Rev 2 — blocked author bundle

Partial implementation preserved, uncommitted. Rule 3 stops implementation because the full MCP suite needs a fixture adaptation outside section 4. No PR, merge, deployment, independent evaluation, or completed live proof.

## Identity and scope

- Branch: `drbang-iva/followup-s3b1-shape-record`
- Base and current HEAD: `696e679b50b8d2f510d6f9a134a552f2928781d8`
- No commit created; no PR URL.
- No outside-allowlist file edited.
- Required expansion: `mcp/tests/historyRos.test.ts` only, as currently observed.

## Why the stop is required

Two existing tests fail with overview HTTP 502 rather than 200:

- `aggregate and itemized ROS never synthesize each other; overview prefers Charted itemized`
- `overview falls back to the aggregate after the only item review is retracted`

Their shared fixture uses `create: async (row: any) => row` (line 44): no persistence, generated id, or resource version. The first overview of a rowless encounter now creates a shape Basic; the store correctly rejects an incomplete persistence result. The requested repair is a persistence-capable conditional-create fixture with generated ids and versions, retaining all existing ROS assertions. It must not be repaired by suppressing shape persistence errors or weakening parsing.

The MCP typecheck also reports one in-scope TS2345: `ExamOverviewFhirClient.create<T extends Basic>` is narrower than the profile store constructor's `create<T extends Resource>` requirement. This is unfinished implementation work, not a requested allowlist expansion. Implementation stopped when the outside-file dependency was observed.

## Files touched

- `docs/build-log/followup-s3b1-shape-record/BLOCKED.md`
- `docs/build-log/followup-s3b1-shape-record/proof/bootstrap.ts`
- `docs/build-log/followup-s3b1-shape-record/proof/seed-ui.ts`
- `docs/build-log/followup-s3b1-shape-record/proof/stack.mjs`
- `mcp/tests/examShapeRecord.test.ts`
- `mcp/src/clinical-graph/exam-overview-endpoint.ts`
- `mcp/src/clinical-graph/exam-overview-projection.ts`
- `mcp/src/clinical-graph/exam-scope-store.ts`
- `mcp/tests/examOverviewEndpoint.test.ts`
- `ui/src/components/charting/ExamOverviewBoard.tsx`
- `ui/tests/examOverviewBoard.test.tsx`

## Partial work

- Widened the existing URN store; existing rows return immediately, including legacy rows.
- Added shape creation for rowless encounters, profile revision plus nullable persistence version, and UUID write winner check.
- Scope edits retain frozen shape.
- Overview resolves profile families from diagnosis catalogue identity and carries `sectionsOpen` to the board.
- Board adds resolved editor ids to its existing opening union; collapse/shelf storage unchanged.
- Added store, endpoint and board tests; adapted allowed endpoint fixtures without dropping existing assertions.
- Added a task-owned synthetic proof stack under the allowed evidence directory. Bootstrap succeeded after adapting its project-name guard. Feature browser proof has not run.

## Premises at the exact base

P1: caller version, If-Match, conditional create, legacy JSON and field-value winner check confirmed.
P2: URNs retained; no canonical registry entry; preflight extension check applies to the odos2020.com host.
P3: overview reader and scope PUT confirmed. PUT requires both chart.read and chart.write, validates expectedVersion and patient reference, resolves practitioner display.
P4: board reads projection.examScope; routing guard still asserts 57 callers.
P5: catalogue seeds plus overlays confirmed. Rev 2 applied: seed versionId is explicitly null; numeric profile version is retained.
P6: nextVisit.requests and specified Appointment.basedOn wiring absent; no implementation attempted.
P7: both referenced stores use randomUUID winner checks; scope store adopted that mechanism.
P8: collapse/shelf remains per-browser localStorage; no migration.

## Checks and guard status

Initial TDD store run: `node --import tsx --test mcp/tests/examShapeRecord.test.ts` -> 4 tests, 1 pass, 3 fail. One failure exposed accepted token mismatch; two reflected the missing shape API. This is not the completed mutation campaign.

Focused current server run: `node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examShapeRecord.test.ts mcp/tests/examScopeStore.test.ts` -> 27 tests, 27 pass, 0 fail.

Focused current UI run: `node --import tsx --test --test-name-pattern='S3b1' ui/tests/examOverviewBoard.test.tsx` -> 2 tests, 2 pass, 0 fail.

G1: edit/retirement freeze test green; prescribed mutation not run.
G2: legacy parse/project/drawn-lines test green; both prescribed mutations not run.
G3: union with existing lines and persisted finding test green; prescribed mutation not run.
G4: existing stale version test plus conditional-create row-count and mismatched-token tests green; three prescribed mutations not run.
G5: untouched seed numeric version and explicit null versionId test green; prescribed mutation not run.
G6: existing assertions retained; prescribed mutation not run.
G7 VERIFICATION: from ui/, `node --import tsx --test tests/clinicalGraphRouting.test.tsx` -> 8 tests, 8 pass, 0 fail. Caller inventory remains 57. An earlier invocation from the repository root failed on cwd-relative paths; corrected without editing the guard.

Root and UI `npx tsc --noEmit`: exit 0 at base and candidate. MCP: base exit 0; candidate exit 2 with the single TS2345 above.
`npm run preflight`: base and candidate report 0 warnings and 0 hard blocks.
`git diff --check`: exit 0.

## Full suite summaries

- Base `npm --prefix ui test`: 1,813 tests, 1,813 pass, 0 fail, 0 skip.
- Base `npm --prefix mcp test` before stack setup: 6,167 tests, 6,057 pass, 43 fail, 67 skip. Database-dependent checks failed because no Postgres was listening at the default test port. This is not a green baseline.
- Initial candidate MCP run, also without configured Postgres: 6,172 tests, 6,060 pass, 45 fail, 67 skip. Superseded by the configured run below; not counted as passing evidence.
- Candidate configured full MCP command: `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:28736/medplum ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` -> 6,171 tests, 6,114 pass, 2 fail, 55 skip, exit 1. Both failures are the excluded ROS fixture named above. The opt-out makes the wrapper report the executed-test result; it does not claim live-authz coverage. Existing credential-gated skips remain disclosed.
- Candidate `npm --prefix ui test`: 1,815 tests, 1,815 pass, 0 fail, 0 skip. UI delta: 1,813 base + 2 added = 1,815.

The two MCP totals from unconfigured runs include an extra failing suite hook and additional DB-related skips; they must not be compared to the configured total as a feature-test delta. A green configured base rerun and final candidate proof remain outstanding.

## Cleanup

The task-owned `odos-s3b1-proof` containers were stopped, retaining recoverable volumes. Final `docker ps --format '{{.Names}}\t{{.Status}}'`:

```text
vf-prac1b-walk-db    Up 43 hours
```

The pre-existing VisionForge container was left running.

## JSON contract (synthetic test evidence, not a live record)

Before: `{ "examScope": "office-visit", "setAt": "2026-09-19T12:00:00Z" }`.
Legacy parse: `{ "examScope": "office-visit", "versionId": "1", "setBy": { "reference": "Practitioner/synthetic" }, "setAt": "2026-09-19T12:00:00Z" }` — no shape fields.
New row adds `profilesApplied: [{ profileKey: "glaucoma", version: 1, versionId: null }]`, `sectionsOpen` copied from the applied profile, `shapedAt`, and an internal `writeToken` alongside examScope/setAt. Existing rows are never retro-shaped. No new medical codes, billing codes, clinical intervals or canonical URLs were introduced.

## Proof and remaining work

Live proof 1–3 and screenshots at 1440/390: not run. No screenshot paths claimed.
Full verification is not green; no completed base + added = passing-new-total claim.
No new design decision; decisions/INDEX.md and Mandate 14 ledgers unchanged.
Independent evaluator remains Claude Opus 5, high effort after author proof is completed.

Not done: picker; Following strip; Since last visit; S3b-3 view-state migration; S3c test queue and right-panel tab; S4 nextVisit.requests / Appointment.basedOn and resolution cases 2/6; S5 Apply changes.

NOT EVALUATED

blocked
