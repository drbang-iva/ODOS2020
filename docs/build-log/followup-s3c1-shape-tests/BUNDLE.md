# S3c-1 REV 2 sealed bundle

The encounter shape now stores testsProposed at automatic shaping and explicit picking. Tests come only from the selected profile snapshots and are merged by orderable plus focus, retaining all profile sources. Old records without testsProposed remain unchanged. No UI or clinical order is created.

Base: `91f5446407163aba633d278957dde60fde733ebe`.
Branch: `drbang-iva/followup-s3c1-shape-tests`.
Coder: Codex, GPT-6. Recommended effort: high; exact runtime variant/effort is not exposed and is not attested.
Evaluator: Claude Opus 5. **NOT EVALUATED. Do not merge.**

## Files touched

- `mcp/src/clinical-graph/exam-scope-store.ts`: optional snapshot schema, union sources, supplied-proposal merging in both writes.
- `mcp/src/clinical-graph/exam-overview-endpoint.ts`: proposals resolved from the same selected profile snapshots, with partial results retained on test-resolution failure.
- `mcp/tests/examShapeRecord.test.ts`: prior assertions retained; resolver inputs adapted; six new store guards.
- `mcp/tests/examOverviewEndpoint.test.ts`: three new endpoint tests, all original assertions retained.
- `docs/build-log/followup-s3c1-shape-tests/`: summaries, mutation reproducer, local synthetic persistence reproducer, stored JSON.

No file outside the allowlist was edited or needed. No new decision was made beyond implementing the supplied contract; no decisions/INDEX.md change. No billing code, clinical interval, orderable, terminology assertion, or FHIR canonical was added; no Mandate 14 ledger row was needed.

## P1–P8 at origin/main

| Premise | Re-verification |
|---|---|
| P1 | Scope schema has profilesApplied, sectionsOpen, shapedAt, default derived source, and chooser/time validation for explicit. No tests field at base. |
| P2 | shapeIfAbsent returns a persisted row before invoking its resolver; pick takes selected profiles. Both call write. |
| P3 | Profile testsQueuedByDefault has max 100; identity guard uses orderable plus focus, never label. |
| P4 | Plan generator distinguishes focus for repeated orderables; stageCharge deduplicates encounter plus procedure concept. The profile identity is reused literally here. |
| P5 | PENDING_ORDERABLES contains the four named keys; HiddenPlanSetItem has not-orderable. Unavailable profile test keys are retained, not silently discarded. |
| P6 | Glaucoma is the only plan-set spec collection, compiled in protocol-fixtures. No encounter-to-plan-set resolver was added. |
| P7 | Overview write failures still leave the board available; 409/412 re-read the winner. New test-resolution failures preserve already resolved proposals and persist the rest of the shape. |
| P8 REV 2 | clinicalGraphRouting.test.tsx registers 8 tests; its line 41 asserts callers.length === 58. Both remain unchanged. |

Fetch and open-PR scope check succeeded. Open PRs #647 and #626 had no allowed-file overlap. The root checkout was not changed.

## Representation and future plan-set half

Each entry has orderable, optional focus, and nonempty sources. A source is `{kind: "profile", profileKey}` or `{kind: "plan-set", planSetKey}`. Only profile sources are produced now. The latter union arm can accept future plan-set provenance without rewriting existing records. No plan-set resolver or union producer was built.

The endpoint supplies `{profiles, testsProposed}` to automatic shaping and supplies proposals alongside profiles to pick. The store only validates, merges and persists supplied snapshots; it never reads live profiles. Old records retain the absent property; consumers can use `testsProposed ?? []` without inferring that old tests were recorded.

## G1–G7 mutation proof

All mutations were restored byte-for-byte before their green run. Commands and summaries below are from `python3 docs/build-log/followup-s3c1-shape-tests/proof/mutations.py`. Full raw logs are not included.

### G1

Command: `node --import tsx --test --test-name-pattern=S3c1 G1 mcp/tests/examShapeRecord.test.ts`

RED (exit 1):

```text
not ok 1 - S3c1 G1 frozen tests survive profile edits and retirement; new visits use edited tests
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):

```text
ok 1 - S3c1 G1 frozen tests survive profile edits and retirement; new visits use edited tests
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G2

Command: `node --import tsx --test --test-name-pattern=S3c1 G2 mcp/tests/examShapeRecord.test.ts`

RED (exit 1):

```text
not ok 1 - S3c1 G2 dedup uses orderable plus focus and preserves all sources
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):

```text
ok 1 - S3c1 G2 dedup uses orderable plus focus and preserves all sources
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G3

Command: `node --import tsx --test --test-name-pattern=S3c1 G3 mcp/tests/examShapeRecord.test.ts`

RED (exit 1):

```text
not ok 1 - S3c1 G3 every proposed test records its profile including unavailable tests
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):

```text
ok 1 - S3c1 G3 every proposed test records its profile including unavailable tests
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G4

Command: `node --import tsx --test --test-name-pattern=S3c1 G4 mcp/tests/examShapeRecord.test.ts`

RED (exit 1):

```text
not ok 1 - S3c1 G4 S3b-era shapes without tests load unchanged and report none
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):

```text
ok 1 - S3c1 G4 S3b-era shapes without tests load unchanged and report none
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G5

Command: `node --import tsx --test --test-name-pattern=S3c1 G5 mcp/tests/examShapeRecord.test.ts`

RED (exit 1):

```text
not ok 1 - S3c1 G5 both automatic and explicit write paths carry tests
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):

```text
ok 1 - S3c1 G5 both automatic and explicit write paths carry tests
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G7

Command: `node --import tsx --test --test-name-pattern=S3c1 G7|S3b2 G1 mcp/tests/examShapeRecord.test.ts`

RED (exit 1):

```text
not ok 1 - S3b2 G1 explicit shape survives automatic shaping at the store boundary
not ok 2 - S3c1 G7 legacy scope is never retro-shaped at the store boundary
# tests 2
# pass 0
# fail 2
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):

```text
ok 1 - S3b2 G1 explicit shape survives automatic shaping at the store boundary
ok 2 - S3c1 G7 legacy scope is never retro-shaped at the store boundary
# tests 2
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### best-effort additional guard

Command: `node --import tsx --test --test-name-pattern=S3c1 unresolved tests mcp/tests/examOverviewEndpoint.test.ts`

RED (exit 1):

```text
not ok 1 - S3c1 unresolved tests retain partial proposals and still persist the shape and render the board
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):

```text
ok 1 - S3c1 unresolved tests retain partial proposals and still persist the shape and render the board
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

G6 is a verification, not a mutation. The final commit diff inventory and UI counts appear below. No UI path is permitted or changed.

## Proof 1–3: real synthetic Medplum persistence

Command: `node --import tsx docs/build-log/followup-s3c1-shape-tests/proof/persistence.ts`.

```json
{"oldVisitTests":3,"newVisitTests":1,"explicitVisitTests":3,"legacyRecordedTests":[],"checksPassed":4}
```

This uses only the task-owned local Docker project odos-s3c1-proof. It is real persistence proof using a synthetic service identity, not a live clinician AccessPolicy verdict. Endpoint tests separately exercise automatic and explicit handler wiring. No browser or UI claim is made.

Stored JSON before profile editing:

```json
{
  "examScope": "comprehensive",
  "setAt": "2026-09-21T04:30:52.220Z",
  "profilesApplied": [
    {
      "profileKey": "glaucoma",
      "version": 1,
      "versionId": null
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
  "testsProposed": [
    {
      "orderable": "visual-field-threshold",
      "sources": [
        {
          "kind": "profile",
          "profileKey": "glaucoma"
        }
      ]
    },
    {
      "orderable": "scodi-optic-nerve",
      "sources": [
        {
          "kind": "profile",
          "profileKey": "glaucoma"
        }
      ]
    },
    {
      "orderable": "fundus-photography",
      "focus": "optic nerve",
      "sources": [
        {
          "kind": "profile",
          "profileKey": "glaucoma"
        }
      ]
    }
  ],
  "shapedAt": "2026-09-21T04:30:52.220Z",
  "source": "derived",
  "writeToken": "7f22c258-a830-4034-893a-baed97870256"
}
```

Stored JSON after profile editing (also exactly equal after retirement):

```json
{
  "examScope": "comprehensive",
  "setAt": "2026-09-21T04:30:52.220Z",
  "profilesApplied": [
    {
      "profileKey": "glaucoma",
      "version": 1,
      "versionId": null
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
  "testsProposed": [
    {
      "orderable": "visual-field-threshold",
      "sources": [
        {
          "kind": "profile",
          "profileKey": "glaucoma"
        }
      ]
    },
    {
      "orderable": "scodi-optic-nerve",
      "sources": [
        {
          "kind": "profile",
          "profileKey": "glaucoma"
        }
      ]
    },
    {
      "orderable": "fundus-photography",
      "focus": "optic nerve",
      "sources": [
        {
          "kind": "profile",
          "profileKey": "glaucoma"
        }
      ]
    }
  ],
  "shapedAt": "2026-09-21T04:30:52.220Z",
  "source": "derived",
  "writeToken": "7f22c258-a830-4034-893a-baed97870256"
}
```

New visit after editing:

```json
{
  "examScope": "comprehensive",
  "setAt": "2026-09-21T04:30:52.266Z",
  "profilesApplied": [
    {
      "profileKey": "glaucoma",
      "version": 2,
      "versionId": "b26dd4c5-cec6-48ac-8f92-a20a8bbe822b"
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
  "testsProposed": [
    {
      "orderable": "visual-field-threshold",
      "sources": [
        {
          "kind": "profile",
          "profileKey": "glaucoma"
        }
      ]
    }
  ],
  "shapedAt": "2026-09-21T04:30:52.266Z",
  "source": "derived",
  "writeToken": "226761bb-134a-477f-8517-87c0736f30a7"
}
```

S3b-era row parses to (no testsProposed property, no rewrite):

```json
{
  "profilesApplied": [
    {
      "profileKey": "glaucoma",
      "version": 1,
      "versionId": null
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
  "shapedAt": "2026-09-21T04:30:52.220Z",
  "source": "derived",
  "examScope": "comprehensive",
  "versionId": "f31349ea-d9e8-4279-a250-18f79b4f237b",
  "setBy": {
    "reference": "Practitioner/ab109c51-cacd-47f4-836b-31849b1e8fde"
  },
  "setAt": "2026-09-21T04:30:52.220Z"
}
```

Full explicit, retirement and legacy stored values and implementation SHA-256 hashes are in `persistence.json`.

## Proof 4 and G6: complete suites and unchanged UI

| Command | Base | Candidate |
|---|---|---|
| `npm --prefix ui test` | 1828 pass, 0 fail, 0 skip | 1828 pass, 0 fail, 0 skip |
| Full MCP command below | 6201 total; 6146 pass, 0 fail, 55 skip | 6210 total; 6155 pass, 0 fail, 55 skip |
| `npx tsc --noEmit` | exit 0 | exit 0 |
| `npx tsc --noEmit -p mcp/tsconfig.json` | exit 0 | exit 0 |
| `npx tsc --noEmit -p ui/tsconfig.json` | exit 0 | exit 0 |
| `npm run preflight` | 0 warnings, 0 hard blocks | 0 warnings, 0 hard blocks |

UI: 1828 + 0 = 1828. MCP: 6201 + 9 = 6210. Focused shape/overview: 43 + 9 = 52 passing tests.

```sh
ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:32780/medplum ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test
```

The default full MCP suite ran against task-owned PostgreSQL. Existing 55 skips are retained; the opt-out acknowledges unavailable credentials and is not live authorization proof. Initial unconfigured invocation failed on missing PostgreSQL; the complete configured base and candidate reruns both exited 0. Actual summaries:

base-ui:

```text
# tests 1828
# suites 0
# pass 1828
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

candidate-ui:

```text
# tests 1828
# suites 0
# pass 1828
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

base-mcp:

```text
# tests 6201
# suites 0
# pass 6146
# fail 0
# cancelled 0
# skipped 55
# todo 0
```

candidate-mcp:

```text
# tests 6210
# suites 0
# pass 6155
# fail 0
# cancelled 0
# skipped 55
# todo 0
```

G6 command: `git diff --name-only 91f54464..HEAD`. Inventory (no ui/ path):

```text
docs/build-log/followup-s3c1-shape-tests/BUNDLE.md
docs/build-log/followup-s3c1-shape-tests/PROGRESS.md
docs/build-log/followup-s3c1-shape-tests/mutations.json
docs/build-log/followup-s3c1-shape-tests/persistence.json
docs/build-log/followup-s3c1-shape-tests/proof/mutations.py
docs/build-log/followup-s3c1-shape-tests/proof/persistence.ts
docs/build-log/followup-s3c1-shape-tests/proof/stack.mjs
docs/build-log/followup-s3c1-shape-tests/suite-summaries.json
mcp/src/clinical-graph/exam-overview-endpoint.ts
mcp/src/clinical-graph/exam-scope-store.ts
mcp/tests/examOverviewEndpoint.test.ts
mcp/tests/examShapeRecord.test.ts
```

Final container check: `docker ps --format '{{.Names}}\t{{.Status}}'`:

```text
vf-prac1b-walk-db	Up 2 days
```

No odos-s3c1- container remains running. Both task stack sets were stopped; volumes retained. The remaining container belongs to another task and was left alone.

## Risks and follow-ups

- NOT EVALUATED: Claude Opus 5 must independently inspect the final PR head before merge.
- Existing credential-dependent full-suite skips do not prove live authorization. This slice changes neither policy grants nor authorization behavior.
- Legacy absence means no tests were recorded, not a retroactively inferred list.
- Not done: Follow-up right-panel tab and five states (S3c-2); plan-set half of the union; any UI change; Following strip, Since last visit and pull-forward (S5); nextVisit.requests[] and Appointment.basedOn (S4).
- No cross-repo edit is required for this implementation. S3c-2 consumes the frozen field later.

needs-review
