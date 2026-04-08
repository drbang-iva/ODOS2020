# 01 — Schema V2

After the foundation merged, Eric reviewed the schema with a clinician's eye and identified gaps. Schema V2 closes them with a second migration and a service refactor.

**Merged to main:** part of `44e1187` (rolled into the foundation merge)
**Tests at end:** 52/52
**Decision file:** `performance-od/decisions/2026-04-07-osod-treatment-library-schema-decisions.md`

## What we built

Five interconnected changes — all blocked the rest of the build until they were in.

### 1. Treatment library architecture (3 layers)

The original schema had a flat `appointment_types` table with 10 hardcoded types. The reality at IVA is 127 eyecare services + 64 aesthetics services. Most other PMS software either makes you build everything from scratch or ships 10 generic types and lets you add free-text.

OSOD's approach is three layers:

**Layer 1: Treatment library (shipped presets)**
A read-only catalog of ~270 standard treatments. OSOD ships them. Each one has the standard name, category, typical duration, CPT codes, equipment requirements, and which provider scopes can deliver it.

**Layer 2: Body-area modifiers**
Instead of having 9 separate appointment types for "RF Microneedling Face," "RF Microneedling Neck," "RF Microneedling Hands," you have ONE base treatment ("RF Microneedling") and pick the body area at booking time. Each body area can adjust the duration, equipment, or consent requirements.

**Layer 3: Practice-local customization**
Practices clone treatments from the library into their own `appointment_types` rows. The display name is **always editable** — IVA's "Diamond HydroFacial" is just a display_name override on the standard "HydraFacial" library item. The link to the library stays for analytics and reporting.

### 2. Patient field additions

Eric flagged missing demographics fields. Added:
- `middle_name`
- `ssn_encrypted` (encrypted at rest, never displayed in full)
- `employer`
- `occupation`
- `hobbies` (array — sports vision needs, hobby-specific lens choices)
- `referring_provider` + `referring_provider_npi`
- `preferred_pharmacy_npi` (the practice's existing `preferred_pharmacy` field is the human name)
- `race` + `ethnicity` (clinical relevance: glaucoma risk, medication metabolism)

All fields are designed to map to FHIR Patient resource so future migration tooling is simpler.

### 3. Guardian-minor linking (`responsible_parties` table)

The original `patient_contacts` table had a `relationship` field that included "guardian," but it didn't model the real complexity:

- A minor needs someone with **financial responsibility** (gets the bill)
- A minor needs someone with **consent authority** (signs forms)
- A minor on a parent's insurance has the parent as the **insurance subscriber**
- Divorced parents have **custody notes** (who has medical decision authority)

The new `responsible_parties` table handles all of this. A minor patient can have multiple responsible parties, each with separate flags for financial/consent/insurance authority.

The system enforces: a minor MUST have at least one responsible party with `is_consent_authority = true`. When a minor turns 18, the system flags for review.

### 4. Tag-based permission model

The original schema had 4 rigid roles: `admin`, `provider`, `staff`, `agent`. Reality at IVA is that Hannah (Eric's wife) does **front desk + optical + aesthetics** — she has three "jobs." Rigid roles don't fit.

Replaced with two new tables:

- **`user_roles`** — practice-defined role templates with a `permission_set TEXT[]` array. System ships 7 defaults (Admin, Provider, Front Desk, Optician, Aesthetician, Tech, Biller) but practices can create their own.
- **`user_role_assignments`** — many-to-many junction. Hannah gets THREE rows: Front Desk, Optician (scoped to eyecare service line), Aesthetician (scoped to aesthetics service line). Her effective permissions are the union of all three.

Permissions follow `resource:action` format: `patients:read`, `appointments:write`, `billing:submit`, `admin:users`, etc.

The auth service was refactored to load permissions from `user_role_assignments` at login time and stuff them into the JWT as a `permissions: string[]` array. Routes check `permissions.includes('admin:users')` instead of `role === 'admin'`.

### 5. Aesthetics-fork architecture

This isn't a code change — it's a confirmation of the design intent. The treatment library + service line activation means the same OSOD codebase can run as:
- Eyecare-only practice (skip aesthetics treatments and modules)
- Aesthetics-only practice (skip eyecare treatments and modules)
- Combined practice like IVA (both active)

No code fork. Just a setup-time choice that controls which library items load and which service lines exist.

## Why this design

**Eric's clinical lens caught what generic database design missed.** Every gap in the original schema was a real-world friction point that another PMS handles badly. The treatment library breaks the "you can have any color you want as long as it's black" trap of legacy systems.

**FHIR alignment matters now, not later.** Race/ethnicity, NPI fields, and the patient demographic structure all map to FHIR Patient. When OSOD adds data migration from Eyefinity or RevolutionEHR later, the mapping is mostly 1:1.

**Permission tags survive contact with reality.** Locked roles always force "we need a special role just for this person" workarounds. Tags compose. When Eric needs to give Jayden the ability to view billing reports without making her an Admin, he creates a custom role with one permission.

## Key files

```
src/server/db/migrations/
└── 002_schema_v2.sql        # All five changes in one migration
src/server/modules/auth/
├── service.ts                # Refactored: loadPermissions(), JWT carries permissions[]
├── schemas.ts                # createUser uses roleIds[], not role enum
└── routes.ts                 # Permission checks instead of role checks
src/server/middleware/auth.ts # AuthContext.permissions: string[] (was role: string)
scripts/seed.ts               # Updated with 7 system roles, treatment library presets, body areas, Hannah's 3 roles
```

## Test coverage

- 12 migration tests (verify all new tables, constraints, partial unique indexes)
- All existing auth tests updated to use roleIds instead of role enum
- Multi-role assignment test (Hannah's setup) verifies permissions union

**One sneaky bug caught during review:** PostgreSQL treats NULL as distinct in unique constraints, so `UNIQUE (user_id, role_id, service_line_id)` doesn't prevent duplicate assignments when `service_line_id` is NULL. Fixed with a partial unique index:

```sql
CREATE UNIQUE INDEX idx_unique_role_assignment_no_sl
  ON user_role_assignments (user_id, role_id)
  WHERE service_line_id IS NULL;
```

This same NULL-uniqueness trap bit us again later in the billing module — worth remembering.

## Known limitations

- **The 270 library presets aren't seeded yet.** The seed only ships 20 sample treatments (12 eyecare + 8 aesthetics). The full catalog is in `performance-od/research/2026-04-07-eyecare-appointment-types-comprehensive.md` and will be loaded later via a one-time data import.
- **`preferred_language` defaults to `en`.** No language selection UI yet.
- **Race/ethnicity are free-text fields, not coded values.** Should align with US Core Race/Ethnicity OMB categories when we add validation.

## How to verify locally

```bash
# After running migrations and seed:
psql postgresql://osod:osod_dev@localhost:5432/osod -c "
  SELECT u.full_name, array_agg(ur.name ORDER BY ur.name) AS roles
  FROM users u
  LEFT JOIN user_role_assignments ura ON u.id = ura.user_id
  LEFT JOIN user_roles ur ON ur.id = ura.role_id
  GROUP BY u.full_name
  ORDER BY u.full_name;
"
# Expected output includes:
#   Hannah Bang | {Aesthetician,"Front Desk",Optician}
```

## Rollback plan

You can't easily roll back schema v2 without nuking the database. Migration 002 is additive (new tables, new columns) but the auth refactor changed the JWT shape. Rolling back the code without rolling back the migration would leave the auth service unable to read its own JWTs.

The right rollback: revert the merge commit (`git revert -m 1 44e1187`) and recreate the database from scratch.

## Common breakage and fixes

**"Cannot insert NULL into is_default of fee_schedules"** — same kind of issue we saw in fee schedules. If you call a service method directly (not through the route handler), Zod's `.default()` doesn't apply. Either call through the route handler or pass the field explicitly.

**"Hannah can't see the optical inventory"** — check her role assignments. She needs the Optician role, scoped to the eyecare service line. Query the `user_role_assignments` table to verify.

**"System role 'Admin' is missing"** — the seed didn't run, or it ran but the practice didn't get system roles created. Check `SELECT * FROM user_roles WHERE is_system = true` and re-run the seed if empty.
