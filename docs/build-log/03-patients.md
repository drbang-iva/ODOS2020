# 03 — Patients

The patient module is the front-desk workflow: create a chart, add insurance, link guardians, log alerts, search for the patient when they call.

**Merged to main:** `7ec984d`
**Tests at end:** 119/119

## What we built

1. **Patient CRUD.** Create, read, update, deactivate. All the FHIR-aligned fields from Schema V2 (middle name, SSN encrypted, employer, occupation, hobbies, referring provider, race, ethnicity, etc.). Soft delete only — once a patient exists, they exist forever for audit reasons. Deactivation hides them from search.

2. **Patient search.** Free-text query (`?q=...`) searches first name, last name, phone, and email simultaneously. Or you can filter by specific field (`?name=`, `?phone=`, `?dob=`). Pagination via `limit` and `offset`. Excludes inactive patients by default.

3. **Insurance management.** Each patient can have up to 3 insurance plans (priority 1/2/3). Each plan has a type (medical or vision), payer info, member ID, group, subscriber, effective dates, and copay. Listed in priority order.

4. **Responsible party linking.** A minor's chart can link to one or more parent/guardian charts. Each link records financial responsibility, consent authority, insurance subscriber status, and primary flag. Reuses the `responsible_parties` table from Schema V2.

5. **Patient alerts.** Structured alerts (allergy, balance, clinical, scheduling, custom) with severity (info, warning, critical). Critical alerts sort first. Alerts can be resolved (marked closed) but not deleted — the audit trail stays intact.

## Why this design

**Search is intentionally permissive.** The free-text `q` parameter searches across multiple fields because front desk staff don't know in advance what they'll have. They might have a phone number, half a last name, or a partial email. One search box hits all of them.

**Insurance is limited to 3 priorities.** This is a `CHECK (priority BETWEEN 1 AND 3)` constraint in the database. In practice, you almost never need more than primary + secondary, and tertiary handles the rare case (e.g., Medicare + Medigap + employer plan).

**Alerts are structured, not free text.** Free-text "notes" become unsearchable junk drawers in legacy PMS software. By making alerts structured (type + severity + message), we get sortable, filterable, actionable data. The "custom" type exists as an escape hatch for things that don't fit but want the alert visibility.

**Resolve don't delete.** When an alert no longer applies, you mark it resolved (with a `resolved_by` and `resolved_at` timestamp). The original alert stays. This means you can ask "what alerts did Jane have on her last visit" months later.

## Key files

```
src/server/modules/patients/
├── schemas.ts                           # Patient + insurance + RP + alert input validation
├── service.ts                           # PatientService class (all four sub-services in one file)
└── routes.ts                            # /api/patients/* endpoints
tests/server/modules/patients/
├── patient.service.test.ts              # 26 service tests
└── patient.routes.test.ts               # 13 route tests
```

## API endpoints

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/api/patients` | `patients:read` | Search/list with filters |
| POST | `/api/patients` | `patients:write` | Create |
| GET | `/api/patients/:id` | `patients:read` | Read |
| PATCH | `/api/patients/:id` | `patients:write` | Update |
| DELETE | `/api/patients/:id` | `patients:delete` | Deactivate |
| GET | `/api/patients/:id/insurance` | `patients:read` | List insurance |
| POST | `/api/patients/:id/insurance` | `patients:write` | Add insurance |
| PATCH | `/api/patients/:id/insurance/:insId` | `patients:write` | Update insurance |
| DELETE | `/api/patients/:id/insurance/:insId` | `patients:write` | Remove insurance |
| GET | `/api/patients/:id/responsible-parties` | `patients:read` | List guardians |
| POST | `/api/patients/:id/responsible-parties` | `patients:write` | Link guardian |
| DELETE | `/api/patients/:id/responsible-parties/:rpId` | `patients:write` | Unlink guardian |
| GET | `/api/patients/:id/alerts` | `patients:read` | List alerts (active only by default) |
| POST | `/api/patients/:id/alerts` | `patients:write` | Create alert |
| POST | `/api/patients/:id/alerts/:alertId/resolve` | `patients:write` | Mark resolved |

`patients:delete` is a separate permission from `patients:write` because deactivation is a higher-trust action (you generally don't want a part-time tech to be able to deactivate patient records).

## Test coverage

26 service tests + 13 route tests covering:
- Patient CRUD with all field combinations (required only, optional fields, array fields like hobbies)
- Multi-tenant isolation (can't read another practice's patients)
- Search by free text, name, phone, DOB
- Pagination
- Inactive patient exclusion
- Insurance add/list/update/delete with priority ordering
- Responsible party linking (minor → parent)
- Alert creation, severity ordering, resolution
- Resolved alerts excluded by default

## Known limitations

- **SSN encryption is column-level "encrypted_at_rest" intent only.** The current implementation stores whatever string the API receives in `ssn_encrypted`. Real-world deployment needs to add column encryption (pgcrypto's `pgp_sym_encrypt` or similar) and a key management story. The column name and the API surface are ready; the encryption layer isn't.

- **No duplicate detection on patient create.** If you create "Jane Doe DOB 1990-01-01" twice, you get two patient rows. The `patient_contacts` table from foundation has `idx_patients_practice_dob` and `idx_patients_practice_name` indexes which help search be fast, but duplicate detection during create is not implemented.

- **No patient merge.** When duplicates do happen, there's no merge tool. Manual SQL only.

- **Insurance verification is not wired.** Adding insurance just stores the data. There's no eligibility check, no real-time validation, no Weather Report. That's a later phase that needs PVerify or Claim.MD.

- **Alerts don't trigger on workflows.** A "balance due" alert exists in the database but the scheduling module doesn't check for it before booking. Cross-module alert wiring is a Phase 5+ task.

## How to verify locally

```bash
# Run patient tests
npx vitest run tests/server/modules/patients/

# Manual test
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"eric@iva.com","password":"admin123!","practiceId":"<id>"}' | jq -r .accessToken)

# Search
curl "http://localhost:3000/api/patients?q=Johnson" \
  -H "Authorization: Bearer $TOKEN"

# Create
curl -X POST http://localhost:3000/api/patients \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "firstName": "Test",
    "lastName": "Patient",
    "dateOfBirth": "1990-01-01",
    "sex": "F",
    "phonePrimary": "555-0000",
    "addressLine1": "100 Main",
    "city": "Edmond",
    "state": "OK",
    "zip": "73034"
  }'
```

## Rollback plan

```bash
git revert -m 1 7ec984d
git push origin main
```

Safe to revert. The tables this module uses (`patients`, `patient_insurance`, `responsible_parties`, `patient_alerts`) all exist in the foundation/v2 migrations and stay in place after revert.

## Common breakage and fixes

**"GET /api/patients returns empty even though I just created one"** — check `is_active`. The default search excludes inactive. Add `?includeInactive=true` (not currently implemented in the route — would be a small addition) or query the database directly to confirm the row exists.

**"Cannot add a 4th insurance plan"** — the database constraint is `priority BETWEEN 1 AND 3`. By design. If a patient genuinely needs more, the data model needs revisiting.

**"Insurance shows in wrong order"** — the service orders by `priority` ascending. If you didn't set priorities (1, 2, 3), they'll be in arbitrary order. Always set priority explicitly when adding insurance.

**"Resolved alerts come back when I list"** — the default `listAlerts(patientId)` call passes `includeResolved = false`. If you're calling the service directly with `true`, that's why. The route uses the query param `?includeResolved=true`.

**"Critical allergy alert isn't at the top"** — alerts are sorted by severity (critical → warning → info) then by `created_at DESC`. If you see a non-critical alert above a critical one, that's a bug. Verify the database row has `severity='critical'` (not 'Critical' or 'CRITICAL' — case matters for the CHECK constraint).
