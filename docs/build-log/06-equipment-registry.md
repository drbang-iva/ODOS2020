# 06 — Equipment Registry

The two equipment tables (`equipment_registry` and `device_readings`) have been sitting in the foundation schema since day one. This module finally gives them an API.

**Merged to main:** `857d780`
**Tests at end:** 180/180

## What we built

Two related sub-modules:

### Equipment registry

The master list of every device in the practice — OCT, visual field, autorefractor, phoropter, tonometer, retinal camera, topographer, lensometer, meibographer, plus generic "specialty" and "aesthetics" categories.

Each equipment record has:
- Name, manufacturer, model, location
- Device category (one of the enums above)
- Integration type (`dicom`, `folder_watch`, `serial`, `manual`)
- `connection_config` JSONB — arbitrary config for the integration (AE title, port, watch directory, COM port, baud rate, etc.)
- `data_types` array — what kinds of data this device produces (retina, nerve, anterior, etc.)
- `parser_id` — which parser handles this device (used by the integration layer when it ships)
- `is_active` — soft delete

Full CRUD with practice-scoped isolation.

### Device readings

Captured data from those devices. Each reading has:
- `equipment_id` — which device produced it
- `patient_id` — which patient (nullable for unmatched readings)
- `matched_by` — how the patient was matched (`mwl`, `room_assignment`, `manual`, `ai_match`)
- `reading_type` — string describing what kind of reading (e.g., `oct_macula`, `oct_nerve`, `visual_field_24-2`)
- `structured_data` JSONB — the parsed reading
- `raw_data_ref` — pointer to the original file (DICOM blob, image, PDF, etc.)
- `source_type` — how it was created (`dicom`, `folder_watch`, `serial`, `manual`, `ai_extraction`)
- `confidence` — for AI extractions, how confident the model is (0.0 to 1.0)
- `needs_review` — flag for human review queue
- `reviewed_by` / `reviewed_at` — populated when a tech reviews and approves
- `captured_at` — when the device generated the reading

API:
- List with filters (patient, equipment, reading type, needs review, date range)
- Create (manual entry, parser-driven writes, AI extraction)
- Review endpoint that marks a reading as reviewed and optionally reassigns the patient or corrects the structured data

## Why this design

**Readings can come in unmatched.** This is the central design choice. Real device integrations don't always know who the patient is — a tech might forget to enter MRN on the OCT, or a folder-watcher picks up a file with no metadata. Rather than rejecting these readings, OSOD captures them with `patient_id = NULL` and `needs_review = true`. A tech then works through the review queue to assign each orphan reading to the right patient.

**Multiple matching strategies.** `matched_by` records HOW the patient was identified:
- `mwl` — DICOM Modality Worklist (the device pulled the patient from a worklist OSOD provided)
- `room_assignment` — the device was in a room assigned to a patient at capture time
- `manual` — a tech entered or corrected the assignment
- `ai_match` — an AI agent matched based on context (name on the file, date, etc.)

This metadata is critical for audit. "How did this OCT scan get attached to Jane Doe?" should always have a defensible answer.

**JSONB for structured_data.** Different device types produce wildly different data shapes. An OCT macula reading has thicknesses, an HFA visual field has indices and a probability map, a fundus photo has nothing but metadata. JSONB lets each parser write its own schema without requiring a separate table per device type. The trade-off is that querying inside the JSON is slower than relational columns — fine for now, can be optimized later.

**The service verifies equipment ownership before accepting a reading.** You can never POST a reading against equipment from another practice. Multi-tenant isolation is enforced at the service layer, not just by `practice_id` columns.

## Key files

```
src/server/modules/equipment/
├── schemas.ts                            # Equipment + reading input validation
├── service.ts                            # EquipmentService class
└── routes.ts                             # /api/equipment/* endpoints
tests/server/modules/equipment/equipment.test.ts  # 17 tests
```

## API endpoints

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/api/equipment` | `admin:settings` | List devices (filterable) |
| POST | `/api/equipment` | `admin:settings` | Register a new device |
| GET | `/api/equipment/:id` | `admin:settings` | Read |
| PATCH | `/api/equipment/:id` | `admin:settings` | Update |
| DELETE | `/api/equipment/:id` | `admin:settings` | Deactivate |
| GET | `/api/equipment/readings` | `clinical:read` | List readings (filterable) |
| GET | `/api/equipment/readings/:id` | `clinical:read` | Read one reading |
| POST | `/api/equipment/readings` | `clinical:write` | Create a reading (verifies equipment ownership) |
| POST | `/api/equipment/readings/:id/review` | `clinical:write` | Mark reviewed, reassign patient, correct data |

**Route ordering matters here.** `/readings` is registered BEFORE `/:id` so that `GET /readings` doesn't get matched as `GET /:id` with `id = "readings"`. This is a Hono routing gotcha that bit me during the build.

## Test coverage

17 tests including:
- Create equipment with all field types
- List with filters (deviceCategory, integrationType, includeInactive)
- Multi-tenant isolation (cross-practice setup verifies you can't see another practice's devices)
- Update and soft delete
- Reject invalid device category enum
- Create reading manually
- Reject creating a reading against another practice's equipment
- List readings with filters (needsReview, patientId)
- Review flow: mark reviewed, assign patient, correct data
- Permission rejection (limited user → 403)

## Known limitations

**No actual integrations yet.** The schema is ready for DICOM, folder watch, and serial integrations, but none of them are built. The `integration_type` and `connection_config` fields exist; the workers that actually connect to devices and write readings don't. This module is the data contract — the integration workers will write to `device_readings` through this service when they ship.

**No DICOM storage.** OSOD does not yet store DICOM blobs. The `raw_data_ref` field is meant to point to external storage (Orthanc, S3, local filesystem). The Docker compose has Orthanc behind a profile but it's not wired up.

**No image viewing API.** Even when DICOM is stored, there's no endpoint to fetch and render images. That comes later as part of the clinical/timeline UI.

**Reading types are free-text strings.** No enum, no validation. A typo (`oct_machula` instead of `oct_macula`) would silently create a separate "type" that doesn't match anything else. Should add a `reading_types` reference table eventually.

**No "needs review" notification.** When unmatched readings hit the queue, no one gets a ping. A staff dashboard would surface this, but doesn't exist yet.

## How to verify locally

```bash
# Run equipment tests
npx vitest run tests/server/modules/equipment/

# Manual: register an OCT
curl -X POST http://localhost:3000/api/equipment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "Main OCT",
    "manufacturer": "Zeiss",
    "model": "Cirrus 6000",
    "deviceCategory": "oct",
    "integrationType": "dicom",
    "connectionConfig": {"aeTitle": "OSOD", "port": 11112},
    "location": "Exam Room 1",
    "dataTypes": ["retina", "nerve", "anterior"]
  }'

# Create a manual reading
curl -X POST http://localhost:3000/api/equipment/readings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "equipmentId": "<oct-id>",
    "patientId": "<patient-id>",
    "matchedBy": "manual",
    "readingType": "oct_macula",
    "structuredData": {"od_thickness": 260, "os_thickness": 265},
    "sourceType": "manual",
    "capturedAt": "2026-04-08T14:30:00Z"
  }'

# View the review queue
curl "http://localhost:3000/api/equipment/readings?needsReview=true" \
  -H "Authorization: Bearer $TOKEN"
```

## Rollback plan

```bash
git revert -m 1 857d780
git push origin main
```

Safe. The tables (`equipment_registry`, `device_readings`) exist in foundation and stay after revert. Any rows that were created via the API stay too — just no API to read them.

## Common breakage and fixes

**"GET /api/equipment/readings returns 404"** — the route ordering. If you swap the order in `routes.ts` so that `/:id` is registered before `/readings`, Hono will try to match `/readings` as `/:id` with `id="readings"` and fail. Keep `/readings` routes first.

**"Reading was created but it's attached to the wrong patient"** — use the review endpoint: `POST /api/equipment/readings/:id/review` with `{ "patientId": "<correct-id>" }`. This sets the patient, marks the reading as reviewed, and updates `matched_by` to `manual`.

**"Cannot create reading for equipment that doesn't exist"** — the service explicitly verifies equipment ownership before accepting the reading. If you're getting "Equipment not found," double-check the equipment ID and that it belongs to YOUR practice (not another practice in the same database).

**"Confidence column rejects 0.95"** — Postgres `DECIMAL` accepts 0.95 but the Zod schema has `z.number().min(0).max(1)`. If you're getting a validation error, check the actual value. NaN or strings will fail.

**"Reading orphaned: equipment was deleted"** — equipment deletes are SOFT (sets `is_active = false`). The equipment row still exists. If you HARD deleted it via SQL, the foreign key constraint would have prevented it (or you used `CASCADE` and lost data). Use the soft delete API.
