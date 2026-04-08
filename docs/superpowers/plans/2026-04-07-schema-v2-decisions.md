# Schema V2: Treatment Library, Patient Fields, Permissions, Guardian Linking

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply all five accepted decisions from `performance-od/decisions/2026-04-07-osod-treatment-library-schema-decisions.md` to the OSOD foundation schema before merging to main.

**Architecture:** New migration `002_schema_v2.sql` adds columns/tables on top of `001_foundation.sql`. Auth service refactored from rigid 4-role enum to tag-based permission sets with `user_roles` + `user_role_assignments` tables. JWT payload changes from `role: string` to `permissions: string[]` (union of all assigned role permission sets). Seed script updated with real IVA data. All existing tests updated to match.

**Tech Stack:** PostgreSQL, TypeScript, Hono, Vitest, Zod, jose (JWT)

**Decision file:** `performance-od/decisions/2026-04-07-osod-treatment-library-schema-decisions.md`

---

## File Structure

### New Files
- `src/server/db/migrations/002_schema_v2.sql` — DDL for all schema changes
- `tests/server/db/migration-v2.test.ts` — migration applies cleanly, constraints work

### Modified Files
- `src/server/modules/auth/schemas.ts` — createUser schema updated (role → roleIds)
- `src/server/modules/auth/service.ts` — createUser, login, verifyAccessToken updated for permission model
- `src/server/modules/auth/routes.ts` — admin check changes from `role === 'admin'` to permission check
- `src/server/middleware/auth.ts` — AuthContext changes from `role: string` to `permissions: string[]`
- `scripts/seed.ts` — real IVA roles, patient fields, treatment library data
- `tests/server/modules/auth/auth.test.ts` — updated for new permission model
- `tests/server/middleware/auth.test.ts` — updated AuthContext shape
- `tests/server/integration/smoke.test.ts` — updated for new createUser signature

---

## Task 1: Migration — Patient Schema Additions

**Files:**
- Create: `src/server/db/migrations/002_schema_v2.sql`
- Create: `tests/server/db/migration-v2.test.ts`

- [ ] **Step 1: Write the migration file (patient columns only for now — we'll append to it)**

```sql
-- 002_schema_v2.sql
-- Applies decisions from performance-od/decisions/2026-04-07-osod-treatment-library-schema-decisions.md

---------------------------------------
-- PATIENT SCHEMA ADDITIONS (Decision 2)
---------------------------------------
ALTER TABLE patients ADD COLUMN middle_name TEXT;
ALTER TABLE patients ADD COLUMN ssn_encrypted TEXT;
ALTER TABLE patients ADD COLUMN employer TEXT;
ALTER TABLE patients ADD COLUMN occupation TEXT;
ALTER TABLE patients ADD COLUMN hobbies TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE patients ADD COLUMN referring_provider TEXT;
ALTER TABLE patients ADD COLUMN referring_provider_npi TEXT;
ALTER TABLE patients ADD COLUMN preferred_pharmacy_npi TEXT;
ALTER TABLE patients ADD COLUMN race TEXT;
ALTER TABLE patients ADD COLUMN ethnicity TEXT;
```

Note: `preferred_pharmacy` and `preferred_language` already exist in 001_foundation.sql.

- [ ] **Step 2: Write the migration test**

```typescript
// tests/server/db/migration-v2.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('002_schema_v2 migration', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    const setupPool = new pg.Pool({ connectionString: TEST_DB_URL });
    await setupPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await setupPool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('patients table has new columns', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'patients'
      AND column_name IN ('middle_name', 'ssn_encrypted', 'employer', 'occupation',
                          'hobbies', 'referring_provider', 'referring_provider_npi',
                          'preferred_pharmacy_npi', 'race', 'ethnicity')
      ORDER BY column_name
    `);
    const cols = result.rows.map(r => r.column_name);
    expect(cols).toContain('middle_name');
    expect(cols).toContain('ssn_encrypted');
    expect(cols).toContain('employer');
    expect(cols).toContain('occupation');
    expect(cols).toContain('hobbies');
    expect(cols).toContain('referring_provider');
    expect(cols).toContain('referring_provider_npi');
    expect(cols).toContain('preferred_pharmacy_npi');
    expect(cols).toContain('race');
    expect(cols).toContain('ethnicity');
  });

  it('can insert patient with new fields', async () => {
    const practice = await pool.query(
      "INSERT INTO practices (name) VALUES ('Migration Test') RETURNING id"
    );
    const practiceId = practice.rows[0].id;

    const result = await pool.query(
      `INSERT INTO patients (
        practice_id, first_name, middle_name, last_name, date_of_birth, sex,
        phone_primary, address_line1, city, state, zip,
        ssn_encrypted, employer, occupation, hobbies,
        referring_provider, referring_provider_npi, preferred_pharmacy_npi,
        race, ethnicity
      ) VALUES (
        $1, 'Eric', 'R', 'Bang', '1985-06-15', 'M',
        '555-0001', '100 Main St', 'Edmond', 'OK', '73034',
        'encrypted_ssn_value', 'Self-Employed', 'Optometrist', $2,
        'Dr. Referral', '1234567890', '0987654321',
        'Asian', 'Not Hispanic or Latino'
      ) RETURNING id`,
      [practiceId, ['cycling', 'coding']]
    );
    expect(result.rows[0].id).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify migration applies and patient insert works**

Run: `npx vitest run tests/server/db/migration-v2.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 4: Commit**

```bash
git add src/server/db/migrations/002_schema_v2.sql tests/server/db/migration-v2.test.ts
git commit -m "feat: add patient schema columns — middle name, SSN encrypted, employer, occupation, hobbies, referring provider, race/ethnicity (Decision 2)"
```

---

## Task 2: Migration — Responsible Parties Table

**Files:**
- Modify: `src/server/db/migrations/002_schema_v2.sql`
- Modify: `tests/server/db/migration-v2.test.ts`

- [ ] **Step 1: Append responsible_parties DDL to 002_schema_v2.sql**

Append after the patient columns section:

```sql
---------------------------------------
-- RESPONSIBLE PARTIES (Decision 3)
---------------------------------------
CREATE TABLE responsible_parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  responsible_party_patient_id UUID REFERENCES patients(id),
  relationship TEXT NOT NULL
    CHECK (relationship IN ('parent', 'legal_guardian', 'spouse', 'self', 'other')),
  is_financial_responsible BOOLEAN NOT NULL DEFAULT false,
  is_consent_authority BOOLEAN NOT NULL DEFAULT false,
  is_insurance_subscriber BOOLEAN NOT NULL DEFAULT false,
  insurance_subscriber_id TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  court_order_notes TEXT,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_responsible_parties_patient ON responsible_parties(patient_id);
CREATE INDEX idx_responsible_parties_responsible ON responsible_parties(responsible_party_patient_id);
```

- [ ] **Step 2: Add responsible_parties tests to migration-v2.test.ts**

Add these tests inside the existing describe block:

```typescript
  it('responsible_parties table exists with correct columns', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'responsible_parties'
      ORDER BY column_name
    `);
    const cols = result.rows.map(r => r.column_name);
    expect(cols).toContain('patient_id');
    expect(cols).toContain('responsible_party_patient_id');
    expect(cols).toContain('relationship');
    expect(cols).toContain('is_financial_responsible');
    expect(cols).toContain('is_consent_authority');
    expect(cols).toContain('is_insurance_subscriber');
    expect(cols).toContain('court_order_notes');
  });

  it('enforces relationship check constraint', async () => {
    const practice = await pool.query(
      "INSERT INTO practices (name) VALUES ('RP Test') RETURNING id"
    );
    const pid = practice.rows[0].id;
    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Minor', 'Child', '2015-01-01', 'F', '555-0002', '100 Oak', 'Edmond', 'OK', '73034') RETURNING id`,
      [pid]
    );
    const guardian = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Parent', 'Adult', '1985-01-01', 'F', '555-0003', '100 Oak', 'Edmond', 'OK', '73034') RETURNING id`,
      [pid]
    );

    // Valid relationship
    const rp = await pool.query(
      `INSERT INTO responsible_parties (patient_id, responsible_party_patient_id, relationship, is_financial_responsible, is_consent_authority)
       VALUES ($1, $2, 'parent', true, true) RETURNING id`,
      [patient.rows[0].id, guardian.rows[0].id]
    );
    expect(rp.rows[0].id).toBeDefined();

    // Invalid relationship value
    await expect(pool.query(
      `INSERT INTO responsible_parties (patient_id, responsible_party_patient_id, relationship)
       VALUES ($1, $2, 'uncle')`,
      [patient.rows[0].id, guardian.rows[0].id]
    )).rejects.toThrow();
  });
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/server/db/migration-v2.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add src/server/db/migrations/002_schema_v2.sql tests/server/db/migration-v2.test.ts
git commit -m "feat: add responsible_parties table — guardian-minor linking with financial/consent/insurance authority (Decision 3)"
```

---

## Task 3: Migration — Permission Model (user_roles + user_role_assignments)

**Files:**
- Modify: `src/server/db/migrations/002_schema_v2.sql`
- Modify: `tests/server/db/migration-v2.test.ts`

- [ ] **Step 1: Append permission model DDL to 002_schema_v2.sql**

Append after the responsible_parties section:

```sql
---------------------------------------
-- PERMISSION MODEL (Decision 4)
---------------------------------------

-- Role templates (practice-defined)
CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  permission_set TEXT[] NOT NULL DEFAULT '{}',
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (practice_id, name)
);

CREATE INDEX idx_user_roles_practice ON user_roles(practice_id);

-- Many-to-many: users can have multiple roles
CREATE TABLE user_role_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES user_roles(id) ON DELETE CASCADE,
  service_line_id UUID REFERENCES service_lines(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, role_id, service_line_id)
);

CREATE INDEX idx_user_role_assignments_user ON user_role_assignments(user_id);
CREATE INDEX idx_user_role_assignments_role ON user_role_assignments(role_id);

-- Keep the legacy role column for now (migration path) but make it nullable
-- New code reads from user_role_assignments; legacy code falls back to users.role
ALTER TABLE users ALTER COLUMN role DROP NOT NULL;
ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
-- Drop the CHECK constraint on role so it's no longer restricted to the old enum
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
```

- [ ] **Step 2: Add permission model tests to migration-v2.test.ts**

Add these tests inside the existing describe block:

```typescript
  it('user_roles and user_role_assignments tables exist', async () => {
    const roles = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_roles' ORDER BY column_name
    `);
    expect(roles.rows.map(r => r.column_name)).toContain('permission_set');
    expect(roles.rows.map(r => r.column_name)).toContain('is_system');

    const assignments = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_role_assignments' ORDER BY column_name
    `);
    expect(assignments.rows.map(r => r.column_name)).toContain('user_id');
    expect(assignments.rows.map(r => r.column_name)).toContain('role_id');
    expect(assignments.rows.map(r => r.column_name)).toContain('service_line_id');
  });

  it('user can have multiple roles', async () => {
    const practice = await pool.query(
      "INSERT INTO practices (name) VALUES ('Perm Test') RETURNING id"
    );
    const pid = practice.rows[0].id;

    const eyecare = await pool.query(
      `INSERT INTO service_lines (practice_id, name, color) VALUES ($1, 'Eyecare', '#2563EB') RETURNING id`,
      [pid]
    );
    const aesthetics = await pool.query(
      `INSERT INTO service_lines (practice_id, name, color) VALUES ($1, 'Aesthetics', '#DB2777') RETURNING id`,
      [pid]
    );

    // Create role templates
    const frontDesk = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Front Desk', $2, true) RETURNING id`,
      [pid, ['patients:read', 'patients:write', 'appointments:read', 'appointments:write']]
    );
    const optician = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Optician', $2, true) RETURNING id`,
      [pid, ['patients:read', 'inventory:read', 'inventory:adjust']]
    );
    const aesthetician = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Aesthetician', $2, true) RETURNING id`,
      [pid, ['patients:read', 'clinical:read', 'clinical:write', 'images:read', 'images:write']]
    );

    // Create Hannah — gets all three roles
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('test123!', 12);
    const hannah = await pool.query(
      `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider)
       VALUES ($1, 'hannah@iva.com', $2, 'Hannah Bang', false) RETURNING id`,
      [pid, hash]
    );
    const hannahId = hannah.rows[0].id;

    // Assign multiple roles
    await pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`,
      [hannahId, frontDesk.rows[0].id]
    );
    await pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id, service_line_id) VALUES ($1, $2, $3)`,
      [hannahId, optician.rows[0].id, eyecare.rows[0].id]
    );
    await pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id, service_line_id) VALUES ($1, $2, $3)`,
      [hannahId, aesthetician.rows[0].id, aesthetics.rows[0].id]
    );

    // Query all permissions for Hannah (union of all role permission sets)
    const perms = await pool.query(`
      SELECT DISTINCT unnest(ur.permission_set) AS perm
      FROM user_role_assignments ura
      JOIN user_roles ur ON ur.id = ura.role_id
      WHERE ura.user_id = $1
      ORDER BY perm
    `, [hannahId]);

    const permList = perms.rows.map(r => r.perm);
    expect(permList).toContain('patients:read');
    expect(permList).toContain('patients:write');
    expect(permList).toContain('appointments:read');
    expect(permList).toContain('inventory:read');
    expect(permList).toContain('clinical:write');
    expect(permList).toContain('images:write');
  });

  it('enforces unique constraint on role assignment', async () => {
    const practice = await pool.query(
      "INSERT INTO practices (name) VALUES ('Unique Test') RETURNING id"
    );
    const pid = practice.rows[0].id;
    const role = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set)
       VALUES ($1, 'Admin', $2) RETURNING id`,
      [pid, ['admin:users', 'admin:settings']]
    );
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('test123!', 12);
    const user = await pool.query(
      `INSERT INTO users (practice_id, email, password_hash, full_name)
       VALUES ($1, 'test@unique.com', $2, 'Test User') RETURNING id`,
      [pid, hash]
    );

    await pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`,
      [user.rows[0].id, role.rows[0].id]
    );

    // Duplicate should fail
    await expect(pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`,
      [user.rows[0].id, role.rows[0].id]
    )).rejects.toThrow();
  });
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/server/db/migration-v2.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 4: Commit**

```bash
git add src/server/db/migrations/002_schema_v2.sql tests/server/db/migration-v2.test.ts
git commit -m "feat: add tag-based permission model — user_roles + user_role_assignments, multi-role support (Decision 4)"
```

---

## Task 4: Migration — Treatment Library + Body-Area Modifiers + Appointment Types Refactor

**Files:**
- Modify: `src/server/db/migrations/002_schema_v2.sql`
- Modify: `tests/server/db/migration-v2.test.ts`

- [ ] **Step 1: Append treatment library DDL to 002_schema_v2.sql**

Append after the permission model section:

```sql
---------------------------------------
-- TREATMENT LIBRARY (Decision 1)
---------------------------------------

-- Shipped presets — read-only templates updated by OSOD
CREATE TABLE treatment_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  standard_name TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT,
  typical_duration_minutes INT NOT NULL,
  cpt_codes TEXT[] NOT NULL DEFAULT '{}',
  equipment_tags TEXT[] NOT NULL DEFAULT '{}',
  provider_scope TEXT[] NOT NULL DEFAULT '{}',
  service_lines TEXT[] NOT NULL DEFAULT '{}',
  body_area_modifiers_available BOOLEAN NOT NULL DEFAULT false,
  consent_required BOOLEAN NOT NULL DEFAULT false,
  is_billable BOOLEAN NOT NULL DEFAULT true,
  default_color TEXT NOT NULL DEFAULT '#3B82F6',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_treatment_library_category ON treatment_library(category);
CREATE INDEX idx_treatment_library_service_lines ON treatment_library USING GIN(service_lines);

-- Body-area modifiers — shipped + practice-extensible
CREATE TABLE body_area_modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID REFERENCES practices(id),
  name TEXT NOT NULL,
  short_code TEXT NOT NULL,
  duration_adjustment_minutes INT NOT NULL DEFAULT 0,
  additional_equipment_tags TEXT[] NOT NULL DEFAULT '{}',
  additional_consent BOOLEAN NOT NULL DEFAULT false,
  is_system BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Refactor appointment_types: add library link, display_name, multi-service-line, body-area, series
ALTER TABLE appointment_types ADD COLUMN library_id UUID REFERENCES treatment_library(id);
ALTER TABLE appointment_types ADD COLUMN display_name TEXT;
ALTER TABLE appointment_types ADD COLUMN service_line_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE appointment_types ADD COLUMN body_area_modifier_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE appointment_types ADD COLUMN equipment_tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE appointment_types ADD COLUMN provider_scope TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE appointment_types ADD COLUMN is_custom BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE appointment_types ADD COLUMN price_cents INT;
ALTER TABLE appointment_types ADD COLUMN cpt_codes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE appointment_types ADD COLUMN requires_consultation BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE appointment_types ADD COLUMN series_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE appointment_types ADD COLUMN series_count INT;
ALTER TABLE appointment_types ADD COLUMN online_bookable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE appointment_types ADD COLUMN photo_required BOOLEAN NOT NULL DEFAULT false;

-- Backfill display_name from name for existing rows
UPDATE appointment_types SET display_name = name WHERE display_name IS NULL;
-- Backfill service_line_ids from the existing single service_line_id FK
UPDATE appointment_types SET service_line_ids = ARRAY[service_line_id] WHERE service_line_ids = '{}';
```

- [ ] **Step 2: Add treatment library tests to migration-v2.test.ts**

Add these tests inside the existing describe block:

```typescript
  it('treatment_library table exists', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'treatment_library' ORDER BY column_name
    `);
    const cols = result.rows.map(r => r.column_name);
    expect(cols).toContain('standard_name');
    expect(cols).toContain('category');
    expect(cols).toContain('cpt_codes');
    expect(cols).toContain('equipment_tags');
    expect(cols).toContain('body_area_modifiers_available');
    expect(cols).toContain('service_lines');
  });

  it('body_area_modifiers table exists', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'body_area_modifiers' ORDER BY column_name
    `);
    const cols = result.rows.map(r => r.column_name);
    expect(cols).toContain('name');
    expect(cols).toContain('short_code');
    expect(cols).toContain('duration_adjustment_minutes');
  });

  it('appointment_types has new columns from treatment library refactor', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'appointment_types'
      AND column_name IN ('library_id', 'display_name', 'service_line_ids',
                          'body_area_modifier_ids', 'equipment_tags', 'series_enabled',
                          'series_count', 'online_bookable', 'photo_required',
                          'is_custom', 'price_cents', 'cpt_codes', 'provider_scope',
                          'requires_consultation')
      ORDER BY column_name
    `);
    const cols = result.rows.map(r => r.column_name);
    expect(cols).toHaveLength(14);
    expect(cols).toContain('library_id');
    expect(cols).toContain('display_name');
    expect(cols).toContain('series_enabled');
    expect(cols).toContain('photo_required');
  });

  it('treatment_library links to appointment_types via library_id', async () => {
    // Insert a library preset
    const lib = await pool.query(
      `INSERT INTO treatment_library (standard_name, category, typical_duration_minutes, service_lines, cpt_codes, body_area_modifiers_available)
       VALUES ('RF Microneedling', 'Skin Rejuvenation', 60, $1, $2, true) RETURNING id`,
      [['aesthetics'], ['17999']]
    );

    const practice = await pool.query(
      "INSERT INTO practices (name) VALUES ('TL Test') RETURNING id"
    );
    const pid = practice.rows[0].id;
    const sl = await pool.query(
      `INSERT INTO service_lines (practice_id, name, color) VALUES ($1, 'Aesthetics', '#DB2777') RETURNING id`,
      [pid]
    );

    // Practice clones from library with custom display name
    const apt = await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks,
         library_id, display_name, is_custom, series_enabled, series_count, photo_required)
       VALUES ($1, $2, 'RF Microneedling', 'RFMN', '#DB2777', 4,
         $3, 'Morpheus8 RF Microneedling', false, true, 3, true)
       RETURNING id, display_name, library_id`,
      [pid, sl.rows[0].id, lib.rows[0].id]
    );

    expect(apt.rows[0].display_name).toBe('Morpheus8 RF Microneedling');
    expect(apt.rows[0].library_id).toBe(lib.rows[0].id);
  });
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/server/db/migration-v2.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 4: Commit**

```bash
git add src/server/db/migrations/002_schema_v2.sql tests/server/db/migration-v2.test.ts
git commit -m "feat: add treatment library + body-area modifiers + appointment_types refactor (Decision 1)"
```

---

## Task 5: Refactor Auth Service — Permission-Based JWT

**Files:**
- Modify: `src/server/modules/auth/schemas.ts`
- Modify: `src/server/modules/auth/service.ts`
- Modify: `src/server/middleware/auth.ts`

- [ ] **Step 1: Update AuthContext in middleware/auth.ts**

Replace the `AuthContext` interface and update the middleware to load permissions from `user_role_assignments`:

```typescript
// src/server/middleware/auth.ts
import { createMiddleware } from 'hono/factory';
import type { AuthService } from '../modules/auth/service.js';

export interface AuthContext {
  userId: string;
  practiceId: string;
  permissions: string[];
  actorType: 'human' | 'local_agent' | 'cloud_agent';
}

export function createAuthMiddleware(authService: AuthService) {
  return createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
    // Try API key first (X-API-Key header)
    const apiKey = c.req.header('X-API-Key');
    if (apiKey) {
      const keyInfo = await authService.verifyAgentKey(apiKey);
      if (!keyInfo) {
        return c.json({ error: 'Invalid API key' }, 401);
      }
      c.set('auth', {
        userId: keyInfo.userId,
        practiceId: keyInfo.practiceId,
        permissions: keyInfo.scopes,
        actorType: keyInfo.modelType === 'local' ? 'local_agent' : 'cloud_agent',
      });
      return next();
    }

    // Try JWT (Authorization: Bearer <token>)
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authentication' }, 401);
    }

    const token = authHeader.slice(7);
    try {
      const payload = await authService.verifyAccessToken(token);
      c.set('auth', {
        userId: payload.userId,
        practiceId: payload.practiceId,
        permissions: payload.permissions,
        actorType: 'human',
      });
      return next();
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  });
}
```

- [ ] **Step 2: Update auth schemas — createUserSchema uses roleIds instead of role enum**

```typescript
// src/server/modules/auth/schemas.ts
import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  practiceId: z.string().uuid(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1),
  roleIds: z.array(z.string().uuid()).min(1),
  isProvider: z.boolean().default(false),
  serviceLineIds: z.array(z.string().uuid()).default([]),
});

export const createAgentKeySchema = z.object({
  name: z.string().min(1),
  modelType: z.enum(['local', 'cloud']),
  scopes: z.array(z.string()).min(1),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type CreateAgentKeyInput = z.infer<typeof createAgentKeySchema>;
```

- [ ] **Step 3: Update AuthService — permission loading from user_role_assignments**

Replace the full `src/server/modules/auth/service.ts`:

```typescript
import bcrypt from 'bcryptjs';
import * as jose from 'jose';
import crypto from 'node:crypto';
import type pg from 'pg';
import type { LoginInput, CreateUserInput, CreateAgentKeyInput } from './schemas.js';

interface TokenPayload {
  userId: string;
  practiceId: string;
  permissions: string[];
}

interface AgentKeyInfo {
  userId: string;
  practiceId: string;
  modelType: string;
  scopes: string[];
}

export class AuthService {
  private jwtSecret: Uint8Array;

  constructor(
    private pool: pg.Pool,
    jwtSecretString: string,
  ) {
    this.jwtSecret = new TextEncoder().encode(jwtSecretString);
  }

  /** Load deduplicated permissions from all assigned roles for a user */
  async loadPermissions(userId: string): Promise<string[]> {
    const result = await this.pool.query(`
      SELECT DISTINCT unnest(ur.permission_set) AS perm
      FROM user_role_assignments ura
      JOIN user_roles ur ON ur.id = ura.role_id
      WHERE ura.user_id = $1
      ORDER BY perm
    `, [userId]);
    return result.rows.map(r => r.perm);
  }

  async createUser(
    practiceId: string,
    input: CreateUserInput,
  ): Promise<{ id: string; email: string; fullName: string; permissions: string[] }> {
    const passwordHash = await bcrypt.hash(input.password, 12);

    const result = await this.pool.query(
      `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider, service_line_ids)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, full_name`,
      [practiceId, input.email, passwordHash, input.fullName, input.isProvider, input.serviceLineIds],
    );

    const row = result.rows[0];

    // Assign roles
    for (const roleId of input.roleIds) {
      await this.pool.query(
        `INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`,
        [row.id, roleId],
      );
    }

    const permissions = await this.loadPermissions(row.id);
    return { id: row.id, email: row.email, fullName: row.full_name, permissions };
  }

  async login(input: LoginInput): Promise<{ accessToken: string; refreshToken: string }> {
    const result = await this.pool.query(
      `SELECT id, practice_id, email, password_hash, is_active
       FROM users
       WHERE practice_id = $1 AND email = $2 AND is_active = true`,
      [input.practiceId, input.email],
    );

    const user = result.rows[0];
    if (!user) throw new Error('Invalid credentials');

    const valid = await bcrypt.compare(input.password, user.password_hash);
    if (!valid) throw new Error('Invalid credentials');

    const permissions = await this.loadPermissions(user.id);

    const accessToken = await new jose.SignJWT({
      userId: user.id,
      practiceId: user.practice_id,
      permissions,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(this.jwtSecret);

    const refreshToken = await new jose.SignJWT({
      userId: user.id,
      practiceId: user.practice_id,
      type: 'refresh',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(this.jwtSecret);

    return { accessToken, refreshToken };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const { payload } = await jose.jwtVerify(refreshToken, this.jwtSecret);
    if (payload.type !== 'refresh') throw new Error('Not a refresh token');

    const userId = payload.userId as string;
    const practiceId = payload.practiceId as string;

    const result = await this.pool.query(
      'SELECT is_active FROM users WHERE id = $1 AND practice_id = $2',
      [userId, practiceId],
    );
    const user = result.rows[0];
    if (!user || !user.is_active) throw new Error('User not found or inactive');

    const permissions = await this.loadPermissions(userId);

    const accessToken = await new jose.SignJWT({
      userId,
      practiceId,
      permissions,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(this.jwtSecret);

    const newRefreshToken = await new jose.SignJWT({
      userId,
      practiceId,
      type: 'refresh',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(this.jwtSecret);

    return { accessToken, refreshToken: newRefreshToken };
  }

  async verifyAccessToken(token: string): Promise<TokenPayload> {
    const { payload } = await jose.jwtVerify(token, this.jwtSecret);
    return {
      userId: payload.userId as string,
      practiceId: payload.practiceId as string,
      permissions: (payload.permissions as string[]) ?? [],
    };
  }

  async createAgentKey(
    practiceId: string,
    userId: string,
    input: CreateAgentKeyInput,
  ): Promise<{ rawKey: string; keyId: string }> {
    const rawKey = `osod_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = await bcrypt.hash(rawKey, 12);

    const result = await this.pool.query(
      `INSERT INTO agent_keys (practice_id, user_id, key_hash, name, model_type, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [practiceId, userId, keyHash, input.name, input.modelType, input.scopes],
    );

    return { rawKey, keyId: result.rows[0].id };
  }

  async verifyAgentKey(rawKey: string): Promise<AgentKeyInfo | null> {
    const keys = await this.pool.query(
      `SELECT ak.user_id, ak.practice_id, ak.key_hash, ak.model_type, ak.scopes
       FROM agent_keys ak
       WHERE ak.is_active = true`,
    );

    for (const key of keys.rows) {
      const valid = await bcrypt.compare(rawKey, key.key_hash);
      if (valid) {
        await this.pool.query(
          'UPDATE agent_keys SET last_used_at = NOW() WHERE user_id = $1 AND key_hash = $2',
          [key.user_id, key.key_hash],
        );
        return {
          userId: key.user_id,
          practiceId: key.practice_id,
          modelType: key.model_type,
          scopes: key.scopes,
        };
      }
    }

    return null;
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/server/modules/auth/schemas.ts src/server/modules/auth/service.ts src/server/middleware/auth.ts
git commit -m "refactor: auth service from rigid roles to tag-based permissions — JWT carries permissions[] (Decision 4)"
```

---

## Task 6: Refactor Auth Routes — Permission Check Instead of Role Check

**Files:**
- Modify: `src/server/modules/auth/routes.ts`

- [ ] **Step 1: Update admin check from role to permission**

Replace the full file:

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AuthService } from './service.js';
import { loginSchema, refreshSchema, createUserSchema, createAgentKeySchema } from './schemas.js';
import type { AuthContext } from '../../middleware/auth.js';

export function createAuthRoutes(authService: AuthService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  // Public: login
  routes.post('/login', zValidator('json', loginSchema), async (c) => {
    const input = c.req.valid('json');
    try {
      const tokens = await authService.login(input);
      return c.json(tokens);
    } catch {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
  });

  // Public: refresh
  routes.post('/refresh', zValidator('json', refreshSchema), async (c) => {
    const { refreshToken } = c.req.valid('json');
    try {
      const tokens = await authService.refreshAccessToken(refreshToken);
      return c.json(tokens);
    } catch {
      return c.json({ error: 'Invalid or expired refresh token' }, 401);
    }
  });

  // Protected: create user (requires admin:users permission)
  routes.post('/users', zValidator('json', createUserSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth.permissions.includes('admin:users')) {
      return c.json({ error: 'admin:users permission required' }, 403);
    }
    const input = c.req.valid('json');
    const user = await authService.createUser(auth.practiceId, input);
    return c.json(user, 201);
  });

  // Protected: create agent key (requires admin:users permission)
  routes.post('/agent-keys', zValidator('json', createAgentKeySchema), async (c) => {
    const auth = c.get('auth');
    if (!auth.permissions.includes('admin:users')) {
      return c.json({ error: 'admin:users permission required' }, 403);
    }
    const input = c.req.valid('json');
    // Create an agent user identity (no roles needed — agents use scopes)
    const agentUser = await authService.createUser(auth.practiceId, {
      email: `${input.name}@agent.local`,
      password: crypto.randomUUID(),
      fullName: input.name,
      roleIds: [],
      isProvider: false,
      serviceLineIds: [],
    });
    const result = await authService.createAgentKey(auth.practiceId, agentUser.id, input);
    return c.json({ keyId: result.keyId, rawKey: result.rawKey, agentUserId: agentUser.id }, 201);
  });

  return routes;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/modules/auth/routes.ts
git commit -m "refactor: auth routes use permission checks instead of role === 'admin'"
```

---

## Task 7: Update All Tests for New Permission Model

**Files:**
- Modify: `tests/server/modules/auth/auth.test.ts`
- Modify: `tests/server/middleware/auth.test.ts`
- Modify: `tests/server/integration/smoke.test.ts`

- [ ] **Step 1: Update auth.test.ts — create roles before users**

Replace the full test file:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { AuthService } from '../../../../src/server/modules/auth/service.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long-for-validation';

describe('AuthService', () => {
  let pool: pg.Pool;
  let auth: AuthService;
  let practiceId: string;
  let adminRoleId: string;
  let staffRoleId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });

    auth = new AuthService(pool, JWT_SECRET);

    // Create a practice
    const result = await pool.query(
      "INSERT INTO practices (name) VALUES ('Test Practice') RETURNING id"
    );
    practiceId = result.rows[0].id;

    // Create system roles
    const admin = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [practiceId, ['admin:users', 'admin:settings', 'patients:read', 'patients:write',
                    'appointments:read', 'appointments:write', 'billing:read', 'billing:submit',
                    'clinical:read', 'clinical:write', 'reports:read', 'reports:export']]
    );
    adminRoleId = admin.rows[0].id;

    const staff = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Front Desk', $2, true) RETURNING id`,
      [practiceId, ['patients:read', 'patients:write', 'appointments:read', 'appointments:write']]
    );
    staffRoleId = staff.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('createUser', () => {
    it('creates a user with role assignments and returns permissions', async () => {
      const user = await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        roleIds: [adminRoleId],
        isProvider: true,
        serviceLineIds: [],
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe('doc@test.com');
      expect(user.fullName).toBe('Dr. Test');
      expect(user.permissions).toContain('admin:users');
      expect(user.permissions).toContain('patients:read');
      // Password hash should NOT be returned
      expect((user as any).passwordHash).toBeUndefined();
      expect((user as any).password_hash).toBeUndefined();
    });

    it('rejects duplicate email within same practice', async () => {
      await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        roleIds: [adminRoleId],
        isProvider: false,
        serviceLineIds: [],
      });

      await expect(
        auth.createUser(practiceId, {
          email: 'doc@test.com',
          password: 'securepass123',
          fullName: 'Dr. Test 2',
          roleIds: [staffRoleId],
          isProvider: false,
          serviceLineIds: [],
        }),
      ).rejects.toThrow();
    });
  });

  describe('login', () => {
    it('returns JWT and refresh token for valid credentials', async () => {
      await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        roleIds: [adminRoleId],
        isProvider: false,
        serviceLineIds: [],
      });

      const result = await auth.login({
        email: 'doc@test.com',
        password: 'securepass123',
        practiceId,
      });

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(typeof result.accessToken).toBe('string');
      expect(typeof result.refreshToken).toBe('string');
    });

    it('rejects wrong password', async () => {
      await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        roleIds: [adminRoleId],
        isProvider: false,
        serviceLineIds: [],
      });

      await expect(
        auth.login({
          email: 'doc@test.com',
          password: 'wrongpassword',
          practiceId,
        }),
      ).rejects.toThrow('Invalid credentials');
    });

    it('rejects nonexistent email', async () => {
      await expect(
        auth.login({
          email: 'nobody@test.com',
          password: 'securepass123',
          practiceId,
        }),
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('verifyAccessToken', () => {
    it('decodes a valid token with permissions', async () => {
      await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        roleIds: [adminRoleId],
        isProvider: false,
        serviceLineIds: [],
      });

      const { accessToken } = await auth.login({
        email: 'doc@test.com',
        password: 'securepass123',
        practiceId,
      });

      const payload = await auth.verifyAccessToken(accessToken);
      expect(payload.userId).toBeDefined();
      expect(payload.practiceId).toBe(practiceId);
      expect(payload.permissions).toContain('admin:users');
      expect(payload.permissions).toContain('patients:read');
    });
  });

  describe('createAgentKey', () => {
    it('returns the raw API key (only shown once)', async () => {
      const user = await auth.createUser(practiceId, {
        email: 'agent@test.com',
        password: 'securepass123',
        fullName: 'Scheduling Agent',
        roleIds: [],
        isProvider: false,
        serviceLineIds: [],
      });

      const result = await auth.createAgentKey(practiceId, user.id, {
        name: 'local-scheduler',
        modelType: 'local',
        scopes: ['appointments:read', 'appointments:write'],
      });

      expect(result.rawKey).toBeDefined();
      expect(result.rawKey.startsWith('osod_')).toBe(true);
      expect(result.keyId).toBeDefined();
    });
  });

  describe('verifyAgentKey', () => {
    it('validates a correct API key and returns scopes', async () => {
      const user = await auth.createUser(practiceId, {
        email: 'agent@test.com',
        password: 'securepass123',
        fullName: 'Scheduling Agent',
        roleIds: [],
        isProvider: false,
        serviceLineIds: [],
      });

      const { rawKey } = await auth.createAgentKey(practiceId, user.id, {
        name: 'local-scheduler',
        modelType: 'local',
        scopes: ['appointments:read', 'appointments:write'],
      });

      const result = await auth.verifyAgentKey(rawKey);
      expect(result).not.toBeNull();
      expect(result!.scopes).toContain('appointments:read');
      expect(result!.modelType).toBe('local');
    });

    it('rejects an invalid API key', async () => {
      const result = await auth.verifyAgentKey('osod_invalid_key_here');
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Update auth middleware test**

Read the current middleware test to understand its structure, then update:

```typescript
// tests/server/middleware/auth.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../src/server/app.js';
import { parseConfig } from '../../../src/server/config/index.js';
import { runMigrations } from '../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('auth middleware', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let practiceId: string;
  let adminRoleId: string;

  beforeAll(async () => {
    const setupPool = new pg.Pool({ connectionString: TEST_DB_URL });
    await setupPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await setupPool.end();

    await runMigrations(TEST_DB_URL);

    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    const config = parseConfig({
      DATABASE_URL: TEST_DB_URL,
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long-for-validation',
    });

    const appResult = createApp({ pool, config });
    app = appResult.app;
    authService = appResult.authService;

    const result = await pool.query(
      "INSERT INTO practices (name) VALUES ('Auth Test') RETURNING id"
    );
    practiceId = result.rows[0].id;

    const adminRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [practiceId, ['admin:users', 'admin:settings', 'patients:read', 'patients:write',
                    'appointments:read', 'appointments:write']]
    );
    adminRoleId = adminRole.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('rejects requests without authentication', async () => {
    const res = await app.request('/api/patients');
    expect(res.status).toBe(401);
  });

  it('rejects invalid JWT', async () => {
    const res = await app.request('/api/patients', {
      headers: { Authorization: 'Bearer invalid-token' },
    });
    expect(res.status).toBe(401);
  });

  it('allows requests with valid JWT', async () => {
    await authService.createUser(practiceId, {
      email: 'mw-test@test.com',
      password: 'securepass123',
      fullName: 'MW Test',
      roleIds: [adminRoleId],
      isProvider: false,
      serviceLineIds: [],
    });
    const { accessToken } = await authService.login({
      email: 'mw-test@test.com',
      password: 'securepass123',
      practiceId,
    });

    const res = await app.request('/api/patients', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('allows requests with valid API key', async () => {
    const agentUser = await authService.createUser(practiceId, {
      email: 'agent-mw@agent.local',
      password: 'securepass123',
      fullName: 'Agent MW',
      roleIds: [],
      isProvider: false,
      serviceLineIds: [],
    });
    const { rawKey } = await authService.createAgentKey(practiceId, agentUser.id, {
      name: 'mw-agent',
      modelType: 'local',
      scopes: ['patients:read'],
    });

    const res = await app.request('/api/patients', {
      headers: { 'X-API-Key': rawKey },
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 3: Update smoke.test.ts**

```typescript
// tests/server/integration/smoke.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../src/server/app.js';
import { parseConfig } from '../../../src/server/config/index.js';
import { runMigrations } from '../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('OSOD smoke test', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let practiceId: string;
  let adminRoleId: string;
  let accessToken: string;

  beforeAll(async () => {
    const setupPool = new pg.Pool({ connectionString: TEST_DB_URL });
    await setupPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await setupPool.end();

    await runMigrations(TEST_DB_URL);

    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    const config = parseConfig({
      DATABASE_URL: TEST_DB_URL,
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long-for-validation',
    });

    const appResult = createApp({ pool, config });
    app = appResult.app;
    authService = appResult.authService;

    const result = await pool.query(
      "INSERT INTO practices (name) VALUES ('Test Practice') RETURNING id"
    );
    practiceId = result.rows[0].id;

    // Create admin role
    const adminRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [practiceId, ['admin:users', 'admin:settings', 'patients:read', 'patients:write',
                    'appointments:read', 'appointments:write']]
    );
    adminRoleId = adminRole.rows[0].id;

    await authService.createUser(practiceId, {
      email: 'admin@test.com',
      password: 'securepass123',
      fullName: 'Admin User',
      roleIds: [adminRoleId],
      isProvider: false,
      serviceLineIds: [],
    });

    const tokens = await authService.login({
      email: 'admin@test.com',
      password: 'securepass123',
      practiceId,
    });
    accessToken = tokens.accessToken;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('GET /health returns ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('POST /api/auth/login returns tokens', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@test.com',
        password: 'securepass123',
        practiceId,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });

  it('POST /api/auth/login rejects bad password', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@test.com',
        password: 'wrongpassword',
        practiceId,
      }),
    });
    expect(res.status).toBe(401);
  });

  it('protected routes reject unauthenticated requests', async () => {
    const res = await app.request('/api/patients');
    expect(res.status).toBe(401);
  });

  it('protected routes accept valid JWT', async () => {
    const res = await app.request('/api/patients', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/auth/refresh rotates tokens', async () => {
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@test.com',
        password: 'securepass123',
        practiceId,
      }),
    });
    const { refreshToken } = await loginRes.json();

    const res = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });
});
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (migration-v2 + auth + middleware + smoke + existing)

- [ ] **Step 5: Commit**

```bash
git add tests/server/modules/auth/auth.test.ts tests/server/middleware/auth.test.ts tests/server/integration/smoke.test.ts
git commit -m "test: update all tests for permission-based auth model"
```

---

## Task 8: Update Seed Script with Real IVA Data

**Files:**
- Modify: `scripts/seed.ts`

- [ ] **Step 1: Rewrite seed script with roles, patient fields, treatment library presets**

Replace the full `scripts/seed.ts`:

```typescript
import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://osod:osod_dev@localhost:5432/osod';

async function seed() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  // Check if already seeded
  const existing = await pool.query('SELECT COUNT(*) FROM practices');
  if (parseInt(existing.rows[0].count) > 0) {
    console.log('Database already seeded. Drop and re-migrate to re-seed.');
    await pool.end();
    return;
  }

  console.log('Seeding OSOD development database...');

  // 1. Practice
  const practice = await pool.query(
    `INSERT INTO practices (name, schedule_block_minutes, timezone)
     VALUES ('IVA — Integrated Vision & Aesthetics', 15, 'America/Chicago')
     RETURNING id`
  );
  const practiceId = practice.rows[0].id;
  console.log(`  Practice: ${practiceId}`);

  // 2. Service lines
  const eyecare = await pool.query(
    `INSERT INTO service_lines (practice_id, name, color, sort_order)
     VALUES ($1, 'Eyecare', '#2563EB', 1) RETURNING id`,
    [practiceId]
  );
  const aesthetics = await pool.query(
    `INSERT INTO service_lines (practice_id, name, color, sort_order)
     VALUES ($1, 'Aesthetics', '#DB2777', 2) RETURNING id`,
    [practiceId]
  );
  const eyecareId = eyecare.rows[0].id;
  const aestheticsId = aesthetics.rows[0].id;
  console.log(`  Service lines: Eyecare (${eyecareId}), Aesthetics (${aestheticsId})`);

  // 3. Role templates (Decision 4: tag-based permissions)
  const roles: Record<string, string> = {};
  const roleData = [
    ['Admin', ['admin:users', 'admin:settings', 'patients:read', 'patients:write', 'patients:delete',
               'appointments:read', 'appointments:write', 'billing:read', 'billing:submit', 'billing:void',
               'clinical:read', 'clinical:write', 'images:read', 'images:write', 'images:delete',
               'inventory:read', 'inventory:adjust', 'reports:read', 'reports:export'], true],
    ['Provider', ['patients:read', 'patients:write', 'appointments:read', 'appointments:write',
                  'clinical:read', 'clinical:write', 'images:read', 'images:write',
                  'billing:read', 'reports:read'], true],
    ['Front Desk', ['patients:read', 'patients:write', 'appointments:read', 'appointments:write',
                    'billing:read'], true],
    ['Optician', ['patients:read', 'appointments:read', 'inventory:read', 'inventory:adjust'], true],
    ['Aesthetician', ['patients:read', 'clinical:read', 'clinical:write',
                      'images:read', 'images:write', 'appointments:read'], true],
    ['Tech', ['patients:read', 'appointments:read', 'clinical:read'], true],
    ['Biller', ['patients:read', 'billing:read', 'billing:submit', 'billing:void',
                'reports:read', 'reports:export'], true],
  ] as const;

  for (const [name, perms, isSystem] of roleData) {
    const result = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [practiceId, name, perms, isSystem]
    );
    roles[name as string] = result.rows[0].id;
  }
  console.log(`  Roles: ${Object.keys(roles).join(', ')}`);

  // 4. Users
  const adminHash = await bcrypt.hash('admin123!', 12);
  const staffHash = await bcrypt.hash('staff123!', 12);

  // Eric — Admin + Provider (eyecare + aesthetics)
  const eric = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider, service_line_ids)
     VALUES ($1, 'eric@iva.com', $2, 'Dr. Eric Bang', true, $3) RETURNING id`,
    [practiceId, adminHash, [eyecareId, aestheticsId]]
  );
  await pool.query(`INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`, [eric.rows[0].id, roles['Admin']]);
  await pool.query(`INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`, [eric.rows[0].id, roles['Provider']]);

  // Hannah — Front Desk + Optician + Aesthetician (cross-trained)
  const hannah = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider, service_line_ids)
     VALUES ($1, 'hannah@iva.com', $2, 'Hannah Bang', false, $3) RETURNING id`,
    [practiceId, staffHash, [eyecareId, aestheticsId]]
  );
  await pool.query(`INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`, [hannah.rows[0].id, roles['Front Desk']]);
  await pool.query(`INSERT INTO user_role_assignments (user_id, role_id, service_line_id) VALUES ($1, $2, $3)`, [hannah.rows[0].id, roles['Optician'], eyecareId]);
  await pool.query(`INSERT INTO user_role_assignments (user_id, role_id, service_line_id) VALUES ($1, $2, $3)`, [hannah.rows[0].id, roles['Aesthetician'], aestheticsId]);

  // Associate provider (eyecare only)
  const drSmith = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider, service_line_ids)
     VALUES ($1, 'smith@iva.com', $2, 'Dr. Smith', true, $3) RETURNING id`,
    [practiceId, staffHash, [eyecareId]]
  );
  await pool.query(`INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)`, [drSmith.rows[0].id, roles['Provider']]);

  console.log(`  Users: Eric (admin+provider), Hannah (FD+optician+aesthetician), Dr. Smith (provider)`);

  // 5. Agent key
  const localAgentUser = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider)
     VALUES ($1, 'local-agent@agent.local', NULL, 'Local Scheduling Agent', false) RETURNING id`,
    [practiceId]
  );
  const localKey = `osod_${crypto.randomBytes(32).toString('hex')}`;
  const localKeyHash = await bcrypt.hash(localKey, 12);
  await pool.query(
    `INSERT INTO agent_keys (practice_id, user_id, key_hash, name, model_type, scopes)
     VALUES ($1, $2, $3, 'local-scheduler', 'local', $4)`,
    [practiceId, localAgentUser.rows[0].id, localKeyHash, ['patients:read', 'appointments:read', 'appointments:write']]
  );
  console.log(`  Local agent key: ${localKey}`);

  // 6. Treatment library presets (sample — Decision 1)
  const libraryPresets = [
    // Eyecare
    ['Comprehensive Exam — New Patient', 'Routine Examinations', null, 45, ['99203', '99204', '92004'], ['phoropter', 'slit_lamp', 'bio', 'autorefractor'], ['Provider'], ['eyecare'], false, '#2563EB'],
    ['Comprehensive Exam — Established', 'Routine Examinations', null, 30, ['99213', '99214', '92014'], ['phoropter', 'slit_lamp', 'bio', 'autorefractor'], ['Provider'], ['eyecare'], false, '#2563EB'],
    ['Contact Lens Fit — Soft', 'Contact Lens Services', 'Soft Lenses', 30, ['92310'], ['keratometer', 'slit_lamp'], ['Provider'], ['eyecare'], false, '#059669'],
    ['Contact Lens Fit — Scleral', 'Contact Lens Services', 'Specialty Lenses', 60, ['92313'], ['topographer', 'slit_lamp', 'oct'], ['Provider'], ['eyecare'], false, '#059669'],
    ['Contact Lens Fit — Ortho-K', 'Contact Lens Services', 'Specialty Lenses', 60, ['92313'], ['topographer', 'slit_lamp'], ['Provider'], ['eyecare'], false, '#059669'],
    ['Visual Field — Threshold 24-2', 'Diagnostic Testing', null, 20, ['92083'], ['visual_field'], ['Tech', 'Provider'], ['eyecare'], false, '#6366F1'],
    ['OCT — Retinal/Macula', 'Diagnostic Testing', null, 15, ['92134'], ['oct'], ['Tech', 'Provider'], ['eyecare'], false, '#6366F1'],
    ['OCT — Optic Nerve/RNFL', 'Diagnostic Testing', null, 15, ['92133'], ['oct'], ['Tech', 'Provider'], ['eyecare'], false, '#6366F1'],
    ['Dry Eye Evaluation', 'Medical Eye Care', 'Dry Eye', 30, ['99213', '99214'], ['slit_lamp', 'meibographer'], ['Provider'], ['eyecare'], false, '#D97706'],
    ['Glaucoma Management', 'Medical Eye Care', 'Glaucoma', 30, ['99214', '92083', '92133'], ['slit_lamp', 'visual_field', 'oct'], ['Provider'], ['eyecare'], false, '#DC2626'],
    ['Vision Therapy Session', 'Vision Therapy', null, 45, ['92065'], [], ['Provider', 'Tech'], ['eyecare'], false, '#7C3AED'],
    ['Myopia Management Eval', 'Myopia Management', null, 45, ['92004'], ['biometer', 'topographer'], ['Provider'], ['eyecare'], false, '#0891B2'],
    // Aesthetics
    ['Neurotoxin Injection', 'Injectables', 'Neurotoxin', 30, ['64615', 'J0585'], [], ['Provider'], ['aesthetics'], true, '#DB2777'],
    ['Dermal Filler', 'Injectables', 'Filler', 45, ['11950', '11951'], [], ['Provider'], ['aesthetics'], true, '#E11D48'],
    ['IPL Treatment', 'Light & Energy', 'IPL', 30, ['17999'], ['ipl'], ['Provider', 'Aesthetician'], ['aesthetics', 'eyecare'], true, '#F59E0B'],
    ['RF Microneedling', 'Skin Rejuvenation', null, 60, ['17999'], ['rf_microneedling'], ['Provider', 'Aesthetician'], ['aesthetics'], true, '#EF4444'],
    ['Chemical Peel', 'Skin Rejuvenation', 'Peels', 30, ['17999'], [], ['Provider', 'Aesthetician'], ['aesthetics'], false, '#F59E0B'],
    ['HydraFacial', 'Skin Rejuvenation', 'Facials', 45, [], ['hydrafacial'], ['Aesthetician'], ['aesthetics'], false, '#8B5CF6'],
    ['Laser Hair Removal', 'Light & Energy', 'Laser', 30, ['17999'], ['laser_hair'], ['Provider', 'Aesthetician'], ['aesthetics'], true, '#EF4444'],
    ['Skin Consultation', 'Consultations', null, 30, ['99201'], [], ['Provider', 'Aesthetician'], ['aesthetics'], false, '#8B5CF6'],
  ] as const;

  for (const [name, category, subcategory, duration, cpt, equip, scope, lines, bodyArea, color] of libraryPresets) {
    await pool.query(
      `INSERT INTO treatment_library (standard_name, category, subcategory, typical_duration_minutes,
         cpt_codes, equipment_tags, provider_scope, service_lines, body_area_modifiers_available, default_color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [name, category, subcategory, duration, cpt, equip, scope, lines, bodyArea, color]
    );
  }
  console.log(`  Treatment library: ${libraryPresets.length} presets`);

  // 7. Body-area modifiers (system-level, Decision 1)
  const bodyAreas = [
    ['Face', 'FACE', 0], ['Neck', 'NECK', 0], ['Decollete', 'DECO', 0],
    ['Hands', 'HAND', -10], ['Arms', 'ARMS', 0], ['Underarms', 'UARM', -15],
    ['Abdomen', 'ABDO', 15], ['Back', 'BACK', 15], ['Flanks', 'FLNK', 0],
    ['Buttocks', 'BUTT', 15], ['Thighs', 'THGH', 15], ['Bikini', 'BIKI', 0],
    ['Full Legs', 'LEGS', 30], ['Scalp', 'SCLP', 0],
    // Face sub-areas
    ['Forehead', 'FRHD', -10], ['Glabella', 'GLAB', -15],
    ['Periorbital', 'PERI', -10], ['Cheeks', 'CHEK', 0],
    ['Lips', 'LIPS', -15], ['Chin', 'CHIN', -10], ['Jawline', 'JAWL', 0],
  ];
  for (const [name, code, adj] of bodyAreas) {
    await pool.query(
      `INSERT INTO body_area_modifiers (name, short_code, duration_adjustment_minutes, is_system)
       VALUES ($1, $2, $3, true)`,
      [name, code, adj]
    );
  }
  console.log(`  Body-area modifiers: ${bodyAreas.length} system modifiers`);

  // 8. Practice appointment types (cloned from library with IVA display names)
  const ivaTypes = [
    // Eyecare
    ['Comprehensive Exam — New Patient', 'CE-NP', '#2563EB', 3, eyecareId, 'Comp Exam — New Patient', false],
    ['Comprehensive Exam — Established', 'CE-EP', '#2563EB', 2, eyecareId, 'Comp Exam — Established', false],
    ['Contact Lens Fit — Soft', 'CLF', '#059669', 2, eyecareId, null, false],
    ['Contact Lens Fit — Scleral', 'SL-FIT', '#059669', 4, eyecareId, null, false],
    ['Contact Lens Fit — Ortho-K', 'OK-FIT', '#059669', 4, eyecareId, null, false],
    ['Visual Field — Threshold 24-2', 'HVF', '#6366F1', 2, eyecareId, null, false],
    ['OCT — Retinal/Macula', 'OCT-R', '#6366F1', 1, eyecareId, null, false],
    ['OCT — Optic Nerve/RNFL', 'OCT-N', '#6366F1', 1, eyecareId, null, false],
    ['Dry Eye Evaluation', 'DRY', '#D97706', 2, eyecareId, null, false],
    ['Glaucoma Management', 'GLC', '#DC2626', 2, eyecareId, null, false],
    ['Vision Therapy Session', 'VT', '#7C3AED', 3, eyecareId, null, false],
    ['Myopia Management Eval', 'MM', '#0891B2', 3, eyecareId, null, false],
    // Aesthetics (with IVA display names)
    ['Neurotoxin Injection', 'BTX', '#DB2777', 2, aestheticsId, null, false],
    ['Dermal Filler', 'FIL', '#E11D48', 3, aestheticsId, null, false],
    ['IPL Treatment', 'IPL', '#F59E0B', 2, aestheticsId, 'OptiLight IPL', false],
    ['RF Microneedling', 'RFMN', '#EF4444', 4, aestheticsId, 'Morpheus8', false],
    ['Chemical Peel', 'PEEL', '#F59E0B', 2, aestheticsId, null, false],
    ['HydraFacial', 'HF', '#8B5CF6', 3, aestheticsId, 'Diamond HydroFacial', false],
    ['Laser Hair Removal', 'LHR', '#EF4444', 2, aestheticsId, null, false],
    ['Skin Consultation', 'CONS', '#8B5CF6', 2, aestheticsId, null, false],
  ] as const;

  for (const [libName, shortName, color, blocks, slId, displayName, isCustom] of ivaTypes) {
    // Look up library_id
    const lib = await pool.query(
      `SELECT id FROM treatment_library WHERE standard_name = $1 LIMIT 1`,
      [libName]
    );
    const libraryId = lib.rows[0]?.id ?? null;

    await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks,
         library_id, display_name, service_line_ids, is_custom)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [practiceId, slId, libName, shortName, color, blocks,
       libraryId, displayName || libName, [slId], isCustom]
    );
  }
  console.log(`  Appointment types: ${ivaTypes.length} IVA types (linked to treatment library)`);

  // 9. Provider schedules (Mon-Fri)
  for (let day = 1; day <= 5; day++) {
    // Eric: mornings eyecare, afternoons aesthetics
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '08:00', '12:00', $3)`,
      [eric.rows[0].id, day, eyecareId]
    );
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '13:00', '17:00', $3)`,
      [eric.rows[0].id, day, aestheticsId]
    );
    // Dr. Smith: all day eyecare
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '08:00', '17:00', $3)`,
      [drSmith.rows[0].id, day, eyecareId]
    );
  }
  console.log('  Provider schedules: Mon-Fri for Eric + Dr. Smith');

  // 10. Sample patients with new fields (Decision 2)
  const patientData = [
    ['James', 'R', 'Johnson', '1965-03-15', 'M', 'Manufacturing', 'Engineer', ['fishing', 'golf']],
    ['Maria', 'L', 'Williams', '1978-07-22', 'F', 'Greenwood Schools', 'Teacher', ['reading', 'gardening']],
    ['Robert', null, 'Brown', '1955-11-03', 'M', 'Retired', 'Retired', ['woodworking']],
    ['Linda', 'A', 'Jones', '1982-09-10', 'F', 'Self-Employed', 'Realtor', ['tennis', 'running']],
    ['Michael', 'J', 'Garcia', '1990-04-28', 'M', 'Tech Corp', 'Software Developer', ['gaming', 'cycling']],
    ['Sarah', 'K', 'Miller', '1973-12-01', 'F', 'Hospital', 'Nurse', ['yoga']],
    ['David', null, 'Davis', '1988-06-17', 'M', 'Construction Co', 'Foreman', ['hunting', 'fishing']],
    ['Jennifer', 'M', 'Rodriguez', '1995-02-14', 'F', 'University', 'Student', ['volleyball']],
    ['William', 'T', 'Martinez', '1960-08-30', 'M', 'Retired Military', 'Retired', ['golf', 'reading']],
    ['Patricia', null, 'Anderson', '1985-05-25', 'F', 'Law Firm', 'Paralegal', ['hiking']],
    // Minor — needs responsible party
    ['Emma', 'R', 'Johnson', '2015-09-12', 'F', null, 'Student', []],
  ];

  const patientIds: string[] = [];
  for (let i = 0; i < patientData.length; i++) {
    const [first, middle, last, dob, sex, employer, occupation, hobbies] = patientData[i];
    const result = await pool.query(
      `INSERT INTO patients (practice_id, first_name, middle_name, last_name, date_of_birth, sex,
         phone_primary, address_line1, city, state, zip, employer, occupation, hobbies)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [practiceId, first, middle, last, dob, sex,
       `555-${String(1000 + i).padStart(4, '0')}`, `${100 + i} Main St`, 'Edmond', 'OK', '73034',
       employer, occupation, hobbies]
    );
    patientIds.push(result.rows[0].id);
  }
  console.log(`  Patients: ${patientData.length} created (including 1 minor)`);

  // 11. Responsible party — Emma is James's daughter (Decision 3)
  await pool.query(
    `INSERT INTO responsible_parties (patient_id, responsible_party_patient_id, relationship,
       is_financial_responsible, is_consent_authority, is_insurance_subscriber, is_primary)
     VALUES ($1, $2, 'parent', true, true, true, true)`,
    [patientIds[10], patientIds[0]]  // Emma -> James
  );
  console.log('  Responsible parties: Emma Johnson → James Johnson (parent)');

  // 12. Insurance (first 5 patients get vision)
  for (let i = 0; i < 5; i++) {
    await pool.query(
      `INSERT INTO patient_insurance (patient_id, priority, plan_type, payer_name, member_id, effective_date)
       VALUES ($1, 1, 'vision', $2, $3, '2026-01-01')`,
      [patientIds[i], i % 2 === 0 ? 'VSP' : 'EyeMed', `MEM${String(10000 + i)}`]
    );
  }
  console.log('  Insurance: 5 patients with vision plans');

  // 13. Alerts
  await pool.query(
    `INSERT INTO patient_alerts (patient_id, alert_type, severity, message, created_by)
     VALUES ($1, 'allergy', 'critical', 'Sulfa allergy — do NOT prescribe sulfonamide antibiotics', $2)`,
    [patientIds[0], eric.rows[0].id]
  );
  await pool.query(
    `INSERT INTO patient_alerts (patient_id, alert_type, severity, message, created_by)
     VALUES ($1, 'balance', 'warning', 'Outstanding balance: $245.00 — collect before scheduling', $2)`,
    [patientIds[3], eric.rows[0].id]
  );
  console.log('  Alerts: 2 sample alerts');

  console.log('\nSeed complete!');
  console.log('\nLogin credentials:');
  console.log('  Admin: eric@iva.com / admin123!');
  console.log('  Staff: hannah@iva.com / staff123!');
  console.log(`  Agent key: ${localKey}`);

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Test the seed script runs without errors**

Run: `npm run db:migrate && npm run db:seed`
Expected: Seed completes with no errors, shows all created entities

- [ ] **Step 3: Commit**

```bash
git add scripts/seed.ts
git commit -m "feat: update seed with real IVA data — roles, treatment library, body-area modifiers, patient fields, responsible parties"
```

---

## Task 9: Run Full Test Suite + Verify

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All test files PASS

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Test seed on fresh DB**

Run: `psql postgresql://osod:osod_dev@localhost:5432/osod -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" && npm run db:migrate && npm run db:seed`
Expected: Migration applies, seed completes

- [ ] **Step 4: Verify seed data**

Run: `psql postgresql://osod:osod_dev@localhost:5432/osod -c "SELECT name, permission_set FROM user_roles ORDER BY name;"`
Expected: 7 roles with permission arrays

Run: `psql postgresql://osod:osod_dev@localhost:5432/osod -c "SELECT standard_name, category, service_lines FROM treatment_library ORDER BY category, standard_name;"`
Expected: 20 treatment library presets

Run: `psql postgresql://osod:osod_dev@localhost:5432/osod -c "SELECT p.first_name, p.last_name, rp.relationship FROM responsible_parties rp JOIN patients p ON p.id = rp.responsible_party_patient_id;"`
Expected: James Johnson as parent

- [ ] **Step 5: Final commit if any fixes needed, then summary commit**

```bash
git add -A
git commit -m "feat: schema v2 complete — treatment library, patient fields, permissions, guardian linking, aesthetics-fork ready

Implements all 5 decisions from performance-od/decisions/2026-04-07-osod-treatment-library-schema-decisions.md:
- Decision 1: 3-layer treatment library (presets + body-area modifiers + practice customization)
- Decision 2: Patient schema additions (SSN encrypted, employer, occupation, hobbies, referring provider, race/ethnicity)
- Decision 3: responsible_parties table (guardian-minor financial/consent/insurance linking)
- Decision 4: Tag-based permission model (user_roles + user_role_assignments, replaces rigid 4-role enum)
- Decision 5: Aesthetics forkable via service_line activation (no code fork needed)"
```
