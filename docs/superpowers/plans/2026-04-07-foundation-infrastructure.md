# OSOD Foundation Infrastructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the OSOD server infrastructure — Docker, database, Hono server, event bus, middleware pipeline, auth system — so that domain modules (patients, scheduling) can be built on a solid, tested foundation.

**Architecture:** Hono server on Node.js with PostgreSQL. In-process typed event bus behind an interface. JWT auth for humans, API keys for agents. Append-only audit trail via event subscription. All config Zod-validated. TDD throughout.

**Tech Stack:** TypeScript (strict), Hono, @hono/node-server, @hono/zod-validator, Zod, PostgreSQL (pg), jose (JWT), bcryptjs, Vitest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-04-07-osod-foundation-design.md`

---

## File Structure

```
osod/
├── package.json                          # UPDATE: swap Express → Hono, add deps
├── tsconfig.json                         # UPDATE: add path aliases
├── vitest.config.ts                      # CREATE: Vitest configuration
├── .env.example                          # CREATE: environment variable template
├── docker/
│   └── docker-compose.yml                # CREATE: PostgreSQL + Orthanc (profiled)
│
├── src/
│   └── server/
│       ├── index.ts                      # CREATE: entry point (starts server)
│       ├── app.ts                        # CREATE: Hono app factory (testable)
│       │
│       ├── config/
│       │   └── index.ts                  # CREATE: Zod-validated env config
│       │
│       ├── db/
│       │   ├── pool.ts                   # CREATE: PostgreSQL connection pool
│       │   ├── migrate.ts                # CREATE: migration runner
│       │   └── migrations/
│       │       └── 001_foundation.sql    # CREATE: all Phase 1 tables
│       │
│       ├── events/
│       │   ├── bus.ts                    # CREATE: DomainEventBus interface + InProcessEventBus
│       │   ├── types.ts                  # CREATE: domain event type definitions
│       │   └── handlers/
│       │       └── audit.handler.ts      # CREATE: audit trail subscriber
│       │
│       ├── middleware/
│       │   ├── auth.ts                   # CREATE: JWT + API key validation
│       │   ├── audit.ts                  # CREATE: request-level PHI audit logging
│       │   ├── cors.ts                   # CREATE: CORS configuration
│       │   └── rate-limit.ts             # CREATE: in-memory rate limiting
│       │
│       └── modules/
│           └── auth/
│               ├── routes.ts             # CREATE: login, refresh, API key endpoints
│               ├── schemas.ts            # CREATE: Zod schemas for auth payloads
│               └── service.ts            # CREATE: auth business logic
│
├── scripts/
│   └── seed.ts                           # CREATE: development seed data
│
└── tests/
    └── server/
        ├── config/
        │   └── config.test.ts            # CREATE: config validation tests
        ├── db/
        │   └── pool.test.ts              # CREATE: DB connection tests
        ├── events/
        │   ├── bus.test.ts               # CREATE: event bus tests
        │   └── audit.handler.test.ts     # CREATE: audit handler tests
        ├── middleware/
        │   ├── auth.test.ts              # CREATE: auth middleware tests
        │   └── rate-limit.test.ts        # CREATE: rate limiter tests
        └── modules/
            └── auth/
                └── auth.test.ts          # CREATE: auth routes integration tests
```

---

### Task 1: Dependencies and Build Config

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `.env.example`

- [ ] **Step 1: Update package.json**

Replace the full `package.json` contents:

```json
{
  "name": "osod",
  "version": "0.1.0",
  "description": "Open Source OD — practice management for independent clinical practices",
  "private": true,
  "type": "module",
  "license": "AGPL-3.0-or-later",
  "scripts": {
    "dev": "tsx watch src/server/index.ts",
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:migrate": "tsx src/server/db/migrate.ts",
    "db:seed": "tsx scripts/seed.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.0",
    "@hono/zod-validator": "^0.4.0",
    "bcryptjs": "^2.4.3",
    "hono": "^4.6.0",
    "jose": "^5.9.0",
    "pg": "^8.13.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

Key changes from original:
- Added `"type": "module"` for ESM
- Swapped `express` + `@types/express` → `hono` + `@hono/node-server` + `@hono/zod-validator`
- Added `bcryptjs`, `jose` for auth
- Removed React/Vite/concurrently (frontend is a later plan)
- Simplified scripts (no frontend dev server yet)

- [ ] **Step 2: Update tsconfig.json**

Replace `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*", "tests/**/*", "scripts/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Changes: removed `jsx` (no frontend yet), added `tests/**/*` and `scripts/**/*` to `include`, added `resolveJsonModule` and `isolatedModules`.

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 4: Create .env.example**

```bash
# Database
DATABASE_URL=postgresql://osod:osod_dev@localhost:5432/osod

# Auth
JWT_SECRET=change-me-in-production-use-64-chars-minimum-random-string-here
JWT_EXPIRY=1h
REFRESH_TOKEN_EXPIRY=7d

# Server
PORT=3000
HOST=localhost
NODE_ENV=development

# Rate limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_AGENT_MAX_REQUESTS=500
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: Clean install, `node_modules` created, no peer dependency warnings that block functionality.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (no source files yet, just config validation).

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example package-lock.json
git commit -m "feat: initialize project deps — Hono, pg, Zod, jose, bcryptjs, Vitest"
```

---

### Task 2: Docker Compose

**Files:**
- Create: `docker/docker-compose.yml`
- Create: `.gitignore` update (if needed)

- [ ] **Step 1: Create docker/docker-compose.yml**

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: osod
      POSTGRES_USER: osod
      POSTGRES_PASSWORD: osod_dev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U osod"]
      interval: 5s
      timeout: 5s
      retries: 5

  db-test:
    image: postgres:16
    environment:
      POSTGRES_DB: osod_test
      POSTGRES_USER: osod
      POSTGRES_PASSWORD: osod_dev
    ports:
      - "5433:5432"
    tmpfs:
      - /var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U osod"]
      interval: 5s
      timeout: 5s
      retries: 5

  orthanc:
    image: orthancteam/orthanc:24.12.1
    ports:
      - "8042:8042"
      - "4242:4242"
    volumes:
      - orthanc_data:/var/lib/orthanc/db
    environment:
      ORTHANC__REGISTERED_USERS: '{"osod": "osod_dev"}'
    profiles:
      - equipment

volumes:
  pgdata:
  orthanc_data:
```

Notes: `db-test` uses `tmpfs` for fast disposable test databases. Orthanc is behind the `equipment` profile — not started by default.

- [ ] **Step 2: Start the database**

Run: `docker compose -f docker/docker-compose.yml up -d db db-test`
Expected: Both PostgreSQL containers start and pass healthcheck.

Run: `docker compose -f docker/docker-compose.yml ps`
Expected: `db` and `db-test` both show "healthy".

- [ ] **Step 3: Verify connectivity**

Run: `PGPASSWORD=osod_dev psql -h localhost -p 5432 -U osod -d osod -c "SELECT 1;"`
Expected: Returns `1`.

Run: `PGPASSWORD=osod_dev psql -h localhost -p 5433 -U osod -d osod_test -c "SELECT 1;"`
Expected: Returns `1`.

- [ ] **Step 4: Commit**

```bash
git add docker/docker-compose.yml
git commit -m "infra: add Docker Compose — PostgreSQL dev + test, Orthanc behind profile"
```

---

### Task 3: Config System

**Files:**
- Create: `src/server/config/index.ts`
- Create: `tests/server/config/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/config/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseConfig, type Config } from '../../../src/server/config/index.js';

describe('parseConfig', () => {
  it('parses valid environment variables', () => {
    const env = {
      DATABASE_URL: 'postgresql://osod:osod_dev@localhost:5432/osod',
      JWT_SECRET: 'a'.repeat(64),
      PORT: '3000',
    };

    const config = parseConfig(env);
    expect(config.databaseUrl).toBe(env.DATABASE_URL);
    expect(config.jwtSecret).toBe(env.JWT_SECRET);
    expect(config.port).toBe(3000);
  });

  it('applies defaults for optional fields', () => {
    const env = {
      DATABASE_URL: 'postgresql://osod:osod_dev@localhost:5432/osod',
      JWT_SECRET: 'a'.repeat(64),
    };

    const config = parseConfig(env);
    expect(config.port).toBe(3000);
    expect(config.host).toBe('localhost');
    expect(config.nodeEnv).toBe('development');
    expect(config.jwtExpiry).toBe('1h');
    expect(config.refreshTokenExpiry).toBe('7d');
    expect(config.rateLimitWindowMs).toBe(60_000);
    expect(config.rateLimitMaxRequests).toBe(100);
    expect(config.rateLimitAgentMaxRequests).toBe(500);
  });

  it('throws on missing DATABASE_URL', () => {
    const env = { JWT_SECRET: 'a'.repeat(64) };
    expect(() => parseConfig(env)).toThrow();
  });

  it('throws on missing JWT_SECRET', () => {
    const env = { DATABASE_URL: 'postgresql://localhost/osod' };
    expect(() => parseConfig(env)).toThrow();
  });

  it('coerces PORT to number', () => {
    const env = {
      DATABASE_URL: 'postgresql://localhost/osod',
      JWT_SECRET: 'a'.repeat(64),
      PORT: '8080',
    };

    const config = parseConfig(env);
    expect(config.port).toBe(8080);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/config/config.test.ts`
Expected: FAIL — cannot find module `../../../src/server/config/index.js`.

- [ ] **Step 3: Write the implementation**

Create `src/server/config/index.ts`:

```typescript
import { z } from 'zod';

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY: z.string().default('1h'),
  REFRESH_TOKEN_EXPIRY: z.string().default('7d'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('localhost'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_AGENT_MAX_REQUESTS: z.coerce.number().int().positive().default(500),
});

export interface Config {
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiry: string;
  refreshTokenExpiry: string;
  port: number;
  host: string;
  nodeEnv: 'development' | 'production' | 'test';
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  rateLimitAgentMaxRequests: number;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = configSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    jwtSecret: parsed.JWT_SECRET,
    jwtExpiry: parsed.JWT_EXPIRY,
    refreshTokenExpiry: parsed.REFRESH_TOKEN_EXPIRY,
    port: parsed.PORT,
    host: parsed.HOST,
    nodeEnv: parsed.NODE_ENV,
    rateLimitWindowMs: parsed.RATE_LIMIT_WINDOW_MS,
    rateLimitMaxRequests: parsed.RATE_LIMIT_MAX_REQUESTS,
    rateLimitAgentMaxRequests: parsed.RATE_LIMIT_AGENT_MAX_REQUESTS,
  };
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = parseConfig(process.env);
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/config/config.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/config/index.ts tests/server/config/config.test.ts
git commit -m "feat: add Zod-validated config system with defaults and type-safe access"
```

---

### Task 4: Database Pool and Migration Runner

**Files:**
- Create: `src/server/db/pool.ts`
- Create: `src/server/db/migrate.ts`
- Create: `tests/server/db/pool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/db/pool.test.ts`:

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { createPool } from '../../../src/server/db/pool.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5433/osod_test';

describe('createPool', () => {
  it('connects to PostgreSQL and runs a query', async () => {
    const pool = createPool(TEST_DB_URL);
    const result = await pool.query('SELECT 1 AS value');
    expect(result.rows[0].value).toBe(1);
    await pool.end();
  });

  it('rejects invalid connection strings', async () => {
    const pool = createPool('postgresql://bad:bad@localhost:9999/nope');
    await expect(pool.query('SELECT 1')).rejects.toThrow();
    await pool.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/db/pool.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write pool.ts**

Create `src/server/db/pool.ts`:

```typescript
import pg from 'pg';

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/db/pool.test.ts`
Expected: Both tests PASS. (Requires `db-test` Docker container running on port 5433.)

- [ ] **Step 5: Write the migration runner**

Create `src/server/db/migrate.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export async function runMigrations(databaseUrl: string): Promise<string[]> {
  const pool = createPool(databaseUrl);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = await pool.query('SELECT name FROM _migrations ORDER BY id');
  const appliedNames = new Set(applied.rows.map((r: { name: string }) => r.name));

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];

  for (const file of files) {
    if (appliedNames.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await pool.query('COMMIT');
      newlyApplied.push(file);
      console.log(`Applied migration: ${file}`);
    } catch (err) {
      await pool.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err}`);
    }
  }

  await pool.end();
  return newlyApplied;
}

// CLI entry point
const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/.*\//, ''));
if (isMain) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }
  runMigrations(databaseUrl)
    .then(applied => {
      if (applied.length === 0) console.log('No new migrations to apply.');
      else console.log(`Applied ${applied.length} migration(s).`);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
```

- [ ] **Step 6: Commit**

```bash
git add src/server/db/pool.ts src/server/db/migrate.ts tests/server/db/pool.test.ts
git commit -m "feat: add PostgreSQL connection pool and migration runner"
```

---

### Task 5: Foundation SQL Migration

**Files:**
- Create: `src/server/db/migrations/001_foundation.sql`

- [ ] **Step 1: Create the migration**

Create `src/server/db/migrations/001_foundation.sql`:

```sql
-- OSOD Foundation Schema
-- All Phase 1 tables: practices, users, patients, scheduling, equipment, audit

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

---------------------------------------
-- PRACTICES
---------------------------------------
CREATE TABLE practices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  schedule_block_minutes INT NOT NULL DEFAULT 15
    CHECK (schedule_block_minutes IN (10, 15, 20, 30)),
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

---------------------------------------
-- SERVICE LINES
---------------------------------------
CREATE TABLE service_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3B82F6',
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_service_lines_practice ON service_lines(practice_id);

---------------------------------------
-- USERS
---------------------------------------
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  email TEXT NOT NULL,
  password_hash TEXT,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'provider', 'staff', 'agent')),
  is_provider BOOLEAN NOT NULL DEFAULT false,
  service_line_ids UUID[] NOT NULL DEFAULT '{}',
  permissions JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (practice_id, email)
);

CREATE INDEX idx_users_practice ON users(practice_id);

---------------------------------------
-- AGENT KEYS
---------------------------------------
CREATE TABLE agent_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  user_id UUID NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  model_type TEXT NOT NULL CHECK (model_type IN ('local', 'cloud')),
  scopes TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_keys_practice ON agent_keys(practice_id);

---------------------------------------
-- PATIENTS
---------------------------------------
CREATE TABLE patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  date_of_birth DATE NOT NULL,
  sex TEXT NOT NULL CHECK (sex IN ('M', 'F', 'X')),
  email TEXT,
  phone_primary TEXT NOT NULL,
  phone_secondary TEXT,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  preferred_pharmacy TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'en',
  communication_pref TEXT NOT NULL DEFAULT 'phone'
    CHECK (communication_pref IN ('email', 'phone', 'text', 'mail')),
  balance_cents INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patients_practice_name ON patients(practice_id, last_name, first_name);
CREATE INDEX idx_patients_practice_dob ON patients(practice_id, date_of_birth);

---------------------------------------
-- PATIENT INSURANCE
---------------------------------------
CREATE TABLE patient_insurance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  priority INT NOT NULL CHECK (priority BETWEEN 1 AND 3),
  plan_type TEXT NOT NULL CHECK (plan_type IN ('medical', 'vision')),
  payer_name TEXT NOT NULL,
  payer_id TEXT,
  member_id TEXT NOT NULL,
  group_number TEXT,
  subscriber_name TEXT,
  subscriber_dob DATE,
  subscriber_relationship TEXT NOT NULL DEFAULT 'self'
    CHECK (subscriber_relationship IN ('self', 'spouse', 'child', 'other')),
  effective_date DATE NOT NULL,
  termination_date DATE,
  copay_cents INT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patient_insurance_patient ON patient_insurance(patient_id);

---------------------------------------
-- PATIENT CONTACTS
---------------------------------------
CREATE TABLE patient_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL
    CHECK (contact_type IN ('emergency', 'responsible_party', 'guardian')),
  full_name TEXT NOT NULL,
  relationship TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patient_contacts_patient ON patient_contacts(patient_id);

---------------------------------------
-- PATIENT ALERTS
---------------------------------------
CREATE TABLE patient_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL
    CHECK (alert_type IN ('allergy', 'balance', 'clinical', 'scheduling', 'custom')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message TEXT NOT NULL,
  is_resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patient_alerts_patient ON patient_alerts(patient_id);

---------------------------------------
-- APPOINTMENT TYPES
---------------------------------------
CREATE TABLE appointment_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  service_line_id UUID NOT NULL REFERENCES service_lines(id),
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3B82F6',
  duration_blocks INT NOT NULL CHECK (duration_blocks > 0),
  default_reason TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_appointment_types_practice ON appointment_types(practice_id);

---------------------------------------
-- PROVIDER SCHEDULES
---------------------------------------
CREATE TABLE provider_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES users(id),
  day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  service_line_id UUID NOT NULL REFERENCES service_lines(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (start_time < end_time)
);

CREATE INDEX idx_provider_schedules_provider ON provider_schedules(provider_id);

---------------------------------------
-- SCHEDULE OVERRIDES
---------------------------------------
CREATE TABLE schedule_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES users(id),
  override_date DATE NOT NULL,
  override_type TEXT NOT NULL CHECK (override_type IN ('blocked', 'modified')),
  start_time TIME,
  end_time TIME,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_schedule_overrides_provider_date ON schedule_overrides(provider_id, override_date);

---------------------------------------
-- APPOINTMENTS
---------------------------------------
CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  patient_id UUID NOT NULL REFERENCES patients(id),
  provider_id UUID NOT NULL REFERENCES users(id),
  appointment_type_id UUID NOT NULL REFERENCES appointment_types(id),
  service_line_id UUID NOT NULL REFERENCES service_lines(id),
  start_time TIMESTAMPTZ NOT NULL,
  duration_blocks INT NOT NULL CHECK (duration_blocks > 0),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show')),
  chief_complaint TEXT,
  notes TEXT,
  cancelled_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  checked_in_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_appointments_provider_time ON appointments(provider_id, start_time);
CREATE INDEX idx_appointments_patient_time ON appointments(patient_id, start_time);
CREATE INDEX idx_appointments_practice_time_status ON appointments(practice_id, start_time, status);

---------------------------------------
-- EQUIPMENT REGISTRY
---------------------------------------
CREATE TABLE equipment_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  device_category TEXT NOT NULL
    CHECK (device_category IN ('oct', 'visual_field', 'autorefractor', 'phoropter', 'tonometer', 'retinal_camera', 'topographer', 'lensometer', 'meibographer', 'specialty', 'aesthetics')),
  integration_type TEXT NOT NULL
    CHECK (integration_type IN ('dicom', 'folder_watch', 'serial', 'manual')),
  connection_config JSONB NOT NULL DEFAULT '{}',
  location TEXT,
  data_types TEXT[] NOT NULL DEFAULT '{}',
  parser_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_equipment_registry_practice ON equipment_registry(practice_id);

---------------------------------------
-- DEVICE READINGS
---------------------------------------
CREATE TABLE device_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  equipment_id UUID NOT NULL REFERENCES equipment_registry(id),
  patient_id UUID REFERENCES patients(id),
  matched_by TEXT CHECK (matched_by IN ('mwl', 'room_assignment', 'manual', 'ai_match')),
  reading_type TEXT NOT NULL,
  structured_data JSONB NOT NULL DEFAULT '{}',
  raw_data_ref TEXT,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('dicom', 'folder_watch', 'serial', 'manual', 'ai_extraction')),
  confidence DECIMAL,
  needs_review BOOLEAN NOT NULL DEFAULT false,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_device_readings_patient ON device_readings(patient_id);
CREATE INDEX idx_device_readings_equipment ON device_readings(equipment_id);

---------------------------------------
-- AUDIT EVENTS (append-only)
---------------------------------------
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'access')),
  actor_id UUID NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'local_agent', 'cloud_agent')),
  model_name TEXT,
  confidence DECIMAL,
  ip_address TEXT,
  previous_state JSONB,
  new_state JSONB,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_events(actor_id, created_at);
CREATE INDEX idx_audit_time ON audit_events(created_at);

-- Prevent UPDATE and DELETE on audit_events
CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % operations are not allowed', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE TRIGGER audit_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
```

- [ ] **Step 2: Run the migration against dev database**

Run: `DATABASE_URL=postgresql://osod:osod_dev@localhost:5432/osod npx tsx src/server/db/migrate.ts`
Expected: `Applied migration: 001_foundation.sql`

- [ ] **Step 3: Verify tables exist**

Run: `PGPASSWORD=osod_dev psql -h localhost -p 5432 -U osod -d osod -c "\dt"`
Expected: Lists all 15 tables plus `_migrations`.

- [ ] **Step 4: Run migration against test database**

Run: `DATABASE_URL=postgresql://osod:osod_dev@localhost:5433/osod_test npx tsx src/server/db/migrate.ts`
Expected: `Applied migration: 001_foundation.sql`

- [ ] **Step 5: Verify audit immutability**

Run:
```bash
PGPASSWORD=osod_dev psql -h localhost -p 5432 -U osod -d osod -c "
  INSERT INTO practices (name) VALUES ('Test Practice');
  INSERT INTO audit_events (practice_id, entity_type, entity_id, action, actor_id, actor_type)
    VALUES ((SELECT id FROM practices LIMIT 1), 'test', gen_random_uuid(), 'create', gen_random_uuid(), 'human');
  UPDATE audit_events SET action = 'delete' WHERE TRUE;
"
```
Expected: The UPDATE fails with `audit_events is append-only: UPDATE operations are not allowed`.

- [ ] **Step 6: Clean up test data**

Run: `PGPASSWORD=osod_dev psql -h localhost -p 5432 -U osod -d osod -c "DELETE FROM audit_events; DELETE FROM practices;" 2>&1 || true`
Expected: audit_events DELETE blocked by trigger. That's correct — we need to drop and re-run migration for clean state, or just leave it (dev DB).

Actually, for a clean dev DB, just drop and recreate:
Run: `PGPASSWORD=osod_dev psql -h localhost -p 5432 -U osod -d osod -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`
Then re-run: `DATABASE_URL=postgresql://osod:osod_dev@localhost:5432/osod npx tsx src/server/db/migrate.ts`

- [ ] **Step 7: Commit**

```bash
git add src/server/db/migrations/001_foundation.sql
git commit -m "feat: add foundation schema — 15 tables, audit immutability trigger"
```

---

### Task 6: Domain Event Bus

**Files:**
- Create: `src/server/events/types.ts`
- Create: `src/server/events/bus.ts`
- Create: `tests/server/events/bus.test.ts`

- [ ] **Step 1: Write event types**

Create `src/server/events/types.ts`:

```typescript
export interface DomainEvent {
  id: string;
  type: string;
  timestamp: string;
  practiceId: string;
  actorId: string;
  actorType: 'human' | 'local_agent' | 'cloud_agent';
  entityType: string;
  entityId: string;
  payload: unknown;
  correlationId: string;
}

// Phase 1 event types
export interface PatientCreatedEvent extends DomainEvent {
  type: 'patient.created';
  entityType: 'patient';
  payload: { firstName: string; lastName: string };
}

export interface PatientUpdatedEvent extends DomainEvent {
  type: 'patient.updated';
  entityType: 'patient';
  payload: { changes: Record<string, unknown> };
}

export interface PatientAlertCreatedEvent extends DomainEvent {
  type: 'patient.alert.created';
  entityType: 'patient_alert';
  payload: { alertType: string; severity: string; message: string };
}

export interface PatientAlertResolvedEvent extends DomainEvent {
  type: 'patient.alert.resolved';
  entityType: 'patient_alert';
  payload: { resolvedBy: string };
}

export interface AppointmentScheduledEvent extends DomainEvent {
  type: 'appointment.scheduled';
  entityType: 'appointment';
  payload: { patientId: string; providerId: string; startTime: string };
}

export interface AppointmentStatusChangedEvent extends DomainEvent {
  type: 'appointment.status_changed';
  entityType: 'appointment';
  payload: { oldStatus: string; newStatus: string };
}

export interface AppointmentCancelledEvent extends DomainEvent {
  type: 'appointment.cancelled';
  entityType: 'appointment';
  payload: { reason: string };
}

export interface DeviceReadingReceivedEvent extends DomainEvent {
  type: 'device.reading_received';
  entityType: 'device_reading';
  payload: { equipmentId: string; readingType: string };
}

export interface DeviceReadingMatchedEvent extends DomainEvent {
  type: 'device.reading_matched';
  entityType: 'device_reading';
  payload: { patientId: string; matchedBy: string };
}

export interface DeviceReadingReviewedEvent extends DomainEvent {
  type: 'device.reading_reviewed';
  entityType: 'device_reading';
  payload: { reviewedBy: string };
}

export type Phase1Event =
  | PatientCreatedEvent
  | PatientUpdatedEvent
  | PatientAlertCreatedEvent
  | PatientAlertResolvedEvent
  | AppointmentScheduledEvent
  | AppointmentStatusChangedEvent
  | AppointmentCancelledEvent
  | DeviceReadingReceivedEvent
  | DeviceReadingMatchedEvent
  | DeviceReadingReviewedEvent;
```

- [ ] **Step 2: Write the failing tests**

Create `tests/server/events/bus.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { InProcessEventBus } from '../../../src/server/events/bus.js';
import type { DomainEvent } from '../../../src/server/events/types.js';

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: 'evt-1',
    type: 'patient.created',
    timestamp: new Date().toISOString(),
    practiceId: 'practice-1',
    actorId: 'user-1',
    actorType: 'human',
    entityType: 'patient',
    entityId: 'patient-1',
    payload: {},
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('InProcessEventBus', () => {
  it('delivers events to subscribers', async () => {
    const bus = new InProcessEventBus();
    const handler = vi.fn();
    bus.on('patient.created', handler);

    const event = makeEvent();
    await bus.emit(event);

    expect(handler).toHaveBeenCalledWith(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not deliver events to unrelated subscribers', async () => {
    const bus = new InProcessEventBus();
    const handler = vi.fn();
    bus.on('appointment.scheduled', handler);

    await bus.emit(makeEvent({ type: 'patient.created' }));

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers for the same event', async () => {
    const bus = new InProcessEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('patient.created', handler1);
    bus.on('patient.created', handler2);

    await bus.emit(makeEvent());

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('supports wildcard (*) subscribers', async () => {
    const bus = new InProcessEventBus();
    const handler = vi.fn();
    bus.on('*', handler);

    await bus.emit(makeEvent({ type: 'patient.created' }));
    await bus.emit(makeEvent({ type: 'appointment.scheduled' }));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes with off()', async () => {
    const bus = new InProcessEventBus();
    const handler = vi.fn();
    bus.on('patient.created', handler);
    bus.off('patient.created', handler);

    await bus.emit(makeEvent());

    expect(handler).not.toHaveBeenCalled();
  });

  it('awaits all handlers (synchronous guarantee)', async () => {
    const bus = new InProcessEventBus();
    const order: number[] = [];

    bus.on('patient.created', async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(1);
    });
    bus.on('patient.created', async () => {
      order.push(2);
    });

    await bus.emit(makeEvent());

    expect(order).toEqual([1, 2]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/server/events/bus.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Write the implementation**

Create `src/server/events/bus.ts`:

```typescript
import type { DomainEvent } from './types.js';

type EventHandler = (event: DomainEvent) => Promise<void>;

export interface DomainEventBus {
  emit(event: DomainEvent): Promise<void>;
  on(eventType: string, handler: EventHandler): void;
  off(eventType: string, handler: EventHandler): void;
}

export class InProcessEventBus implements DomainEventBus {
  private handlers = new Map<string, EventHandler[]>();

  on(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  off(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType);
    if (!existing) return;
    this.handlers.set(
      eventType,
      existing.filter(h => h !== handler),
    );
  }

  async emit(event: DomainEvent): Promise<void> {
    const specific = this.handlers.get(event.type) ?? [];
    const wildcard = this.handlers.get('*') ?? [];
    const all = [...specific, ...wildcard];

    for (const handler of all) {
      await handler(event);
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server/events/bus.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/events/types.ts src/server/events/bus.ts tests/server/events/bus.test.ts
git commit -m "feat: add typed domain event bus — in-process, interface-abstracted, wildcard support"
```

---

### Task 7: Audit Event Handler

**Files:**
- Create: `src/server/events/handlers/audit.handler.ts`
- Create: `tests/server/events/audit.handler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/events/audit.handler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { createAuditHandler } from '../../../src/server/events/handlers/audit.handler.js';
import { InProcessEventBus } from '../../../src/server/events/bus.js';
import type { DomainEvent } from '../../../src/server/events/types.js';
import { runMigrations } from '../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5433/osod_test';

describe('audit.handler', () => {
  let pool: pg.Pool;
  let bus: InProcessEventBus;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    // Clean audit_events by dropping and recreating (trigger blocks DELETE)
    await pool.query('DROP TABLE IF EXISTS audit_events CASCADE');
    await pool.query('DROP TABLE IF EXISTS _migrations CASCADE');
    await runMigrations(TEST_DB_URL);
    // Re-create pool after migration runner closes its pool
    pool = new pg.Pool({ connectionString: TEST_DB_URL });

    bus = new InProcessEventBus();
    const handler = createAuditHandler(pool);
    bus.on('*', handler);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('writes domain events to audit_events table', async () => {
    const event: DomainEvent = {
      id: 'evt-1',
      type: 'patient.created',
      timestamp: new Date().toISOString(),
      practiceId: 'practice-1',
      actorId: 'user-1',
      actorType: 'human',
      entityType: 'patient',
      entityId: 'patient-1',
      payload: { firstName: 'John', lastName: 'Doe' },
      correlationId: 'corr-1',
    };

    await bus.emit(event);

    const result = await pool.query('SELECT * FROM audit_events WHERE entity_id = $1', ['patient-1']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].entity_type).toBe('patient');
    expect(result.rows[0].action).toBe('create');
    expect(result.rows[0].actor_type).toBe('human');
  });

  it('maps event type to action correctly', async () => {
    const updateEvent: DomainEvent = {
      id: 'evt-2',
      type: 'patient.updated',
      timestamp: new Date().toISOString(),
      practiceId: 'practice-1',
      actorId: 'user-1',
      actorType: 'human',
      entityType: 'patient',
      entityId: 'patient-2',
      payload: { changes: { email: 'new@test.com' } },
      correlationId: 'corr-2',
    };

    await bus.emit(updateEvent);

    const result = await pool.query('SELECT action FROM audit_events WHERE entity_id = $1', ['patient-2']);
    expect(result.rows[0].action).toBe('update');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/events/audit.handler.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

Create `src/server/events/handlers/audit.handler.ts`:

```typescript
import type pg from 'pg';
import type { DomainEvent } from '../types.js';

function extractAction(eventType: string): string {
  if (eventType.includes('created') || eventType.includes('scheduled')) return 'create';
  if (eventType.includes('updated') || eventType.includes('changed')) return 'update';
  if (eventType.includes('cancelled') || eventType.includes('deleted')) return 'delete';
  if (eventType.includes('resolved') || eventType.includes('reviewed') || eventType.includes('matched')) return 'update';
  if (eventType.includes('received')) return 'create';
  return 'access';
}

export function createAuditHandler(pool: pg.Pool) {
  return async (event: DomainEvent): Promise<void> => {
    await pool.query(
      `INSERT INTO audit_events
        (id, practice_id, entity_type, entity_id, action, actor_id, actor_type, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.id,
        event.practiceId,
        event.entityType,
        event.entityId,
        extractAction(event.type),
        event.actorId,
        event.actorType,
        JSON.stringify({ eventType: event.type, correlationId: event.correlationId, payload: event.payload }),
        event.timestamp,
      ],
    );
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/events/audit.handler.test.ts`
Expected: Both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/events/handlers/audit.handler.ts tests/server/events/audit.handler.test.ts
git commit -m "feat: add audit event handler — writes domain events to append-only audit_events"
```

---

### Task 8: Auth Schemas and Service

**Files:**
- Create: `src/server/modules/auth/schemas.ts`
- Create: `src/server/modules/auth/service.ts`
- Create: `tests/server/modules/auth/auth.test.ts`

- [ ] **Step 1: Write auth schemas**

Create `src/server/modules/auth/schemas.ts`:

```typescript
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
  role: z.enum(['admin', 'provider', 'staff']),
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

- [ ] **Step 2: Write the failing tests**

Create `tests/server/modules/auth/auth.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { AuthService } from '../../../../src/server/modules/auth/service.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5433/osod_test';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long-for-validation';

describe('AuthService', () => {
  let pool: pg.Pool;
  let auth: AuthService;
  let practiceId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    // Reset DB
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });

    auth = new AuthService(pool, JWT_SECRET);

    // Create a practice for tests
    const result = await pool.query(
      "INSERT INTO practices (name) VALUES ('Test Practice') RETURNING id"
    );
    practiceId = result.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('createUser', () => {
    it('creates a user with hashed password', async () => {
      const user = await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        role: 'admin',
        isProvider: true,
        serviceLineIds: [],
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe('doc@test.com');
      expect(user.fullName).toBe('Dr. Test');
      expect(user.role).toBe('admin');
      // Password hash should NOT be returned
      expect((user as any).passwordHash).toBeUndefined();
      expect((user as any).password_hash).toBeUndefined();
    });

    it('rejects duplicate email within same practice', async () => {
      await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        role: 'admin',
        isProvider: false,
        serviceLineIds: [],
      });

      await expect(
        auth.createUser(practiceId, {
          email: 'doc@test.com',
          password: 'securepass123',
          fullName: 'Dr. Test 2',
          role: 'staff',
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
        role: 'admin',
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
        role: 'admin',
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
    it('decodes a valid token', async () => {
      await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        role: 'admin',
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
      expect(payload.role).toBe('admin');
    });
  });

  describe('createAgentKey', () => {
    it('returns the raw API key (only shown once)', async () => {
      const user = await auth.createUser(practiceId, {
        email: 'agent@test.com',
        password: 'securepass123',
        fullName: 'Scheduling Agent',
        role: 'agent',
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
        role: 'agent',
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

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/server/modules/auth/auth.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Write the auth service**

Create `src/server/modules/auth/service.ts`:

```typescript
import bcrypt from 'bcryptjs';
import * as jose from 'jose';
import crypto from 'node:crypto';
import type pg from 'pg';
import type { LoginInput, CreateUserInput, CreateAgentKeyInput } from './schemas.js';

interface UserRow {
  id: string;
  practice_id: string;
  email: string;
  full_name: string;
  role: string;
  is_provider: boolean;
  service_line_ids: string[];
  is_active: boolean;
}

interface TokenPayload {
  userId: string;
  practiceId: string;
  role: string;
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

  async createUser(
    practiceId: string,
    input: CreateUserInput,
  ): Promise<{ id: string; email: string; fullName: string; role: string }> {
    const passwordHash = await bcrypt.hash(input.password, 12);

    const result = await this.pool.query<UserRow>(
      `INSERT INTO users (practice_id, email, password_hash, full_name, role, is_provider, service_line_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, full_name, role`,
      [practiceId, input.email, passwordHash, input.fullName, input.role, input.isProvider, input.serviceLineIds],
    );

    const row = result.rows[0];
    return { id: row.id, email: row.email, fullName: row.full_name, role: row.role };
  }

  async login(input: LoginInput): Promise<{ accessToken: string; refreshToken: string }> {
    const result = await this.pool.query<UserRow & { password_hash: string }>(
      `SELECT id, practice_id, email, password_hash, role, is_active
       FROM users
       WHERE practice_id = $1 AND email = $2 AND is_active = true`,
      [input.practiceId, input.email],
    );

    const user = result.rows[0];
    if (!user) throw new Error('Invalid credentials');

    const valid = await bcrypt.compare(input.password, user.password_hash);
    if (!valid) throw new Error('Invalid credentials');

    const accessToken = await new jose.SignJWT({
      userId: user.id,
      practiceId: user.practice_id,
      role: user.role,
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

  async verifyAccessToken(token: string): Promise<TokenPayload> {
    const { payload } = await jose.jwtVerify(token, this.jwtSecret);
    return {
      userId: payload.userId as string,
      practiceId: payload.practiceId as string,
      role: payload.role as string,
    };
  }

  async createAgentKey(
    practiceId: string,
    userId: string,
    input: CreateAgentKeyInput,
  ): Promise<{ rawKey: string; keyId: string }> {
    const rawKey = `osod_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = await bcrypt.hash(rawKey, 12);

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO agent_keys (practice_id, user_id, key_hash, name, model_type, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [practiceId, userId, keyHash, input.name, input.modelType, input.scopes],
    );

    return { rawKey, keyId: result.rows[0].id };
  }

  async verifyAgentKey(rawKey: string): Promise<AgentKeyInfo | null> {
    const keys = await this.pool.query<{
      user_id: string;
      practice_id: string;
      key_hash: string;
      model_type: string;
      scopes: string[];
    }>(
      `SELECT ak.user_id, ak.practice_id, ak.key_hash, ak.model_type, ak.scopes
       FROM agent_keys ak
       WHERE ak.is_active = true`,
    );

    for (const key of keys.rows) {
      const valid = await bcrypt.compare(rawKey, key.key_hash);
      if (valid) {
        // Update last_used_at
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

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server/modules/auth/auth.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/modules/auth/schemas.ts src/server/modules/auth/service.ts tests/server/modules/auth/auth.test.ts
git commit -m "feat: add auth service — user CRUD, JWT login, API key create/verify"
```

---

### Task 9: Middleware Pipeline

**Files:**
- Create: `src/server/middleware/cors.ts`
- Create: `src/server/middleware/rate-limit.ts`
- Create: `src/server/middleware/auth.ts`
- Create: `src/server/middleware/audit.ts`
- Create: `tests/server/middleware/rate-limit.test.ts`
- Create: `tests/server/middleware/auth.test.ts`

- [ ] **Step 1: Write CORS middleware**

Create `src/server/middleware/cors.ts`:

```typescript
import { cors } from 'hono/cors';

export function createCorsMiddleware() {
  return cors({
    origin: ['http://localhost:5173', 'http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    credentials: true,
    maxAge: 86400,
  });
}
```

- [ ] **Step 2: Write rate limiter and its test**

Create `tests/server/middleware/rate-limit.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../../src/server/middleware/rate-limit.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under the limit', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 3 });
    expect(limiter.check('client-1').allowed).toBe(true);
    expect(limiter.check('client-1').allowed).toBe(true);
    expect(limiter.check('client-1').allowed).toBe(true);
  });

  it('blocks requests over the limit', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 2 });
    limiter.check('client-1');
    limiter.check('client-1');
    const result = limiter.check('client-1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets after the window expires', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1 });
    limiter.check('client-1');
    expect(limiter.check('client-1').allowed).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(limiter.check('client-1').allowed).toBe(true);
  });

  it('tracks clients independently', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1 });
    limiter.check('client-1');
    expect(limiter.check('client-2').allowed).toBe(true);
  });
});
```

Create `src/server/middleware/rate-limit.ts`:

```typescript
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();

  constructor(
    private opts: { windowMs: number; maxRequests: number },
  ) {}

  check(clientId: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const entry = this.entries.get(clientId);

    if (!entry || now - entry.windowStart > this.opts.windowMs) {
      this.entries.set(clientId, { count: 1, windowStart: now });
      return { allowed: true, retryAfterMs: 0 };
    }

    entry.count++;
    if (entry.count > this.opts.maxRequests) {
      const retryAfterMs = this.opts.windowMs - (now - entry.windowStart);
      return { allowed: false, retryAfterMs };
    }

    return { allowed: true, retryAfterMs: 0 };
  }
}
```

- [ ] **Step 3: Run rate limiter tests**

Run: `npx vitest run tests/server/middleware/rate-limit.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 4: Write auth middleware**

Create `src/server/middleware/auth.ts`:

```typescript
import { createMiddleware } from 'hono/factory';
import type { AuthService } from '../modules/auth/service.js';

export interface AuthContext {
  userId: string;
  practiceId: string;
  role: string;
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
        role: 'agent',
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
        role: payload.role,
        actorType: 'human',
      });
      return next();
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  });
}
```

- [ ] **Step 5: Write audit middleware**

Create `src/server/middleware/audit.ts`:

```typescript
import { createMiddleware } from 'hono/factory';
import type pg from 'pg';
import type { AuthContext } from './auth.js';

const PHI_PATHS = ['/api/patients', '/api/appointments'];

function isPHIPath(path: string): boolean {
  return PHI_PATHS.some(p => path.startsWith(p));
}

export function createAuditMiddleware(pool: pg.Pool) {
  return createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
    await next();

    if (!isPHIPath(c.req.path)) return;

    const auth = c.get('auth');
    if (!auth) return;

    const method = c.req.method;
    let action: string;
    if (method === 'GET') action = 'access';
    else if (method === 'POST') action = 'create';
    else if (method === 'PUT' || method === 'PATCH') action = 'update';
    else if (method === 'DELETE') action = 'delete';
    else return;

    try {
      await pool.query(
        `INSERT INTO audit_events
          (practice_id, entity_type, entity_id, action, actor_id, actor_type, ip_address, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          auth.practiceId,
          'http_request',
          '00000000-0000-0000-0000-000000000000',
          action,
          auth.userId,
          auth.actorType,
          c.req.header('x-forwarded-for') ?? 'localhost',
          JSON.stringify({ method, path: c.req.path, status: c.res.status }),
        ],
      );
    } catch (err) {
      console.error('Audit logging failed:', err);
    }
  });
}
```

- [ ] **Step 6: Write auth middleware test**

Create `tests/server/middleware/auth.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import pg from 'pg';
import { createAuthMiddleware } from '../../../src/server/middleware/auth.js';
import { AuthService } from '../../../src/server/modules/auth/service.js';
import { runMigrations } from '../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5433/osod_test';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long-for-validation';

describe('auth middleware', () => {
  let pool: pg.Pool;
  let authService: AuthService;
  let app: Hono;
  let practiceId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });

    authService = new AuthService(pool, JWT_SECRET);

    const result = await pool.query(
      "INSERT INTO practices (name) VALUES ('Test Practice') RETURNING id"
    );
    practiceId = result.rows[0].id;

    app = new Hono();
    app.use('/api/*', createAuthMiddleware(authService));
    app.get('/api/test', (c) => c.json({ ok: true, auth: c.get('auth') }));
    app.get('/health', (c) => c.json({ ok: true }));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('rejects requests without auth', async () => {
    const res = await app.request('/api/test');
    expect(res.status).toBe(401);
  });

  it('allows requests with valid JWT', async () => {
    await authService.createUser(practiceId, {
      email: 'doc@test.com',
      password: 'securepass123',
      fullName: 'Dr. Test',
      role: 'admin',
      isProvider: false,
      serviceLineIds: [],
    });

    const { accessToken } = await authService.login({
      email: 'doc@test.com',
      password: 'securepass123',
      practiceId,
    });

    const res = await app.request('/api/test', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.auth.role).toBe('admin');
    expect(body.auth.actorType).toBe('human');
  });

  it('allows requests with valid API key', async () => {
    const user = await authService.createUser(practiceId, {
      email: 'agent@test.com',
      password: 'securepass123',
      fullName: 'Agent',
      role: 'agent',
      isProvider: false,
      serviceLineIds: [],
    });

    const { rawKey } = await authService.createAgentKey(practiceId, user.id, {
      name: 'test-agent',
      modelType: 'local',
      scopes: ['patients:read'],
    });

    const res = await app.request('/api/test', {
      headers: { 'X-API-Key': rawKey },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.auth.actorType).toBe('local_agent');
  });

  it('does not require auth for non-api routes', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 7: Run middleware tests**

Run: `npx vitest run tests/server/middleware/`
Expected: All 8 tests PASS (4 rate-limit + 4 auth).

- [ ] **Step 8: Commit**

```bash
git add src/server/middleware/ tests/server/middleware/
git commit -m "feat: add middleware pipeline — CORS, rate limiting, JWT/API key auth, PHI audit"
```

---

### Task 10: Auth Routes

**Files:**
- Create: `src/server/modules/auth/routes.ts`

- [ ] **Step 1: Write auth routes**

Create `src/server/modules/auth/routes.ts`:

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

  // Protected: create user (admin only)
  routes.post('/users', zValidator('json', createUserSchema), async (c) => {
    const auth = c.get('auth');
    if (auth.role !== 'admin') {
      return c.json({ error: 'Admin role required' }, 403);
    }
    const input = c.req.valid('json');
    const user = await authService.createUser(auth.practiceId, input);
    return c.json(user, 201);
  });

  // Protected: create agent key (admin only)
  routes.post('/agent-keys', zValidator('json', createAgentKeySchema), async (c) => {
    const auth = c.get('auth');
    if (auth.role !== 'admin') {
      return c.json({ error: 'Admin role required' }, 403);
    }
    const input = c.req.valid('json');
    // Create an agent user identity
    const agentUser = await authService.createUser(auth.practiceId, {
      email: `${input.name}@agent.local`,
      password: crypto.randomUUID(),
      fullName: input.name,
      role: 'agent',
      isProvider: false,
      serviceLineIds: [],
    });
    const result = await authService.createAgentKey(auth.practiceId, agentUser.id, input);
    return c.json({ keyId: result.keyId, rawKey: result.rawKey, agentUserId: agentUser.id }, 201);
  });

  return routes;
}
```

- [ ] **Step 2: Add refreshAccessToken to AuthService**

Add this method to `src/server/modules/auth/service.ts` after the `login` method:

```typescript
  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const { payload } = await jose.jwtVerify(refreshToken, this.jwtSecret);
    if (payload.type !== 'refresh') throw new Error('Not a refresh token');

    const userId = payload.userId as string;
    const practiceId = payload.practiceId as string;

    // Look up current user to get latest role
    const result = await this.pool.query<{ role: string; is_active: boolean }>(
      'SELECT role, is_active FROM users WHERE id = $1 AND practice_id = $2',
      [userId, practiceId],
    );
    const user = result.rows[0];
    if (!user || !user.is_active) throw new Error('User not found or inactive');

    const accessToken = await new jose.SignJWT({
      userId,
      practiceId,
      role: user.role,
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
```

- [ ] **Step 3: Commit**

```bash
git add src/server/modules/auth/routes.ts src/server/modules/auth/service.ts
git commit -m "feat: add auth routes — login, refresh, user create, agent key create"
```

---

### Task 11: Hono App Factory and Server Entry

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/index.ts`

- [ ] **Step 1: Write the app factory**

Create `src/server/app.ts`:

```typescript
import { Hono } from 'hono';
import type pg from 'pg';
import type { Config } from './config/index.js';
import { InProcessEventBus } from './events/bus.js';
import { createAuditHandler } from './events/handlers/audit.handler.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { RateLimiter } from './middleware/rate-limit.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAuditMiddleware } from './middleware/audit.js';
import { AuthService } from './modules/auth/service.js';
import { createAuthRoutes } from './modules/auth/routes.js';

export interface AppDependencies {
  pool: pg.Pool;
  config: Config;
}

export function createApp({ pool, config }: AppDependencies) {
  const app = new Hono();

  // Services
  const eventBus = new InProcessEventBus();
  const authService = new AuthService(pool, config.jwtSecret);

  // Event subscriptions
  const auditHandler = createAuditHandler(pool);
  eventBus.on('*', auditHandler);

  // Rate limiters
  const humanLimiter = new RateLimiter({
    windowMs: config.rateLimitWindowMs,
    maxRequests: config.rateLimitMaxRequests,
  });
  const agentLimiter = new RateLimiter({
    windowMs: config.rateLimitWindowMs,
    maxRequests: config.rateLimitAgentMaxRequests,
  });

  // Global middleware
  app.use('*', createCorsMiddleware());

  // Rate limiting (before auth so we can limit by IP)
  app.use('/api/*', async (c, next) => {
    const clientId = c.req.header('x-forwarded-for') ?? 'localhost';
    const isAgent = !!c.req.header('X-API-Key');
    const limiter = isAgent ? agentLimiter : humanLimiter;
    const result = limiter.check(clientId);
    if (!result.allowed) {
      return c.json(
        { error: 'Rate limit exceeded', retryAfterMs: result.retryAfterMs },
        429,
      );
    }
    return next();
  });

  // Health check (no auth required)
  app.get('/health', (c) => c.json({ status: 'ok', version: '0.1.0' }));

  // Auth routes (login/refresh are public, user/key creation are protected internally)
  const authRoutes = createAuthRoutes(authService);
  app.route('/api/auth', authRoutes);

  // Protected API routes (auth required)
  app.use('/api/patients/*', createAuthMiddleware(authService));
  app.use('/api/schedule/*', createAuthMiddleware(authService));
  app.use('/api/appointments/*', createAuthMiddleware(authService));
  app.use('/api/practice/*', createAuthMiddleware(authService));
  app.use('/api/service-lines/*', createAuthMiddleware(authService));
  app.use('/api/agent/*', createAuthMiddleware(authService));

  // Audit middleware for PHI endpoints
  app.use('/api/patients/*', createAuditMiddleware(pool));
  app.use('/api/appointments/*', createAuditMiddleware(pool));

  // Placeholder routes (modules added in subsequent plans)
  app.get('/api/patients', (c) => c.json({ message: 'Patients module coming next' }));
  app.get('/api/schedule/grid', (c) => c.json({ message: 'Schedule module coming next' }));

  return { app, eventBus, authService };
}
```

- [ ] **Step 2: Write the server entry point**

Create `src/server/index.ts`:

```typescript
import { serve } from '@hono/node-server';
import { createPool } from './db/pool.js';
import { parseConfig } from './config/index.js';
import { runMigrations } from './db/migrate.js';
import { createApp } from './app.js';

async function main() {
  const config = parseConfig(process.env);
  const pool = createPool(config.databaseUrl);

  // Run pending migrations on startup
  await runMigrations(config.databaseUrl);

  const { app } = createApp({ pool, config });

  console.log(`OSOD server starting on ${config.host}:${config.port}`);
  serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });
  console.log(`OSOD server running at http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('Failed to start OSOD:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Create .env for local development**

Create `.env` (add to `.gitignore`):

```bash
DATABASE_URL=postgresql://osod:osod_dev@localhost:5432/osod
JWT_SECRET=dev-only-secret-change-in-production-must-be-at-least-32-chars
PORT=3000
HOST=localhost
NODE_ENV=development
```

Ensure `.gitignore` includes:
```
node_modules/
dist/
.env
```

- [ ] **Step 4: Start the server and verify**

Run: `source .env && npx tsx src/server/index.ts`
Expected: "OSOD server running at http://localhost:3000"

In another terminal, verify:
Run: `curl http://localhost:3000/health`
Expected: `{"status":"ok","version":"0.1.0"}`

Run: `curl http://localhost:3000/api/patients`
Expected: `{"error":"Missing authentication"}` (401)

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/index.ts .env.example .gitignore
git commit -m "feat: add Hono app factory and server entry — middleware wired, health check, auth protected"
```

---

### Task 12: Seed Script

**Files:**
- Create: `scripts/seed.ts`

- [ ] **Step 1: Write the seed script**

Create `scripts/seed.ts`:

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

  // 3. Users
  const adminHash = await bcrypt.hash('admin123!', 12);
  const staffHash = await bcrypt.hash('staff123!', 12);

  const admin = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, role, is_provider, service_line_ids)
     VALUES ($1, 'eric@iva.com', $2, 'Dr. Eric Bang', 'admin', true, $3) RETURNING id`,
    [practiceId, adminHash, [eyecareId, aestheticsId]]
  );
  const drSmith = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, role, is_provider, service_line_ids)
     VALUES ($1, 'smith@iva.com', $2, 'Dr. Smith', 'provider', true, $3) RETURNING id`,
    [practiceId, staffHash, [eyecareId]]
  );
  const sarah = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, role, is_provider, service_line_ids)
     VALUES ($1, 'sarah@iva.com', $2, 'Sarah Johnson', 'provider', true, $3) RETURNING id`,
    [practiceId, staffHash, [aestheticsId]]
  );
  const frontDesk = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, role, is_provider)
     VALUES ($1, 'front@iva.com', $2, 'Front Desk', 'staff', false) RETURNING id`,
    [practiceId, staffHash]
  );
  console.log(`  Users: admin (${admin.rows[0].id}), providers + staff created`);

  const adminId = admin.rows[0].id;

  // 4. Agent keys
  const localAgentUser = await pool.query(
    `INSERT INTO users (practice_id, email, password_hash, full_name, role, is_provider)
     VALUES ($1, 'local-agent@agent.local', NULL, 'Local Scheduling Agent', 'agent', false) RETURNING id`,
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

  // 5. Appointment types
  const eyecareTypes = [
    ['Comprehensive Exam', 'COMP', '#2563EB', 2],
    ['Contact Lens Follow-Up', 'CLFU', '#059669', 1],
    ['Dry Eye Evaluation', 'DRY', '#D97706', 3],
    ['Vision Therapy', 'VT', '#7C3AED', 4],
    ['Emergency/Walk-In', 'EMER', '#DC2626', 1],
  ];
  for (const [name, shortName, color, blocks] of eyecareTypes) {
    await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [practiceId, eyecareId, name, shortName, color, blocks]
    );
  }

  const aestheticsTypes = [
    ['Botox', 'BTX', '#DB2777', 2],
    ['Filler', 'FIL', '#E11D48', 3],
    ['Chemical Peel', 'PEEL', '#F59E0B', 2],
    ['Skin Consultation', 'CONS', '#8B5CF6', 2],
    ['Laser Treatment', 'LASER', '#EF4444', 4],
  ];
  for (const [name, shortName, color, blocks] of aestheticsTypes) {
    await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [practiceId, aestheticsId, name, shortName, color, blocks]
    );
  }
  console.log('  Appointment types: 5 eyecare + 5 aesthetics');

  // 6. Provider schedules (Mon-Fri templates)
  for (let day = 1; day <= 5; day++) {
    // Dr. Bang: mornings eyecare, afternoons aesthetics
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '08:00', '12:00', $3)`,
      [admin.rows[0].id, day, eyecareId]
    );
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '13:00', '17:00', $3)`,
      [admin.rows[0].id, day, aestheticsId]
    );
    // Dr. Smith: all day eyecare
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '08:00', '17:00', $3)`,
      [drSmith.rows[0].id, day, eyecareId]
    );
    // Sarah: all day aesthetics
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, $2, '09:00', '17:00', $3)`,
      [sarah.rows[0].id, day, aestheticsId]
    );
  }
  console.log('  Provider schedules: Mon-Fri for all 3 providers');

  // 7. Sample patients (20)
  const firstNames = ['James', 'Maria', 'Robert', 'Linda', 'Michael', 'Sarah', 'David', 'Jennifer', 'William', 'Patricia',
                       'Richard', 'Elizabeth', 'Joseph', 'Barbara', 'Thomas', 'Susan', 'Charles', 'Jessica', 'Daniel', 'Karen'];
  const lastNames = ['Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Anderson',
                      'Taylor', 'Thomas', 'Hernandez', 'Moore', 'Martin', 'Jackson', 'Thompson', 'White', 'Lopez', 'Lee'];

  const patientIds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const result = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        practiceId,
        firstNames[i],
        lastNames[i],
        `${1960 + i}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        i % 2 === 0 ? 'M' : 'F',
        `555-${String(1000 + i).padStart(4, '0')}`,
        `${100 + i} Main St`,
        'Edmond',
        'OK',
        '73034',
      ]
    );
    patientIds.push(result.rows[0].id);
  }
  console.log(`  Patients: 20 created`);

  // 8. Sample insurance (first 10 patients get vision insurance)
  for (let i = 0; i < 10; i++) {
    await pool.query(
      `INSERT INTO patient_insurance (patient_id, priority, plan_type, payer_name, member_id, effective_date)
       VALUES ($1, 1, 'vision', $2, $3, '2026-01-01')`,
      [patientIds[i], i % 2 === 0 ? 'VSP' : 'EyeMed', `MEM${String(10000 + i)}`]
    );
  }
  console.log('  Insurance: 10 patients with vision plans');

  // 9. Sample alerts
  await pool.query(
    `INSERT INTO patient_alerts (patient_id, alert_type, severity, message, created_by)
     VALUES ($1, 'allergy', 'critical', 'Sulfa allergy — do NOT prescribe sulfonamide antibiotics', $2)`,
    [patientIds[0], adminId]
  );
  await pool.query(
    `INSERT INTO patient_alerts (patient_id, alert_type, severity, message, created_by)
     VALUES ($1, 'balance', 'warning', 'Outstanding balance: $245.00 — collect before scheduling', $2)`,
    [patientIds[3], adminId]
  );
  await pool.query(
    `INSERT INTO patient_alerts (patient_id, alert_type, severity, message, created_by)
     VALUES ($1, 'scheduling', 'info', 'Prefers morning appointments only', $2)`,
    [patientIds[7], adminId]
  );
  console.log('  Alerts: 3 sample alerts');

  console.log('\nSeed complete!');
  console.log('\nLogin credentials:');
  console.log('  Admin: eric@iva.com / admin123!');
  console.log('  Staff: front@iva.com / staff123!');
  console.log(`  Agent key: ${localKey}`);

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the seed**

Run: `DATABASE_URL=postgresql://osod:osod_dev@localhost:5432/osod npx tsx scripts/seed.ts`
Expected: Seed output with practice, users, patients, appointment types, schedules, alerts created. Agent key printed.

- [ ] **Step 3: Verify seed data**

Run: `PGPASSWORD=osod_dev psql -h localhost -p 5432 -U osod -d osod -c "SELECT COUNT(*) FROM patients;"`
Expected: `20`

Run: `PGPASSWORD=osod_dev psql -h localhost -p 5432 -U osod -d osod -c "SELECT full_name, role FROM users;"`
Expected: Lists 5 users (Dr. Bang, Dr. Smith, Sarah, Front Desk, Local Agent).

- [ ] **Step 4: Commit**

```bash
git add scripts/seed.ts
git commit -m "feat: add seed script — IVA practice, 3 providers, 20 patients, 10 appointment types"
```

---

### Task 13: Integration Smoke Test

**Files:**
- Create: `tests/server/integration/smoke.test.ts`

- [ ] **Step 1: Write integration test**

Create `tests/server/integration/smoke.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../src/server/app.js';
import { parseConfig } from '../../../src/server/config/index.js';
import { runMigrations } from '../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5433/osod_test';

describe('OSOD smoke test', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let practiceId: string;
  let accessToken: string;

  beforeAll(async () => {
    // Reset test DB
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

    // Create practice and admin user
    const result = await pool.query(
      "INSERT INTO practices (name) VALUES ('Test Practice') RETURNING id"
    );
    practiceId = result.rows[0].id;

    await authService.createUser(practiceId, {
      email: 'admin@test.com',
      password: 'securepass123',
      fullName: 'Admin User',
      role: 'admin',
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

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run tests/server/integration/smoke.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: All tests across all files PASS (config: 5, pool: 2, event bus: 6, audit handler: 2, rate limit: 4, auth middleware: 4, auth service: 7, smoke: 6 = ~36 tests).

- [ ] **Step 4: Commit**

```bash
git add tests/server/integration/smoke.test.ts
git commit -m "test: add integration smoke tests — health, auth flow, protected routes"
```

---

## Summary

After completing all 13 tasks, you have:

| Component | Status |
|-----------|--------|
| Docker Compose (PostgreSQL dev + test) | Running |
| Hono server with middleware pipeline | Working |
| Zod-validated config system | Tested |
| PostgreSQL connection pool | Tested |
| Migration runner + 15-table foundation schema | Applied |
| Typed domain event bus (in-process) | Tested |
| Audit event handler (append-only trail) | Tested |
| Auth: JWT login/refresh + API key create/verify | Tested |
| Auth middleware (JWT + API key) | Tested |
| CORS, rate limiting | Tested |
| Seed script (IVA practice, providers, patients) | Applied |
| Integration smoke tests | Passing |

**Next plan:** Patient module (CRUD routes, schemas, service, queries) on top of this foundation.

**Plan after that:** Schedule module (grid, slots, booking, status lifecycle).
