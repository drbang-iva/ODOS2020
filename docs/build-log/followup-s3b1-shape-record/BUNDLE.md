# S3b-1 shape record — Rev 3 sealed author bundle

The overview freezes profile revisions and resolved section names only for encounters with no stored scope row. Existing shaped and legacy rows remain unchanged. The board unions frozen section names with its existing rows. A failed bookkeeping write or confirmation serves the unshaped board; conflicts re-read the winner without another write. The strict scope PUT still refuses concurrent writes. `historyRos.test.ts` is untouched and passes. No merge or deployment.

This supersedes the **status**, not the historical evidence, in `BLOCKED.md`. Rev 3 resolved that stop without expanding scope.

## Identity

- Base: `696e679b50b8d2f510d6f9a134a552f2928781d8` (fresh origin/main verified).
- Branch: `drbang-iva/followup-s3b1-shape-record`.
- Implementation commit and served source: `1818dad4415958af6fd5be73c8ff177b9628bc59`.
- The final PR head is reported in the PR description and handoff; subsequent evidence-only commits do not change these implementation files. `source-hashes.json` and `served-identity.json` bind the served files/assets to this implementation.
- Requested/recommended effort: high. Actual session metadata: `gpt-6-astra`, low. The run did not switch models or runtime effort; actual provenance is disclosed rather than mislabeled.
- Coder: Codex. Independent evaluator: Claude Opus 5, high effort. NOT EVALUATED.

## Files touched

Implementation: `mcp/src/clinical-graph/exam-scope-store.ts`, `mcp/src/clinical-graph/exam-overview-endpoint.ts`, `mcp/src/clinical-graph/exam-overview-projection.ts`, `ui/src/components/charting/ExamOverviewBoard.tsx`.
Tests: `mcp/tests/examShapeRecord.test.ts`, `mcp/tests/examOverviewEndpoint.test.ts`, `ui/tests/examOverviewBoard.test.tsx`.
Evidence and reproducible harness: this directory only, including the preserved `BLOCKED.md`.
No other file was changed; notably `mcp/tests/historyRos.test.ts` and the 57-caller routing assertion are unchanged.

## P1–P8 re-verification

| Premise | Result at base |
|---|---|
| P1 | Existing store compares caller expectedVersion, sends it in If-Match, uses identifier If-None-Exist, and confirms the write by field values. URNs and Basic code retained; confirmation now uses a UUID token. |
| P2 | Registry has no exam-scope entry; preflight extension rule checks only the odos2020.com host. No new canonical URL or registry row. |
| P3 | Overview reader and scope PUT confirmed. PUT requires **chart.read AND chart.write** before writes, validates expectedVersion, checks the encounter's Patient reference, and resolves practitioner display. Automatic first-open bookkeeping follows the authenticated chart.read path and fails open under Rev 3; no scope PUT authorization was weakened. |
| P4 | Existing board reads projection.examScope. sectionsOpen travels in that projection; no new UI API client. Routing guard still asserts exactly 57 callers. |
| P5 | S3a catalogue combines seeds with practice overlays. Each applied row records profileKey, numeric version and exact list() versionId, including explicit null for an untouched seed. |
| P6 | No nextVisit.requests implementation, and Appointment.basedOn is not wired in the named scheduling paths. Cases 2/6 remain excluded. |
| P7 | Both catalogue stores use randomUUID tokens and post-write checks. Scope store now adopts this stronger check. |
| P8 | Collapse/shelf state remains in browser localStorage; its source file is unchanged. |

## Full suites, types and preflight

| Command | Base | Candidate |
|---|---|---|
| `npm --prefix ui test` | 1,813 pass / 0 fail / 0 skip | 1,816 pass / 0 fail / 0 skip |
| Full MCP command below | 6,111 pass / 0 fail / 55 skip; 6,166 total | 6,120 pass / 0 fail / 55 skip; 6,175 total |
| `npx tsc --noEmit` at root | exit 0 | exit 0 |
| `npx tsc --noEmit` in mcp | exit 0 | exit 0 (also production build) |
| `npx tsc --noEmit` in ui | exit 0 | exit 0 (also production build) |
| `npm run preflight` | 0 warnings / 0 hard blocks | 0 warnings / 0 hard blocks |

MCP: **6,166 base + 9 added = 6,175 total**, with the same 55 skips. UI: **1,813 base + 3 added = 1,816 total**.

```sh
ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:28736/medplum ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test
```

This is the complete default MCP suite against task-owned Postgres. The wrapper's explicit opt-out acknowledges its existing credential-gated live skips; it does not claim the live-authz lane ran. New feature behavior is independently exercised against the real synthetic stack below. Misconfigured pre-stack runs and the earlier Rev 2 failures remain disclosed in `BLOCKED.md`, not counted as green evidence.

Focused server plus unchanged ROS suite: `node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examShapeRecord.test.ts mcp/tests/examScopeStore.test.ts mcp/tests/historyRos.test.ts` -> **57 tests, 57 pass, 0 fail**.

`git diff 696e679b -- mcp/tests/historyRos.test.ts` -> no output. Both named ROS overview tests that previously returned 502 now pass without fixture changes.
`git diff --check` -> exit 0.

## G1–G8 mutation evidence

Every mutation below was applied alone to an allowed production file, executed, restored in a finally block, and executed again. Reproduction: `python3 docs/build-log/followup-s3b1-shape-record/proof/mutations.py`. Exact commands and concise outputs are in `mutations.json`.

### G1

Command: `node --import tsx --test '--test-name-pattern=S3b1 G1' mcp/tests/examShapeRecord.test.ts`

Broken (exit 1):

```text
not ok 1 - S3b1 G1 profile edit and retirement never reshape a stored visit, scope edits preserve shape
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored (exit 0):

```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G2a

Command: `node --import tsx --test '--test-name-pattern=S3b1 G2' ui/tests/examOverviewBoard.test.tsx`

Broken (exit 1):

```text
not ok 1 - S3b1 G2 legacy row parses and keeps exactly the same drawn lines without retro-shaping
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored (exit 0):

```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G2b

Command: `node --import tsx --test '--test-name-pattern=S3b1 G2' ui/tests/examOverviewBoard.test.tsx`

Broken (exit 1):

```text
not ok 1 - S3b1 G2 legacy row parses and keeps exactly the same drawn lines without retro-shaping
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored (exit 0):

```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G3

Command: `node --import tsx --test '--test-name-pattern=S3b1 G3' ui/tests/examOverviewBoard.test.tsx`

Broken (exit 1):

```text
not ok 1 - S3b1 G3 shaped lines union with every existing line and ignore unavailable keys
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored (exit 0):

```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G4-stale

Command: `node --import tsx --test '--test-name-pattern=S2a scope store guards' mcp/tests/examScopeStore.test.ts`

Broken (exit 1):

```text
not ok 1 - S2a scope store guards first creation and versioned edits
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored (exit 0):

```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G4-create

Command: `node --import tsx --test '--test-name-pattern=S3b1 G4 conditional' mcp/tests/examShapeRecord.test.ts`

Broken (exit 1):

```text
not ok 1 - S3b1 G4 conditional concurrent creates leave exactly one persisted row
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored (exit 0):

```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G4-token

Command: `node --import tsx --test '--test-name-pattern=S3b1 G4 write-token' mcp/tests/examShapeRecord.test.ts`

Broken (exit 1):

```text
not ok 1 - S3b1 G4 write-token mismatch refuses identical persisted field values
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored (exit 0):

```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G5

Command: `node --import tsx --test '--test-name-pattern=S3b1 G5' mcp/tests/examShapeRecord.test.ts`

Broken (exit 1):

```text
not ok 1 - S3b1 G5 untouched seed records numeric revision and explicit null versionId
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored (exit 0):

```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G6

Command: `node --import tsx --test '--test-name-pattern=S2a G7' mcp/tests/examOverviewEndpoint.test.ts`

Broken (exit 1):

```text
not ok 1 - S2a G7 projection path cannot import or use the scheduling category
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored (exit 0):

```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G8

Command: `node --import tsx --test '--test-name-pattern=S3b1 G8' mcp/tests/examOverviewEndpoint.test.ts ui/tests/examOverviewBoard.test.tsx`

Broken (exit 1):

```text
not ok 1 - S3b1 G8 an unconfirmed shape create serves the unshaped overview and retries next open
not ok 2 - S3b1 G8 unconfirmed bookkeeping write still draws the unshaped board
# tests 2
# pass 0
# fail 2
# skipped 0
```

Restored (exit 0):

```text
# tests 2
# pass 2
# fail 0
# skipped 0
```

### conflict-reread

Command: `node --import tsx --test '--test-name-pattern=S3b1 conflict' mcp/tests/examOverviewEndpoint.test.ts`

Broken (exit 1):

```text
not ok 1 - S3b1 conflict 409 re-reads the winner without a second write
not ok 2 - S3b1 conflict 412 re-reads the winner without a second write
# tests 2
# pass 0
# fail 2
# skipped 0
```

Restored (exit 0):

```text
# tests 2
# pass 2
# fail 0
# skipped 0
```

### diagnosis-match

Command: `node --import tsx --test '--test-name-pattern=S3b1 overview freezes' mcp/tests/examOverviewEndpoint.test.ts`

Broken (exit 1):

```text
not ok 1 - S3b1 overview freezes the catalogue profile selected by encounter diagnosis family
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored (exit 0):

```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

G7 is **verification only**. From ui/: `node --import tsx --test tests/clinicalGraphRouting.test.tsx`:

```text
# tests 8
# pass 8
# fail 0
# skipped 0
```

G2a requires new fields during legacy parsing. G2b deliberately retro-shapes a legacy row and fails the drawn-lines comparison. G3 deliberately filters both editor lines and findings to shape membership. G4 separately corrupts caller-version handling, removes conditional-create headers (row-count assertion), and removes the token check. G5 drops numeric version from an untouched-seed record. G6 re-keys the registry by category and trips the shipped S2a guard. G8 lets the write/confirmation exception escape the endpoint, failing both HTTP-200 and drawn-board assertions. Additional conflict-reread and diagnosis-match mutations protect the new branches.

## Real-stack proof 1–4

The isolated `odos-s3b1-proof` stack uses local synthetic data only. Base front door 32692 and candidate front door 32691 were verified to be separate task-owned Caddy processes. The candidate was rebuilt and served from implementation commit 1818dad4. `served-identity.json` records source and served asset hashes without credentials or local absolute paths.

1. A synthetic visit with an existing catalogue diagnosis selecting the glaucoma profile opens with the profile's lines. Its stored row names the exact profile version and versionId returned by the catalogue. The proof changes the scope to Office visit **after** first opening so profile lines are visually distinguishable; shaping itself never changes exam scope.
2. In actual Settings, add Pachymetry and save. Reload the original visit: same stored shape and exact drawn-line list. Open a new visit: Pachymetry is drawn and the new profile versionId is recorded. Turn off the profile in Settings: the original remains unchanged.
3. Open legacy Office visits carrying old scope JSON. Their exact drawn editor lists match the same visits served by the base revision at both widths, and the legacy rows remain unshaped and unchanged.
4. Full suite/type/preflight results are above. A real concurrent conditional-create check additionally produces **one stored row, one successful writer, one refused writer**.

Commands:

```sh
node docs/build-log/followup-s3b1-shape-record/proof/stack.mjs prepare
node docs/build-log/followup-s3b1-shape-record/proof/stack.mjs up
node --import tsx docs/build-log/followup-s3b1-shape-record/proof/seed-shape.ts
node docs/build-log/followup-s3b1-shape-record/proof/stack.mjs build
node docs/build-log/followup-s3b1-shape-record/proof/stack.mjs serve
cp .odos/s3b1-proof/credentials.json .odos/s3b1-before-proof/credentials.json
cp .odos/s3b1-proof/shape-visits.json .odos/s3b1-before-proof/shape-visits.json
node docs/build-log/followup-s3b1-shape-record/proof/browser.mjs --before
node docs/build-log/followup-s3b1-shape-record/proof/browser.mjs
node --import tsx docs/build-log/followup-s3b1-shape-record/proof/read-records.ts
```

The before mode needs the pristine base worktree built/served with `--base-server --app-root "$BASE_WORKTREE"`; its isolated runtime uses the distinct base ports. After preparing that runtime, the two explicit copy commands above stage the shared synthetic identity/visit fixtures without replacing its base manifest. prepare is for a fresh runtime; repeated runs reuse the existing task-owned manifest rather than overwriting credentials. All runtime credentials remain gitignored under `.odos/`.

Results: `browser-before.json`, `browser-after.json`, `stored-records.json`.

Screenshot paths (relative to this directory), each at 1440 and 390:

- `screenshots/1440-original-shape.png`, `screenshots/390-original-shape.png`.
- `screenshots/1440-original-after-edit.png`, `screenshots/390-original-after-edit.png`.
- `screenshots/1440-new-after-edit.png`, `screenshots/390-new-after-edit.png`.
- `screenshots/1440-legacy-base.png`, `screenshots/390-legacy-base.png`.
- `screenshots/1440-legacy-current.png`, `screenshots/390-legacy-current.png`.

Captured images were inspected. The existing narrow-screen header clipping appears on the base too; it is outside this change. An initial browser run stopped at a repeated synthetic login; the harness now reuses its authenticated session across viewport runs. The final complete run passed both widths with zero page errors.

## Stored JSON before / after

Legacy stored value (actual synthetic legacy row):

```json
{
  "examScope": "office-visit",
  "setAt": "2026-09-19T12:00:00Z"
}
```

New frozen shape (actual synthetic original visit; scope subsequently changed to Office visit without changing its shape):

```json
{
  "examScope": "office-visit",
  "setAt": "2026-09-20T22:40:41.344Z",
  "profilesApplied": [
    {
      "profileKey": "glaucoma",
      "version": 1,
      "versionId": "c77da908-0780-4151-a36f-01e4524648d9"
    }
  ],
  "sectionsOpen": [
    "hpi",
    "va",
    "pupils",
    "cvf",
    "iop",
    "dilation",
    "cup-disc",
    "ocular-health:posterior:fundus",
    "imaging",
    "assessment"
  ],
  "shapedAt": "2026-09-20T22:40:41.190Z",
  "writeToken": "d1be0b7c-8035-4183-9712-15dfe0498139"
}
```

Legacy parsing returns examScope, Basic meta.versionId, author as setBy, and setAt; profilesApplied, sectionsOpen and shapedAt remain absent. The internal writeToken is not exposed in the scope projection. `stored-records.json` contains all six sampled rows. The untouched-seed test additionally asserts `{ "profileKey": "glaucoma", "version": 1, "versionId": null }`; null is retained as a real field.

## Automatic review adjudication

CodeRabbit reviewed 5973ce21 and identified a missing fixture-staging instruction. The commands now explicitly copy credentials.json and shape-visits.json into the base runtime, preserving its distinct manifest; both copies and the retained manifest were checked locally. This is a reproduction-documentation correction only; application source and recorded browser proof are unchanged.

The suggested active-only diagnosis catalogue filter is not adopted. This slice resolves existing encounter diagnoses, not new catalogue selections. Deactivating a selectable catalogue entry does not invalidate an already-recorded Condition; excluding it here would silently drop its family from first-open matching. Inactive follow-up profiles are already excluded. Claude Opus 5 should verify this distinction in independent evaluation.

PR-Agent's missing-identifier concern is not applicable: parseDiagnosisIdentifier returns an empty object for undefined input; the catalogue lookup then produces no match, without throwing.

## Cleanup, boundaries and follow-ups

Stopped both task app supervisors and all `odos-s3b1-proof` containers. Volumes retained for recoverability. Final `docker ps --format '{{.Names}}\t{{.Status}}'`:

```text
vf-prac1b-walk-db    Up 43 hours
```

No outside-allowlist change or expansion. No new clinical code, billing code, clinical interval or FHIR canonical URL; no Mandate 14 ledger rows needed. No new design decision authored; decisions/INDEX.md unchanged. The Rev 3 operator ruling is the implementation contract.

**Not done:** picker; Following strip; Since last visit; S3b-3 view-state migration; S3c test queue and right-panel tab; S4 nextVisit.requests / Appointment.basedOn and resolution cases 2 and 6; S5 Apply changes.

Unknown section names that do not resolve to the current editor inventory remain undrawn without error. Existing data lines remain visible. Full credential-gated live suites remain unexecuted here; the concrete new surface and storage behavior were proved on the disposable real stack.

Independent evaluation by Claude Opus 5 remains required at the final PR head. Author proof and bot review do not satisfy that gate. Do not merge.

NOT EVALUATED

needs-review
