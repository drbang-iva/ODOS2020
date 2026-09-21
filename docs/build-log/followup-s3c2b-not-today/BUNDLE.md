# S3c-2b sealed author bundle

Not today / Put back now persist per encounter, independently of the frozen shape.
Staff and providers with chart.write can decide; every decision records who and when.
Already ordered takes precedence; Put back alone removes a decision.
R1 separates Encounter status mapping from downstream 502 failures in GET and PUT.
UI actions and failures are scoped to each row; successful PUT supplies the replacement list.
No orders, plan actions, charges, ServiceRequests or clinical terminology were added by this feature.

Coded-by: Codex — runtime model identifier unavailable, runtime effort unavailable; recommended Sol, high effort.
NOT EVALUATED — independent evaluator: Claude Opus 5. Do not merge on author evidence.

Base: a4e7866fbe20731edb5fd27759d6e6dfffa65a0f.
Implementation/build commit: cbccc45627a405027e528068ef940e2ea9307f4b.
Branch: drbang-iva/followup-s3c2b-not-today. PR URL and final head are supplied in the PR/task handoff.

## Premises

- P1: corrected by operator R1 in companion kickoff 02da7c00. Old combined catch misclassified downstream status errors; new GET/PUT keep that mapping only for the Encounter read.
- P2: GET block and limiter at 8688–8706 verified at base; PUT inserted immediately afterward.
- P3: scope store conditional update/create and writeToken confirmation verified; separate decision store uses the same concurrency pattern plus bounded reapplication.
- P4: provider and staff hold chart.write; canonical admin has chart.read without chart.write. Live reader is a non-owner identity bound to that policy.
- P5: finished Encounter refusal precedent verified; decision endpoint uses the required ordinary conflict sentence.
- P6: practitionerNamesByReference was private; only export was added and the helper is reused.
- P7: shared error helper maps concurrent-edit/412 specially and preserves ordinary 409 wording; UI uses it.
- P8: full definition inventory inspected; 106 becomes 107, dependencies remain 50/6. UI caller-file census remains 59; routing test untouched. Named-route consumers and Observation inventories remain unchanged; full suites passed.
- P9: unshaped body remains exactly recorded:false, GET never calls service read(), prior three-state payload has no buttons. Every original test line remains an exact prefix of its extended file.

## Files and grants

| File | Before → after / permitted change |
| --- | --- |
| mcp/src/clinical-graph/follow-up-decision-store.ts | New Basic record store; conditional writes, one-key retries, three-attempt conflict |
| mcp/src/clinical-graph/follow-up-queue-endpoint.ts | Three-state GET → four-state GET and strict PUT; R1 mapping, permissions, transitions |
| mcp/src/clinical-graph/exam-overview-endpoint.ts | Only `async function practitionerNamesByReference` → `export async function practitionerNamesByReference` |
| mcp/src/index.ts | Exactly one 21-line block following the GET; dynamic import, own limiter, literal app.put registration |
| mcp/tests/followUpDecisionStore.test.ts | New 5 tests |
| mcp/tests/followUpQueueEndpoint.test.ts | Original 10 tests unchanged; 10 tests appended |
| mcp/tests/findingDefinitionStore.test.ts | Only 106 → 107 and the one permitted explanatory comment; 50/6 unchanged |
| ui/src/components/charting/FollowUpQueue.tsx | Permission-aware buttons, who/when, per-row saving/errors, returned queue replacement |
| ui/src/lib/follow-up-queue.ts | Existing client file gains PUT and validator; missing canDecide defaults false |
| ui/src/styles/charting.css | Four queue-specific style rules appended |
| ui/tests/followUpQueue.test.tsx | Original 5 tests unchanged; 5 tests appended |
| docs/build-log/followup-s3c2b-not-today/ | Proof scripts, summaries, mutation evidence, live responses and screenshots |

All restricted changes were mechanically compared with base. No scripts, fixtures, shape/profile stores, board, panel tabs, registry, deployment, policy or workflow files were edited.

## Suites and checks

- base-ui: tests 1834, pass 1834, fail 0, cancelled 0, skipped 0
- base-mcp-complete: tests 6222, pass 6168, fail 0, cancelled 0, skipped 54
- head-ui: tests 1839, pass 1839, fail 0, cancelled 0, skipped 0
- head-mcp: tests 6237, pass 6183, fail 0, cancelled 0, skipped 54

UI: 1834 base + 5 added = 1839; command `npm --prefix ui test`.
MCP: 6222 base + 15 added = 6237; 6183 passed and 54 skipped. The skipped live lanes are not claimed as authorization proof.
MCP command from mcp/, exactly the CI file inventory:

```sh
node --import tsx --test --test-concurrency=1 'src/__tests__/**/*.test.ts' 'tests/**/*.test.ts' '../tests/boundaries/**/*.test.ts' '../tests/observation-status-machine/**/*.test.ts' '../tests/setup-wizard/**/*.test.ts' '../tests/preflight/**/*.test.ts' '../tests/smart/**/*.test.ts' '../tests/cds/**/*.test.ts' '../tests/agentops/**/*.test.ts' '../tests/bulk-data/**/*.test.ts' '../tests/mandate-8/**/*.test.ts'
```

Every MCP run sets ODOS_POSTGRES_URL to dedicated odos-s3c2b-postgres on localhost:32781. Full runs also set ODOS_REAL_WEASYPRINT_TEST=1 and WEASYPRINT_BIN to verified disposable WeasyPrint 69.0. Native Node 22.22.3 expands the quoted globs. Suite summaries only are retained.

Base and restored candidate: `npx tsc --noEmit`, `npx tsc --noEmit -p mcp/tsconfig.json`, `npx tsc --noEmit -p ui/tsconfig.json` — exit 0, no diagnostics. `npm run preflight` — 0 warnings, 0 hard blocks. Clean MCP/UI production build succeeded; Vite reported its existing bundle-size advisory.

## Guards: broken → red → restored → green

Each command below runs from its indicated package directory with the dedicated PostgreSQL environment. Source is restored in finally before the green run. The JSON contains assertion excerpts as well as these summaries.

### G1 — mcp/src/clinical-graph/follow-up-queue-endpoint.ts

`node --import tsx --test --test-name-pattern=S3c2b G1 T4 tests/followUpQueueEndpoint.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - S3c2b G1 T4 Not today survives reload, profile edit, second problem and explicit repick until Put back
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G2 — mcp/src/clinical-graph/follow-up-decision-store.ts

`node --import tsx --test --test-name-pattern=S3c2b G2 tests/followUpDecisionStore.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - S3c2b G2 decision identity includes focus and Put back deletes only its key
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G3 — mcp/src/clinical-graph/follow-up-queue-endpoint.ts

`node --import tsx --test --test-name-pattern=S3c2b G3 tests/followUpQueueEndpoint.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - S3c2b G3 orders beat decisions; decisions beat deactivated fees; Put back exposes Unavailable
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G4 — mcp/src/clinical-graph/follow-up-queue-endpoint.ts

`node --import tsx --test --test-name-pattern=S3c2b G4 tests/followUpQueueEndpoint.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - S3c2b G4 invalid transitions refuse; repeated decisions and inapplicable Put back never write
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G5 — mcp/src/clinical-graph/follow-up-decision-store.ts

`node --import tsx --test --test-name-pattern=S3c2b G5 tests/followUpDecisionStore.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - S3c2b G5 stale If-Match is refused then fresh reapply preserves both people
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G6 — mcp/src/clinical-graph/follow-up-decision-store.ts

`node --import tsx --test --test-name-pattern=S3c2b G6 tests/followUpQueueEndpoint.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - S3c2b G6 exhausted conflicts map to concurrent-edit after exactly three attempts
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G7 — mcp/src/clinical-graph/follow-up-decision-store.ts

`node --import tsx --test --test-name-pattern=S3c2b G7 tests/followUpDecisionStore.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - S3c2b G7 conditional create loser confirms token and preserves first writer
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G8 — mcp/src/clinical-graph/follow-up-queue-endpoint.ts

`node --import tsx --test --test-name-pattern=S3c2b G8 tests/followUpQueueEndpoint.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - S3c2b G8 chart.write grants staff and provider and exposes canDecide only for shaped visits
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G9 — mcp/src/clinical-graph/follow-up-queue-endpoint.ts

`node --import tsx --test --test-name-pattern=S3c2b G9 tests/followUpQueueEndpoint.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - S3c2b G9 signed Encounter refuses with ordinary conflict and no write
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G10 — mcp/src/clinical-graph/follow-up-queue-endpoint.ts

`node --import tsx --test --test-name-pattern=S3c2b G10 tests/followUpQueueEndpoint.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - S3c2b G10 Encounter compartment read precedes all service work in both handlers
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G11-empty — mcp/src/clinical-graph/follow-up-queue-endpoint.ts

`node --import tsx --test --test-name-pattern=S3c2b G11 tests/followUpQueueEndpoint.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - S3c2b G11 all downstream failures including HTTP statuses return 502 and no write
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G11-mapping — mcp/src/clinical-graph/follow-up-queue-endpoint.ts

`node --import tsx --test --test-name-pattern=S3c2b G11 tests/followUpQueueEndpoint.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - S3c2b G11 all downstream failures including HTTP statuses return 502 and no write
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G12 — ui/src/components/charting/FollowUpQueue.tsx

`node --import tsx --test --test-name-pattern=S3c2b G12 tests/followUpQueue.test.tsx` (cwd `ui`)

RED exit 1:

```text
not ok 1 - S3c2b G12 buttons follow state and permission without Accept
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G13-alert — ui/src/components/charting/FollowUpQueue.tsx

`node --import tsx --test --test-name-pattern=S3c2b G13 tests/followUpQueue.test.tsx` (cwd `ui`)

RED exit 1:

```text
not ok 1 - S3c2b G13 failure is scoped, polite, exact and re-enables the row
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G13-message — ui/src/components/charting/FollowUpQueue.tsx

`node --import tsx --test --test-name-pattern=S3c2b G13 tests/followUpQueue.test.tsx` (cwd `ui`)

RED exit 1:

```text
not ok 1 - S3c2b G13 failure is scoped, polite, exact and re-enables the row
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G14 — ui/src/components/charting/FollowUpQueue.tsx

`node --import tsx --test --test-name-pattern=S3c2b G14 tests/followUpQueue.test.tsx` (cwd `ui`)

RED exit 1:

```text
not ok 1 - S3c2b G14 successful PUT replaces the complete list with no GET
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G15 — ui/src/components/charting/FollowUpQueue.tsx

`node --import tsx --test --test-name-pattern=S3c2b G15 tests/followUpQueue.test.tsx` (cwd `ui`)

RED exit 1:

```text
not ok 1 - S3c2b G15 who and machine-readable when are shown even without permission
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

### G16 — mcp/src/index.ts

`node --import tsx --test --test-name-pattern=every definition-backed clinical-graph HTTP closure tests/findingDefinitionStore.test.ts` (cwd `mcp`)

RED exit 1:

```text
not ok 1 - every definition-backed clinical-graph HTTP closure receives the persistent dependency
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
```

GREEN exit 0:

```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
```

## Real synthetic proof

Proof 1–3: live-proof.json quotes the staff PUT, decision JSON, reload, profile edit, explicit re-pick, non-owner read-only GET/403, signed 409, and provider Put back. The feature writes only its Basic decision record. Fixture setup uses existing scope/profile/diagnosis mechanisms; it does not create an order or charge.

```json
{
  "syntheticOnly": true,
  "project": "odos-s3c2b-proof",
  "decisionRecord": {
    "decisions": {
      "fundus-photography|optic nerve": {
        "decision": "not-today",
        "by": {
          "reference": "Practitioner/1a0cecb4-f064-42b3-af90-1d5e05161b8c",
          "display": "R10 Synthetic staff"
        },
        "at": "2026-09-21T11:01:52.579Z"
      }
    },
    "writeToken": "944aadc0-4245-487c-8529-e1d566fd82dd"
  },
  "finalDecisionRecord": {
    "decisions": {},
    "writeToken": "08b1f653-e43f-4fbf-be69-4ae78a2b4f45"
  },
  "responses": {
    "initialPick": {
      "status": 200,
      "body": {
        "profilesApplied": [
          {
            "profileKey": "glaucoma",
            "version": 2,
            "versionId": "f6550711-9c8d-4fda-a771-cfbdd102d230"
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
            "label": "Visual field edited",
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
            "label": "OCT optic nerve edited",
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
        ],
        "shapedAt": "2026-09-21T11:01:52.404Z",
        "source": "explicit",
        "chosenBy": {
          "reference": "Practitioner/42b968d4-c4b2-4dad-83db-1b1b609131b0",
          "display": "R10 Synthetic provider"
        },
        "chosenAt": "2026-09-21T11:01:52.404Z",
        "examScope": "office-visit",
        "versionId": "5f1a41cd-02a9-4cf2-a44e-5cad25722d16",
        "setBy": {
          "reference": "Practitioner/42b968d4-c4b2-4dad-83db-1b1b609131b0",
          "display": "R10 Synthetic provider"
        },
        "setAt": "2026-09-21T11:01:52.404Z",
        "canWrite": true
      }
    },
    "before": {
      "status": 200,
      "body": {
        "recorded": true,
        "rows": [
          {
            "orderable": "visual-field-threshold",
            "label": "Visual field edited",
            "sources": [
              "from the Glaucoma / glaucoma suspect shape"
            ],
            "state": "for-review"
          },
          {
            "orderable": "scodi-optic-nerve",
            "label": "OCT optic nerve edited",
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
            "state": "for-review"
          }
        ],
        "canDecide": true
      }
    },
    "staffNotToday": {
      "status": 200,
      "body": {
        "recorded": true,
        "rows": [
          {
            "orderable": "visual-field-threshold",
            "label": "Visual field edited",
            "sources": [
              "from the Glaucoma / glaucoma suspect shape"
            ],
            "state": "for-review"
          },
          {
            "orderable": "scodi-optic-nerve",
            "label": "OCT optic nerve edited",
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
            "state": "not-today",
            "decidedBy": "R10 Synthetic staff",
            "decidedAt": "2026-09-21T11:01:52.579Z"
          }
        ],
        "canDecide": true
      }
    },
    "reload": {
      "status": 200,
      "body": {
        "recorded": true,
        "rows": [
          {
            "orderable": "visual-field-threshold",
            "label": "Visual field edited",
            "sources": [
              "from the Glaucoma / glaucoma suspect shape"
            ],
            "state": "for-review"
          },
          {
            "orderable": "scodi-optic-nerve",
            "label": "OCT optic nerve edited",
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
            "state": "not-today",
            "decidedBy": "R10 Synthetic staff",
            "decidedAt": "2026-09-21T11:01:52.579Z"
          }
        ],
        "canDecide": true
      }
    },
    "profileEdited": {
      "status": 200,
      "body": {
        "recorded": true,
        "rows": [
          {
            "orderable": "visual-field-threshold",
            "label": "Visual field edited",
            "sources": [
              "from the Glaucoma / glaucoma suspect shape"
            ],
            "state": "for-review"
          },
          {
            "orderable": "scodi-optic-nerve",
            "label": "OCT optic nerve edited",
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
            "state": "not-today",
            "decidedBy": "R10 Synthetic staff",
            "decidedAt": "2026-09-21T11:01:52.579Z"
          }
        ],
        "canDecide": true
      }
    },
    "repick": {
      "status": 200,
      "body": {
        "profilesApplied": [
          {
            "profileKey": "glaucoma",
            "version": 3,
            "versionId": "626f39df-418b-4507-892f-60b1a89d3e2f"
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
            "label": "Visual field edited edited",
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
            "label": "OCT optic nerve edited edited",
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
        ],
        "shapedAt": "2026-09-21T11:01:52.861Z",
        "source": "explicit",
        "chosenBy": {
          "reference": "Practitioner/42b968d4-c4b2-4dad-83db-1b1b609131b0",
          "display": "R10 Synthetic provider"
        },
        "chosenAt": "2026-09-21T11:01:52.861Z",
        "examScope": "office-visit",
        "versionId": "e87a2a9c-b209-422c-a61c-82aa747d5ce6",
        "setBy": {
          "reference": "Practitioner/42b968d4-c4b2-4dad-83db-1b1b609131b0",
          "display": "R10 Synthetic provider"
        },
        "setAt": "2026-09-21T11:01:52.862Z",
        "canWrite": true
      }
    },
    "afterRepick": {
      "status": 200,
      "body": {
        "recorded": true,
        "rows": [
          {
            "orderable": "visual-field-threshold",
            "label": "Visual field edited edited",
            "sources": [
              "from the Glaucoma / glaucoma suspect shape"
            ],
            "state": "for-review"
          },
          {
            "orderable": "scodi-optic-nerve",
            "label": "OCT optic nerve edited edited",
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
            "state": "not-today",
            "decidedBy": "R10 Synthetic staff",
            "decidedAt": "2026-09-21T11:01:52.579Z"
          }
        ],
        "canDecide": true
      }
    },
    "readOnlyGet": {
      "status": 200,
      "body": {
        "recorded": true,
        "rows": [
          {
            "orderable": "visual-field-threshold",
            "label": "Visual field edited edited",
            "sources": [
              "from the Glaucoma / glaucoma suspect shape"
            ],
            "state": "for-review"
          },
          {
            "orderable": "scodi-optic-nerve",
            "label": "OCT optic nerve edited edited",
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
            "state": "not-today",
            "decidedBy": "R10 Synthetic staff",
            "decidedAt": "2026-09-21T11:01:52.579Z"
          }
        ],
        "canDecide": false
      }
    },
    "readOnlyPut": {
      "status": 403,
      "body": {
        "error": "chart.write role required"
      }
    },
    "signedPut": {
      "status": 409,
      "body": {
        "error": "Signed encounter cannot be edited."
      }
    },
    "providerPutBack": {
      "status": 200,
      "body": {
        "recorded": true,
        "rows": [
          {
            "orderable": "visual-field-threshold",
            "label": "Visual field edited edited",
            "sources": [
              "from the Glaucoma / glaucoma suspect shape"
            ],
            "state": "for-review"
          },
          {
            "orderable": "scodi-optic-nerve",
            "label": "OCT optic nerve edited edited",
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
            "state": "for-review"
          }
        ],
        "canDecide": true
      }
    }
  }
}
```

Proof 4: actual served clinic route in Chrome, synthetic staff identity, desktop and mobile; no component substitute. Preview images show For review and Not today with actor/time and Put back.

```json
{
  "syntheticOnly": true,
  "results": [
    {
      "width": 1440,
      "role": "staff",
      "whoWhen": "R10 Synthetic staff · 07:02 AM",
      "puts": 2,
      "extraGets": 0,
      "pageErrors": []
    },
    {
      "width": 390,
      "role": "staff",
      "whoWhen": "R10 Synthetic staff · 07:02 AM",
      "puts": 2,
      "extraGets": 0,
      "pageErrors": []
    }
  ]
}
```

## Limits and follow-ups

- Accept and orders/charges, Completed (2c): not done.
- Free-text Not today reason: not done.
- Exam board, right-panel tabs and shape record changes: not done.
- Seeded-reason wording cleanup: not done.
- Mandate 14: no new medical code, orderable, clinical interval or external FHIR URL; no ledger rows required or added.
- Decisions index: no new product decision authored; R1 already recorded by the operator in performance-od at 02da7c00. Cross-repo follow-up: independent Claude Opus 5 evaluation at final PR head.
- #647 remained open at recheck; no rebase needed. Its index changes are above this insertion.
- No outside-allowlist edit required. A concurrent preflight run saw the full suite's temporary RiskAssessment probe; the probe was removed by its existing test, then preflight passed separately. No guard or policy changed.
- Proof setup correction: bootstrap owner was unsuitable as read-only caller; created a distinct non-owner canonical Admin-policy reader. Throttled login attempts were retried after the server window, without changing production limits.
- NOT EVALUATED. Author tests, mutations, browser proof and bots are not independent acceptance.

## Final containers

```text
NAMES               STATUS
vf-prac1b-walk-db   Up 2 days
```

needs-review

## FIXBACK-1 — non-conflict write failures

Requested after the operator reported code PASS with one test gap at base `a3082799dbe327612e59d3fd7cf285421ad028e1`. This fixback appends exactly five tests and this bundle section. No production source change; all original test bytes are preserved. No `mcp/src/index.ts` change. Branch: `drbang-iva/followup-s3c2b-not-today`; PR #651; do not merge.

### Added guards

- F1: existing decision `update` throws the exact `{ status: 500 }` object; `apply` rejects with that object after one write attempt and the stored resource is unchanged.
- F2: initial `create` throws `{ status: 500 }`; exact rejection, one attempt, no record.
- F3: existing `update` throws `{ status: 403 }`; exact rejection, one attempt, stored resource unchanged.
- F4: PUT decision `create` throws `{ status: 500 }`; 502 with exactly `The tests for this visit could not be loaded.`, no `code`, one write attempt, successful Encounter read and unchanged storage.
- F5: same PUT write failure with `{ status: 403 }`; 502 with the same exact load-failure body, no compartment error or conflict code, one attempt and unchanged storage.

The first unchanged-source run of both files passed: `tests 30; pass 30; fail 0; skipped 0` (the existing 25 plus F1–F5). No existing assertion was changed and no unexpected failure occurred.

### Mandate 17 — deliberate break and restore

Every MCP invocation below used `ODOS_POSTGRES_URL` against the task-owned `odos-s3c2b-postgres` PostgreSQL 16 container, mapped to loopback port 32782. No use of `vf-prac1b-walk-db`.

From `mcp/`, focused command:

```sh
ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:32782/medplum \
  node --import tsx --test --test-name-pattern='S3c2b F[1-5] ' \
  tests/followUpDecisionStore.test.ts tests/followUpQueueEndpoint.test.ts
```

D4 temporarily replaced `if (status !== 409 && status !== 412) throw error;` with `void error;` in the store. Red, exit 1:

```text
not ok 1 - S3c2b F1 update 500 rejects once without changing the stored record
not ok 2 - S3c2b F2 create 500 rejects once without creating a record
not ok 3 - S3c2b F3 update 403 rejects once without changing the stored record
not ok 4 - S3c2b F4 PUT decision write 500 returns load failure after one attempt
not ok 5 - S3c2b F5 PUT decision write 403 returns load failure after one attempt
# tests 5
# pass 0
# fail 5
# skipped 0
```

F1–F3 caught `Error: The follow-up decisions changed concurrently. Reload and retry.` instead of the injected error object. F4–F5 reported `actual: 409; expected: 502`. Byte-for-byte source restoration, same command, exit 0:

```text
# tests 5
# pass 5
# fail 0
# skipped 0
```

Separately inserted a status-403 return only in the PUT's final store-error catch, ahead of its concurrent-edit mapping:

```ts
if ((error as { status?: number })?.status === 403) return { status: 403, body: { error: "Encounter is outside the caller's patient compartment." } };
```

Ran the same two-file command with `--test-name-pattern='S3c2b F5 '`. Red, exit 1:

```text
not ok 2 - S3c2b F5 PUT decision write 403 returns load failure after one attempt
expected: 502
actual: 403
# tests 2
# pass 1
# fail 1
# skipped 0
```

The extra passing entry is Node's file-level entry for the store test file with no matching test names, not another F case. Byte-for-byte endpoint restoration, same command, exit 0:

```text
# tests 2
# pass 2
# fail 0
# skipped 0
```

Production source diff after both restorations: empty.

### Full verification — base plus addition

Both base and post-addition MCP runs mirror `.github/workflows/ci.yml`'s MCP step, including `ODOS_REAL_WEASYPRINT_TEST=1`, WeasyPrint 69.0, dedicated PostgreSQL, and serial test execution. The local WeasyPrint executable was selected with `WEASYPRINT_BIN`. Full command from `mcp/`:

```sh
ODOS_REAL_WEASYPRINT_TEST=1 \
ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:32782/medplum \
node --import tsx --test --test-concurrency=1 \
  'src/__tests__/**/*.test.ts' 'tests/**/*.test.ts' \
  '../tests/boundaries/**/*.test.ts' '../tests/observation-status-machine/**/*.test.ts' \
  '../tests/setup-wizard/**/*.test.ts' '../tests/preflight/**/*.test.ts' \
  '../tests/smart/**/*.test.ts' '../tests/cds/**/*.test.ts' \
  '../tests/agentops/**/*.test.ts' '../tests/bulk-data/**/*.test.ts' \
  '../tests/mandate-8/**/*.test.ts'
```

| Suite | Base a3082799 | Added | Fixback result |
|---|---|---|---|
| Full MCP | 6237 tests, 6183 pass, 54 skip, 0 fail | 5 tests/pass | 6242 tests, 6188 pass, 54 skip, 0 fail |
| Full UI (`npm test` from `ui/`) | 1839 tests/pass, 0 skip, 0 fail | 0 | 1839 tests/pass, 0 skip, 0 fail |

All four suite processes exited 0. The 54 MCP skips remain explicit live-lane skips; this full MCP step is not a new credentialed live-authorization proof. This fixback changes only tests, and does not claim a new browser or policy proof.

Typechecks, each exit 0: `npx tsc --noEmit`; `npx tsc --noEmit -p mcp/tsconfig.json`; `npx tsc --noEmit -p ui/tsconfig.json`; `npm run typecheck:scripts`.

`npm run preflight` exited 0 after the MCP suite finished:

```text
FHIR read grant check: PASS (48 literal/marked resourceTypes under mcp/src + ui/src)
FHIR operation grant coverage: PASS (943 read/write operations)
ODOS preflight complete: 0 warning(s), 0 hard block(s).
```

`git diff --check`: exit 0. Byte-prefix comparison to `git show a3082799:<test-path>` confirms both original files are intact and additions are append-only. Exactly three changed files:

```text
mcp/tests/followUpDecisionStore.test.ts
mcp/tests/followUpQueueEndpoint.test.ts
docs/build-log/followup-s3c2b-not-today/BUNDLE.md
```

### Cleanup and handoff

`docker stop odos-s3c2b-postgres` completed. Final `docker ps`:

```text
NAMES               STATUS      PORTS
vf-prac1b-walk-db   Up 2 days   127.0.0.1:55481->5432/tcp
```

No new decision or Mandate 14 artifact; no decisions index or ledger change required. Keep the existing Coded-by declaration. The operator-reported evaluation belongs to base a3082799; the new head needs independent Fable/Opus evaluation before merge. No merge authorized or performed.

needs-review
