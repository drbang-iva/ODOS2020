# 04 — Practice Admin (Practice + Catalog modules)

This is the unlock that turns OSOD from "you need a DBA" into "you can spin up a practice through the API." Two modules: `practice` (settings, service lines, users, roles) and `catalog` (treatment library, body areas, appointment types).

**Merged to main:** `72eaad5`
**Tests at end:** 152/152

## What we built

### Practice module (`/api/practice`)

1. **Practice settings.** GET and PATCH the practice's name, schedule block size (10/15/20/30 min), timezone, and arbitrary `settings` JSONB blob.

2. **Service lines CRUD.** Add/remove/rename/recolor service lines. Soft delete (deactivation). Sort order respected.

3. **User admin.** List users (excludes inactive by default), get one user, update user fields (name, email, isActive, isProvider, serviceLineIds). Excludes `password_hash` from all responses.

4. **Role assignments.** List a user's roles, assign a role (with optional service line scope), remove an assignment. The unique constraint from Schema V2 prevents duplicate assignments.

5. **Roles CRUD.** List all roles for the practice (system + custom). Create custom roles with arbitrary permission sets. Update or delete custom roles. **System roles are protected** — the service rejects modify/delete attempts on `is_system = true` rows.

### Catalog module (`/api/catalog`)

1. **Treatment library.** GET (filterable by category and service line), GET one, POST (create new entry), PATCH, DELETE. The library is shared across all practices — when OSOD ships an update, all practices get the new treatments.

2. **Body area modifiers.** GET returns both system-shipped modifiers (where `practice_id IS NULL`) and the practice's own custom modifiers. Practices can create custom modifiers but can't modify or delete system ones.

3. **Appointment types.** Full CRUD plus the killer feature: **clone from library**. `POST /api/catalog/appointment-types/from-library` takes a library item ID, a service line, and optionally a custom display name, and creates a practice-local appointment type linked to the library entry. CPT codes, equipment tags, and provider scope are inherited from the library item but can be overridden.

## Why this design

**The clone-from-library pattern is the heart of it.** A practice doesn't have to type out every CPT code and equipment requirement for every service they offer. They browse the library, pick the services they actually do, and clone them into their own catalog. Each clone can have a custom display name (Diamond HydroFacial, Morpheus8, OptiLight IPL) without losing the link back to the standard library entry. Reports and analytics can group by library entry; the schedule and patient-facing UI can show the practice's branded names.

**System role protection prevents foot-shooting.** The 7 system roles are deliberately conservative defaults. If a practice needs different permissions, they create a custom role rather than modifying the shipped ones. This means OSOD can ship role updates over time without overwriting practice customizations.

**Body area modifiers are extensible per practice.** The system ships ~21 standard areas (Face, Neck, Hands, Forehead, Glabella, etc.) but practices doing specialty work might need their own ("Patellar tendon" for sports vision laser? "Vermilion border" for lip filler?). Same pattern as treatment library: system rows are read-only, practice rows are editable.

## Key files

```
src/server/modules/practice/
├── schemas.ts                           # Settings, service lines, users, roles input validation
├── service.ts                           # PracticeService (all sub-services in one file)
└── routes.ts                            # /api/practice/* endpoints
src/server/modules/catalog/
├── schemas.ts                           # Library, body area, appointment type input validation
├── service.ts                           # CatalogService
└── routes.ts                            # /api/catalog/* endpoints
tests/server/modules/practice/practice.test.ts   # 18 tests
tests/server/modules/catalog/catalog.test.ts     # 15 tests
```

## API endpoints (the highlights)

**Practice:**
- `GET/PATCH /api/practice` — settings
- `GET/POST /api/practice/service-lines` and CRUD
- `GET /api/practice/users` (excludes password_hash)
- `PATCH /api/practice/users/:id`
- `GET/POST/DELETE /api/practice/users/:id/roles`
- `GET/POST/PATCH/DELETE /api/practice/roles`

**Catalog:**
- `GET /api/catalog/library?category=&serviceLine=`
- `POST /api/catalog/library` (creates new library entry — usually OSOD-shipped, but practices can extend)
- `GET /api/catalog/body-areas` (system + practice combined)
- `POST /api/catalog/body-areas` (practice-only)
- `GET /api/catalog/appointment-types`
- `POST /api/catalog/appointment-types` — fully custom create
- `POST /api/catalog/appointment-types/from-library` — clone with overrides

## Permission model

All practice and catalog routes are gated on `admin:settings` or `admin:users`. No `patients:read` permission allowed in this area — these are admin functions only.

## Test coverage

18 practice tests + 15 catalog tests = 33 new tests. Highlights:
- System role modify/delete is rejected
- System body area modify is rejected
- Hannah-style multi-role assignment works
- Default fee schedule unset when a new default is set
- Library filtering by category and service line
- Clone from library inherits CPT codes
- Display name override works (creates "Diamond HydroFacial" linked to "HydraFacial" library entry)
- Multi-tenant isolation (practice A cannot see practice B's roles or appointment types)

## Known limitations

- **No bulk import for library entries.** Adding 270 treatments to the library means 270 POST requests. A bulk import endpoint would be a small follow-up.

- **No "see what changed" for system updates.** When OSOD ships an updated library entry (e.g., new CPT codes), there's no diff view for practices to review what changed.

- **Permission set is free-text.** A custom role can declare any permission strings it wants, even ones that don't exist in the application. The API doesn't validate against a known list. This is intentional flexibility but means typos won't be caught (e.g., `pateints:read` instead of `patients:read`).

- **No "preview as user" feature.** Admins can't see what the app looks like with another user's permissions. Useful for debugging "Hannah says she can't see X."

- **No CSV export of users or roles.** Audit/compliance reviews would benefit from this.

## How to verify locally

```bash
# Run admin tests
npx vitest run tests/server/modules/practice/ tests/server/modules/catalog/

# Manual test: list all roles
curl http://localhost:3000/api/practice/roles \
  -H "Authorization: Bearer $TOKEN"

# Create a custom role
curl -X POST http://localhost:3000/api/practice/roles \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "Front Desk Lead",
    "permissionSet": [
      "patients:read", "patients:write",
      "appointments:read", "appointments:write",
      "billing:read"
    ]
  }'

# Clone HydraFacial from library with IVA's display name
curl -X POST http://localhost:3000/api/catalog/appointment-types/from-library \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "libraryId": "<library-item-id>",
    "serviceLineId": "<aesthetics-service-line-id>",
    "displayName": "Diamond HydroFacial",
    "shortName": "DHF",
    "durationBlocks": 3
  }'
```

## Rollback plan

```bash
git revert -m 1 72eaad5
git push origin main
```

Safe — the tables it uses (`practices`, `service_lines`, `users`, `user_roles`, `user_role_assignments`, `treatment_library`, `body_area_modifiers`, `appointment_types`) all exist in earlier migrations and stay after revert.

## Common breakage and fixes

**"Cannot delete system role"** — by design. Only custom roles (`is_system = false`) can be deleted. If you really need to remove an Admin role, you'd need to query the database directly, but you almost certainly shouldn't.

**"Setting a new default fee schedule didn't unset the old one"** — actually, this is fee schedules (billing module), not catalog. But the same pattern: the create/update method checks for `isDefault: true` and runs an UPDATE to unset existing defaults before inserting/updating. If two schedules show as default, the bug is here.

**"User has 0 permissions after assigning Admin role"** — check the `user_role_assignments` table directly. The JWT only refreshes on next login (or refresh-token call). If the user logged in BEFORE the role was assigned, their JWT doesn't have the new permissions yet. They need to log out and back in, or hit `POST /api/auth/refresh`.

**"Library item created successfully but doesn't appear in GET /library"** — check the GET filters. If you're filtering by `?serviceLine=eyecare` and your new item has `serviceLines: ['aesthetics']`, it won't show up. Drop the filter to see all items.
