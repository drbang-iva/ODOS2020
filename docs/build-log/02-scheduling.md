# 02 — Scheduling

The scheduling module turns the foundation tables (`appointments`, `appointment_types`, `provider_schedules`, `schedule_overrides`) into a working API for booking and managing visits.

**Merged to main:** `0681e8a`
**Tests at end:** 80/80
**Commits:** 4 (deps, schemas, service+tests, routes+wiring)

## What we built

The pieces:

1. **Availability engine.** Given a provider, a date, and an appointment type, returns every open time slot. Considers the provider's recurring weekly schedule, any one-off overrides for that date (vacation, half day), and any existing appointments that would conflict.

2. **Appointment CRUD.** Create, read, update, void. Voiding requires a reason and is recorded — voided appointments stay in the database for the audit trail but are excluded from availability calculations.

3. **Status lifecycle.** An appointment moves through: `scheduled → confirmed → checked_in → in_progress → completed`. Or it can branch off to `cancelled` or `no_show` from earlier states. The service enforces valid transitions — you can't skip from `scheduled` straight to `completed`.

4. **Conflict detection.** When you create or reschedule an appointment, the service checks that the proposed time window doesn't overlap any existing non-cancelled appointment for that provider. Returns HTTP 409 on conflict.

5. **Schedule grid endpoint.** Given a provider and date, returns every time block in the day along with whatever appointment (if any) is in that block. This is the data the future frontend will use to render the day view.

## Why this design

**Time slots are computed on read, not stored.** We don't have a "slots" table that pre-generates every possible appointment time. Instead, the availability engine takes the provider's working hours, divides them by the practice's `schedule_block_minutes`, and removes blocks that overlap existing appointments. This is simpler, smaller, and easier to reason about. The performance trade-off is minimal because we're operating on a single day at a time.

**Status transitions are encoded in the service, not the database.** A static map (`STATUS_TRANSITIONS`) defines which transitions are legal. This is easier to read and modify than CHECK constraints, and the database still has a CHECK constraint on the column to prevent garbage values.

**The booking flow is two API calls, not one.** First the client calls `GET /api/schedule/slots` to see what's available, then `POST /api/schedule/appointments` to book one. This separates "what could I book" from "actually book it" cleanly.

## Key files

```
src/server/modules/schedule/
├── schemas.ts                           # Zod input validation
├── service.ts                           # ScheduleService class (the brain)
└── routes.ts                            # /api/schedule/* endpoints
tests/server/modules/schedule/
├── schedule.service.test.ts             # 19 service tests
└── schedule.routes.test.ts              # 9 route tests
```

## API endpoints

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/api/schedule/slots` | (any auth) | Find open slots for a provider+date+type |
| GET | `/api/schedule/grid` | (any auth) | Day grid with all blocks + their appointments |
| POST | `/api/schedule/appointments` | `appointments:write` | Book (409 on conflict) |
| GET | `/api/schedule/appointments/:id` | (any auth) | Read |
| PATCH | `/api/schedule/appointments/:id` | `appointments:write` | Reschedule/update |
| POST | `/api/schedule/appointments/:id/cancel` | `appointments:write` | Cancel with reason |
| POST | `/api/schedule/appointments/:id/status` | `appointments:write` | Status transition |

## Test coverage

19 service tests:
- Availability returns correct slot count for an open day
- Longer appointment types produce fewer slots
- Existing appointments remove conflicting slots
- Blocked override returns no slots
- Modified override hours are honored
- Sunday returns no slots (provider isn't scheduled)
- Create appointment with valid fields
- Reject double-booking
- Allow adjacent appointments
- Cancel with reason, free the slot
- Reject cancelling already-cancelled
- Status chain: scheduled → confirmed → checked_in → in_progress → completed
- Reject invalid transitions
- Allow no_show from scheduled
- Reschedule to new time
- Reject rescheduling to conflict
- Reject updating cancelled appointment
- Schedule grid maps appointments to time blocks correctly

9 route tests cover the full HTTP layer including auth and error responses.

## Known limitations

**The big one: provider schedule times are treated as UTC.** The `practice.timezone` column exists but is not yet used for slot generation. So if you set a provider to work `08:00 - 12:00`, the system books slots starting at 08:00 UTC, not 08:00 in the practice's local time. **This is documented in the service file with a comment** and is a deliberate Phase 2.5 deferral. Tests use explicit UTC to avoid the issue.

To fix when ready: use `date-fns-tz` to convert wall-clock times in the practice timezone to UTC before generating slots, and convert back for display. Already installed, just not used yet.

**No equipment/room conflict detection.** If a scleral fitting needs the OCT and only one OCT exists, the scheduler will let you double-book it. The data model supports this (equipment registry exists, appointment types have `equipment_tags`), but the conflict check only looks at provider, not resources.

**No GHL/Google Calendar sync.** OSOD is the source of truth for the schedule. External calendar sync is a later phase.

**No appointment reminders.** No SMS or email reminders go out. The data is there to drive them when notifications are added.

**No series booking.** A 3-session IPL package is 3 separate appointment creates, not one series booking. The data model supports `series_enabled` and `series_count` on appointment types, but the booking flow doesn't use them yet.

## How to verify locally

```bash
# Run scheduling tests
npx vitest run tests/server/modules/schedule/

# Manual test (after seeding):
# 1. Login as Eric
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{
    "email":"eric@iva.com",
    "password":"admin123!",
    "practiceId":"<practice-id-from-seed>"
  }' | jq -r .accessToken)

# 2. Find Eric's user ID and a comprehensive exam type ID from the seed output
# 3. Get available slots for next Monday
curl "http://localhost:3000/api/schedule/slots?providerId=<eric-id>&date=2026-04-13&appointmentTypeId=<comp-exam-id>" \
  -H "Authorization: Bearer $TOKEN"
```

## Rollback plan

```bash
# If scheduling broke something on main:
git revert -m 1 0681e8a       # revert the merge commit
git push origin main
```

This is safe because nothing else depends on the scheduling module's specific code. The tables it uses (`appointments`, `provider_schedules`, etc.) were created in the foundation migration and would still exist.

## Common breakage and fixes

**"Time slot conflicts with existing appointment" but I don't see one** — usually means there's a cancelled appointment that didn't get filtered out. Check the actual database: `SELECT * FROM appointments WHERE provider_id = '...' AND start_time::date = '2026-04-08'`. The service excludes status='cancelled' from conflict checks, so if you see a conflict but the only appointment in that window is cancelled, that's a bug.

**"Sunday returns slots" or "wrong day of week"** — almost certainly a timezone issue. The service uses `new Date(date + 'T12:00:00Z').getUTCDay()` which is timezone-stable. If you changed this, put it back.

**"Status transition failed: cannot transition from X to Y"** — the lifecycle is strict. Check `STATUS_TRANSITIONS` in `service.ts`. If you need a new transition, add it there explicitly. Don't bypass with raw SQL — it skips the audit trail.

**"Slot times look wrong by several hours"** — the timezone-as-UTC issue. Slot times are returned as ISO strings in UTC. Frontend needs to convert to practice local time for display until Phase 2.5 ships.
