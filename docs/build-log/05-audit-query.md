# 05 — Audit Query API

The audit trail has been writing to `audit_events` since foundation. This module exposes a way to read it.

**Merged to main:** `f3fe94c`
**Tests at end:** 163/163

## What we built

Two read-only endpoints over the `audit_events` table.

1. **`GET /api/audit`** — Search with filters and pagination. Filter by:
   - `entityType` — what kind of thing (patient, appointment, etc.)
   - `entityId` — a specific record
   - `actorId` — who did it
   - `actorType` — human, local agent, or cloud agent
   - `action` — create, update, delete, access
   - `startDate` / `endDate` — time range
   - `limit` / `offset` — pagination
   
   Results sorted newest first. Returns total count for pagination UI.

2. **`GET /api/audit/entity/:entityType/:entityId`** — Full history of a single thing. Same data as the search endpoint, scoped to one entity, no pagination (entity histories are usually small).

Both endpoints scope to `practice_id` automatically. You can never see another practice's audit events even if you guess an entity ID.

## Why this design

**Read-only forever.** This module never writes to `audit_events`. The writes happen automatically through the audit middleware (for HTTP requests touching PHI) and the audit handler (for domain events). The query API is purely a way to look at what's already there.

**The append-only guarantee comes from the database, not the application.** The `audit_events` table has BEFORE UPDATE and BEFORE DELETE triggers that raise an exception. This means even if a buggy or malicious code path tried to mutate the audit log, the database would refuse. The query API doesn't need to enforce this — it physically can't be violated.

**Permission gate is `reports:read`, not a dedicated `audit:read`.** Compliance/audit access is part of the reports family. If we need finer-grained control later (e.g., a "compliance officer" role that can read audit but not other reports), we can add `audit:read` as a separate permission and update the route check.

## Key files

```
src/server/modules/audit/
├── schemas.ts                           # Search input validation
├── service.ts                           # AuditService class (read-only)
└── routes.ts                            # /api/audit/* endpoints
tests/server/modules/audit/audit.test.ts # 11 tests
```

## API endpoints

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/api/audit` | `reports:read` | Search with filters |
| GET | `/api/audit/entity/:entityType/:entityId` | `reports:read` | Full history of one entity |

## Test coverage

11 tests verifying:
- Search returns events scoped to practice (multi-tenant isolation tested with cross-practice setup)
- Filters by entity type, entity ID, actor ID, actor type, action
- Pagination respects limit and offset
- Events sorted newest first
- Entity history returns all records for one entity
- Permission check rejects users without `reports:read`
- Unauthenticated requests return 401

## Known limitations

- **No "before/after diff" view.** The `previous_state` and `new_state` JSONB columns exist on `audit_events` but the audit middleware doesn't currently populate them for HTTP requests (it would require capturing the request body and matching it to the DB row before/after). The domain event handler does populate these for events emitted through the bus, but not many parts of the app emit through the bus yet — this is something the upcoming "domain event wiring" task will improve.

- **No CSV/JSON export.** Compliance audits often want a downloadable report. Should add `?format=csv` to the search endpoint.

- **No alerting on high-risk events.** Failed login attempts, mass deletes, suspicious access patterns — all of these get written to `audit_events` but nothing notices. A future task should subscribe to the event bus and route alerts.

- **Retention is forever.** No archival or pruning. For a small practice this is fine for years; for SaaS scale you'd want to move events older than N years to cold storage.

## How to verify locally

```bash
# Run audit tests
npx vitest run tests/server/modules/audit/

# Manual: read all audit events
curl http://localhost:3000/api/audit \
  -H "Authorization: Bearer $TOKEN"

# Filter to just patient creates today
curl "http://localhost:3000/api/audit?entityType=patient&action=create&startDate=2026-04-08T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"

# Get the full history of a specific patient
curl "http://localhost:3000/api/audit/entity/patient/<patient-id>" \
  -H "Authorization: Bearer $TOKEN"
```

## Rollback plan

```bash
git revert -m 1 f3fe94c
git push origin main
```

Completely safe. Removing the query API has zero impact on the audit writes — those keep happening through the foundation middleware and event handlers.

## Common breakage and fixes

**"Audit events I expect aren't showing up"** — first check the database directly: `SELECT COUNT(*) FROM audit_events WHERE practice_id = '<id>'`. If the count is 0, the writes aren't happening (separate problem). If the count is > 0 but the API returns nothing, check the filters — date range and `entityType` in particular.

**"Search is slow"** — the foundation migration created indexes on `(entity_type, entity_id)`, `(actor_id, created_at)`, and `created_at`. If a query is slow, it's probably hitting a filter not covered by these (e.g., filtering by `actor_type` alone). Add an index in a future migration.

**"`reports:read` permission required" but user is admin** — check that the system Admin role actually has `reports:read` in its permission set. Look at `scripts/seed.ts` — the Admin role explicitly lists permissions. If you customized it and forgot to include `reports:read`, that's why.

**"Can someone tamper with audit events?"** — try it: `DELETE FROM audit_events WHERE id = '...'` in psql. You'll get an exception from the trigger: `audit_events is append-only: DELETE operations are not allowed`. Same for UPDATE. This is the strongest guarantee — even superuser DB access can't quietly modify the audit log without dropping the trigger first (which itself would be visible in `pg_trigger` and would be an extreme red flag).
