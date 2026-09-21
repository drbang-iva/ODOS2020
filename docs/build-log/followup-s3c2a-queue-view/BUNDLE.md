# S3c-2a sealed implementation bundle

The read-only Follow-up tab displays frozen proposed-test labels and sources with live order/catalogue state.
Glaucoma and macula visits are proven through the real synthetic API and Chrome at desktop and phone widths.
Full UI and PostgreSQL-backed MCP suites have zero failures; all 20 mutation cases turn red and restore green.
R1–R5 and every granted before/after edit are recorded in RULINGS.md.
No write controls, new orderables, fees or billing codes were added.
NOT EVALUATED — Claude Opus 5 must independently evaluate the PR head before merge. Do not merge.

Base: `9adec598a7d012729ca239cce11aab1b726171f0`. Branch: `drbang-iva/followup-s3c2a-queue-view`.
PR URL and exact committed head are supplied in the PR description and handoff; this evidence is part of that head.
Coder: Codex, GPT-6; high effort recommended, runtime effort/variant undisclosed by the session.
Final pre-PR fetch: main unchanged; #647 OPEN. R1 rebase condition did not arise.

## Scope and rulings

See [RULINGS.md](RULINGS.md) for R1–R5 and verbatim before/after edits, including the three original frozen-field expectations.
R1 permits the isolated index.ts insertion below all grant pins; grant-check script untouched.
R2 replaces the invalid no-database baseline with dedicated PostgreSQL and CI environment.
R3 changes only the tab title four→five and count 4→5.
R4 changes only two mounted-surface counts 2→3; Photos remains first/active and modal suppression remains 0.
R5 adds one explanatory comment and route count 105→106; definition dependencies 50 and procedure dependencies 6 stay unchanged. Literal app.get registration retained.
The only file added to the kickoff allowlist is mcp/tests/findingDefinitionStore.test.ts under R5. Nothing else outside section 4 was needed.

## Verification counts

| Suite | Base total/pass/fail/skip | Added | Candidate total/pass/fail/skip |
|---|---|---:|---|
| UI | 1828 / 1828 / 0 / 0 | 6 | 1834 / 1834 / 0 / 0 |
| MCP | 6210 / 6156 / 0 / 54 | 12 | 6222 / 6168 / 0 / 54 |

Commands: `npm --prefix ui test`; `npm --prefix mcp test` with `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:29857/medplum`, `ODOS_REAL_WEASYPRINT_TEST=1`, `WEASYPRINT_BIN` pointing to disposable pinned WeasyPrint 69.0, and `ODOS_ALLOW_UNGATED_MCP=1`.
The database container was odos-s3c2a-suite-postgres. All MCP guard runs use that database too. The 54 skips include 47 credentialed live-authorization skips; the full suite is not claimed as that live gate.
`npx tsc --noEmit`, `npx tsc --noEmit -p mcp/tsconfig.json`, `npx tsc --noEmit -p ui/tsconfig.json`: exit 0, no diagnostics.
`npm run preflight`: 0 warnings, 0 hard blocks. MCP/UI builds succeeded. `git diff --check`: clean.
Focused server 64/64; focused UI 134/134. Machine-readable summaries: candidate-summaries.json.

Own new-test helper correction: G12 initially serialized circular React Fiber children; it now reads the status paragraph children. No existing assertion was weakened. The live harness's expected macula row order was corrected to the stored order; production unchanged.

## Premises P1–P11, verified against fetched base

| Premise | Result |
|---|---|
| P1 | Stored entries initially contain orderable/focus/sources; merge identity is orderable plus normalized focus. |
| P2 | Profile schema owns label, optional reason/resultSection/choice and profile label; optional freeze fields reuse these shapes. |
| P3 | Orders are PlanActionInstance Basics; practice list requires encounter and patient filtering. |
| P4 | Selected/modified are live; removed/cancelled excluded. Proposed finding state is not a plan-action state. |
| P5 | mergeKey drops first focus; matching uses payload orderableKey plus normalized focus. |
| P6 | Existing protocol reader uses staff FHIR; its extra follow-up filter is replaced by required order filter here. |
| P7 | Active fee snapshot is catalogue truth; pending list is fallback reason only. |
| P8 | Base highest grant pin 7945; insertion immediately after exam-view-state 8671–8684. Existing Vite/frontdoor proxy reaches route. |
| P9 | Source caller inventory 58→59, guarded by G14. |
| P10 | Follow-up follows Engage; existing entry keyboard path ends at Engage. Photos remains first, modal hides all surfaces. |
| P11 | Existing chart harness dispatches by URL; one new stub branch, appended lazy-fetch integration guard. |

## Live proof 1–4

Reproduction: `node docs/build-log/followup-s3c2a-queue-view/proof/stack.mjs prepare`, then `up`, `build`, `serve`; run `proof/live.ts` with tsx and the dedicated proof PostgreSQL URL (localhost:29866), then `node docs/build-log/followup-s3c2a-queue-view/proof/browser.mjs`. Runtime credentials remain gitignored. Never target a real practice.
The proof seeder persists shapes with the production resolver/store; G9 separately proves automatic and explicit endpoint paths. The existing protocol item-add HTTP route returned 200 for order-fundus-photography. Queue requests use the actual frontdoor/backend and synthetic staff authentication.

### glaucoma: stored testsProposed

```json
[
  {
    "orderable": "visual-field-threshold",
    "label": "Visual field",
    "sources": [
      {
        "kind": "profile",
        "profileKey": "glaucoma",
        "profileLabel": "Glaucoma / glaucoma suspect"
      }
    ]
  },
  {
    "orderable": "scodi-optic-nerve",
    "label": "OCT optic nerve",
    "sources": [
      {
        "kind": "profile",
        "profileKey": "glaucoma",
        "profileLabel": "Glaucoma / glaucoma suspect"
      }
    ]
  },
  {
    "orderable": "fundus-photography",
    "focus": "optic nerve",
    "label": "Optic nerve photos",
    "sources": [
      {
        "kind": "profile",
        "profileKey": "glaucoma",
        "profileLabel": "Glaucoma / glaucoma suspect"
      }
    ]
  }
]
```

### macula: stored testsProposed

```json
[
  {
    "orderable": "oct-retina",
    "label": "OCT retina",
    "unavailableReason": "No OCT retina orderable exists in ODOS yet",
    "sources": [
      {
        "kind": "profile",
        "profileKey": "macula-retina",
        "profileLabel": "Macular degeneration / retina"
      }
    ]
  },
  {
    "orderable": "fundus-photography",
    "focus": "retina",
    "label": "Retina photos",
    "sources": [
      {
        "kind": "profile",
        "profileKey": "macula-retina",
        "profileLabel": "Macular degeneration / retina"
      }
    ]
  },
  {
    "orderable": "erg",
    "label": "ERG",
    "unavailableReason": "ERG is on ODOS's pending-orderables list \u2014 plan-sets/glaucoma.ts:2",
    "sources": [
      {
        "kind": "profile",
        "profileKey": "macula-retina",
        "profileLabel": "Macular degeneration / retina"
      }
    ]
  }
]
```

Full responses and absent/empty proof are quoted below (also live-proof.json).

```json
{
  "glaucoma": {
    "status": 200,
    "body": {
      "recorded": true,
      "rows": [
        {
          "orderable": "visual-field-threshold",
          "label": "Visual field",
          "sources": [
            "from the Glaucoma / glaucoma suspect shape"
          ],
          "state": "for-review"
        },
        {
          "orderable": "scodi-optic-nerve",
          "label": "OCT optic nerve",
          "sources": [
            "from the Glaucoma / glaucoma suspect shape"
          ],
          "state": "for-review"
        },
        {
          "orderable": "fundus-photography",
          "focus": "optic nerve",
          "label": "Optic nerve photos",
          "sources": [
            "from the Glaucoma / glaucoma suspect shape"
          ],
          "state": "already-ordered",
          "actionIds": [
            "e8de3686-d57b-409b-87aa-1538375cce1c"
          ]
        }
      ]
    }
  },
  "macula": {
    "status": 200,
    "body": {
      "recorded": true,
      "rows": [
        {
          "orderable": "oct-retina",
          "label": "OCT retina",
          "sources": [
            "from the Macular degeneration / retina shape"
          ],
          "state": "unavailable",
          "reason": "No OCT retina orderable exists in ODOS yet"
        },
        {
          "orderable": "fundus-photography",
          "focus": "retina",
          "label": "Retina photos",
          "sources": [
            "from the Macular degeneration / retina shape"
          ],
          "state": "for-review"
        },
        {
          "orderable": "erg",
          "label": "ERG",
          "sources": [
            "from the Macular degeneration / retina shape"
          ],
          "state": "unavailable",
          "reason": "ERG is on ODOS's pending-orderables list \u2014 plan-sets/glaucoma.ts:2"
        }
      ]
    }
  },
  "absent": {
    "status": 200,
    "body": {
      "recorded": false
    }
  },
  "empty": {
    "status": 200,
    "body": {
      "recorded": true,
      "rows": []
    }
  }
}
```

Chrome passed both visits at 1440 and 390 widths: hidden/first/reselected request counts 0/1/2; zero row buttons, tab alerts and page errors. Screenshots were visually inspected. See browser-proof.json and screenshots/. The existing phone Photos launcher summons the panel; this slice adds no launcher. Existing narrow chart-header clipping remains outside this slice. Artifact source/served hashes: artifact-identity.json.

## G1–G14 and existing inventory guards

Command: `python3 docs/build-log/followup-s3c2a-queue-view/proof/mutations.py`. Each altered source is restored byte-for-byte before green. All outputs below are summaries, not full logs.

### R3-tab-count

`cd ui && node --import tsx --test --test-name-pattern=DXIMAGING imaging preference survives stages tests/examOverviewBoard.test.tsx`

RED (exit 1):
```text
not ok 1 - DXIMAGING imaging preference survives stages with five tabs
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - DXIMAGING imaging preference survives stages with five tabs
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### R4-surface-counts

`cd ui && node --import tsx --test --test-name-pattern=C1 panel is available off|C1 modal editor still tests/examOverviewBoard.test.tsx`

RED (exit 1):
```text
not ok 1 - C1 panel is available off the structure stage
not ok 2 - C1 modal editor still suppresses the panel
# tests 2
# pass 0
# fail 2
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - C1 panel is available off the structure stage
ok 2 - C1 modal editor still suppresses the panel
# tests 2
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### R5-route-inventory

`node --import tsx --test --test-name-pattern=every definition-backed clinical-graph HTTP closure mcp/tests/findingDefinitionStore.test.ts`

RED (exit 1):
```text
not ok 1 - every definition-backed clinical-graph HTTP closure receives the persistent dependency
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - every definition-backed clinical-graph HTTP closure receives the persistent dependency
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G1

`node --import tsx --test --test-name-pattern=S3c2a G1\b mcp/tests/followUpQueueEndpoint.test.ts`

RED (exit 1):
```text
not ok 1 - S3c2a G1 queue uses frozen labels and reasons after profile edits
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G1 queue uses frozen labels and reasons after profile edits
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G2

`node --import tsx --test --test-name-pattern=S3c2a G2\b mcp/tests/followUpQueueEndpoint.test.ts`

RED (exit 1):
```text
not ok 1 - S3c2a G2 matches orderable and focus, retaining multiple matching action ids
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G2 matches orderable and focus, retaining multiple matching action ids
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G3-state

`node --import tsx --test --test-name-pattern=S3c2a G3\b mcp/tests/followUpQueueEndpoint.test.ts`

RED (exit 1):
```text
not ok 1 - S3c2a G3 only a live order for this encounter and patient counts
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G3 only a live order for this encounter and patient counts
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G3-encounter

`node --import tsx --test --test-name-pattern=S3c2a G3\b mcp/tests/followUpQueueEndpoint.test.ts`

RED (exit 1):
```text
not ok 1 - S3c2a G3 only a live order for this encounter and patient counts
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G3 only a live order for this encounter and patient counts
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G4

`node --import tsx --test --test-name-pattern=S3c2a G4\b mcp/tests/followUpQueueEndpoint.test.ts`

RED (exit 1):
```text
not ok 1 - S3c2a G4 a real order wins over unavailable fees
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G4 a real order wins over unavailable fees
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G5

`node --import tsx --test --test-name-pattern=S3c2a G5\b mcp/tests/followUpQueueEndpoint.test.ts`

RED (exit 1):
```text
not ok 1 - S3c2a G5 availability is live and reason precedence is frozen then pending then catalogue
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G5 availability is live and reason precedence is frozen then pending then catalogue
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G6

`node --import tsx --test --test-name-pattern=S3c2a G6\b mcp/tests/followUpQueueEndpoint.test.ts`

RED (exit 1):
```text
not ok 1 - S3c2a G6 any failed order, shape or catalogue read refuses the queue
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G6 any failed order, shape or catalogue read refuses the queue
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G7

`node --import tsx --test --test-name-pattern=S3c2a G7\b mcp/tests/followUpQueueEndpoint.test.ts`

RED (exit 1):
```text
not ok 1 - S3c2a G7 absent and explicitly empty remain distinct
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G7 absent and explicitly empty remain distinct
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G8

`node --import tsx --test --test-name-pattern=S3c2a G8\b mcp/tests/followUpQueueEndpoint.test.ts`

RED (exit 1):
```text
not ok 1 - S3c2a G8 enforces authentication, chart.read and staff Encounter compartment before service reads
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G8 enforces authentication, chart.read and staff Encounter compartment before service reads
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G9

`node --import tsx --test --test-name-pattern=S3c2a G9\b mcp/tests/examOverviewEndpoint.test.ts`

RED (exit 1):
```text
not ok 1 - S3c2a G9 automatic and explicit shaping freeze all display fields
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G9 automatic and explicit shaping freeze all display fields
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G9-merge

`node --import tsx --test --test-name-pattern=S3c2a G9\b mcp/tests/examShapeRecord.test.ts`

RED (exit 1):
```text
not ok 1 - S3c2a G9 merge retains every first display field and both profile sources
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G9 merge retains every first display field and both profile sources
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G10

`node --import tsx --test --test-name-pattern=S3c2a G10\b mcp/tests/followUpQueueEndpoint.test.ts`

RED (exit 1):
```text
not ok 1 - S3c2a G10 legacy proposals load unchanged and use catalogue then key labels
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G10 legacy proposals load unchanged and use catalogue then key labels
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G11

`cd ui && node --import tsx --test --test-name-pattern=S3c2a G11\b tests/examOverviewBoard.test.tsx`

RED (exit 1):
```text
not ok 1 - S3c2a G11 real chart requests queue only when Follow-up is selected, including re-selection
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G11 real chart requests queue only when Follow-up is selected, including re-selection
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G12-empty

`cd ui && node --import tsx --test --test-name-pattern=S3c2a G12\b tests/followUpQueue.test.tsx`

RED (exit 1):
```text
not ok 1 - S3c2a G12 failure has polite status and retry, never emptiness or alert
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G12 failure has polite status and retry, never emptiness or alert
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G12-alert

`cd ui && node --import tsx --test --test-name-pattern=S3c2a G12\b tests/followUpQueue.test.tsx`

RED (exit 1):
```text
not ok 1 - S3c2a G12 failure has polite status and retry, never emptiness or alert
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G12 failure has polite status and retry, never emptiness or alert
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G13

`cd ui && node --import tsx --test --test-name-pattern=S3c2a G13\b tests/followUpQueue.test.tsx`

RED (exit 1):
```text
not ok 1 - S3c2a G13 all three states show labels, sources and reasons without row buttons
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - S3c2a G13 all three states show labels, sources and reasons without row buttons
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### G14

`cd ui && node --import tsx --test --test-name-pattern=clinical-graph requests share the literal tests/clinicalGraphRouting.test.tsx`

RED (exit 1):
```text
not ok 1 - clinical-graph requests share the literal Vite route and Medplum authorization helpers
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```
GREEN (exit 0):
```text
ok 1 - clinical-graph requests share the literal Vite route and Medplum authorization helpers
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Files touched

- `mcp/src/clinical-graph/exam-overview-endpoint.ts`
- `mcp/src/clinical-graph/exam-scope-store.ts`
- `mcp/src/clinical-graph/follow-up-queue-endpoint.ts`
- `mcp/src/index.ts`
- `mcp/tests/examOverviewEndpoint.test.ts`
- `mcp/tests/examShapeRecord.test.ts`
- `mcp/tests/findingDefinitionStore.test.ts`
- `mcp/tests/followUpQueueEndpoint.test.ts`
- `ui/src/components/charting/ExamRightPanel.tsx`
- `ui/src/components/charting/FollowUpQueue.tsx`
- `ui/src/lib/follow-up-queue.ts`
- `ui/src/scenes/EncounterCharting.tsx`
- `ui/src/styles/charting.css`
- `ui/tests/clinicalGraphRouting.test.tsx`
- `ui/tests/examOverviewBoard.test.tsx`
- `ui/tests/followUpQueue.test.tsx`
- `docs/build-log/followup-s3c2a-queue-view/` (proof, summaries, screenshots, rulings)

## Cleanup, risks and follow-ups

All odos-s3c2a-* containers and task app processes stopped; synthetic volumes retained. Final `docker ps --format '{{.Names}}  {{.Status}}'`:

```text
vf-prac1b-walk-db  Up 2 days
```

No new decisions or medical-code assertions: decisions/INDEX.md and Mandate 14 ledger need no rows. No cross-repo edits or follow-ups.
Not done: Accept; Not today; Put back; Completed; opening an order from its row; Add to this visit test search (F4); Following card; Since last visit (S5); dye-choice rendering; result-section rendering; Follow-up shortcut launcher.
Bot status and exact PR head must be checked in the handoff. Author verification is not independent evaluation; Claude Opus 5 remains required.

needs-review
