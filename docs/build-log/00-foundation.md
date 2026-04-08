# 00 — Foundation

The foundation chunk gets you from "empty repo" to "running web server with auth, audit trail, and a database that knows about practices, patients, scheduling, equipment, and audit events."

**Merged to main:** `44e1187` (foundation infrastructure + schema v2)
**Tests at end:** 52/52
**Commits:** 14

## What we built

The pieces, in plain English:

1. **A configuration system.** Reads environment variables (`DATABASE_URL`, `JWT_SECRET`, etc.) and validates them at startup using Zod. If you forget to set something required, the server refuses to start with a clear error instead of crashing later. JWT secrets must be at least 32 characters. Lives in `src/server/config/`.

2. **A PostgreSQL connection pool + migration runner.** The pool is how the app talks to the database. The migration runner reads SQL files in `src/server/db/migrations/` in order and applies any that haven't been applied yet. It tracks applied migrations in a `_migrations` table. Lives in `src/server/db/`.

3. **The foundation database schema (`001_foundation.sql`).** 15 tables covering:
   - `practices` — the top-level tenant. Every other table has a `practice_id`.
   - `service_lines` — eyecare, aesthetics, etc. Practices can have multiple.
   - `users` — staff accounts (with passwords) and agent identities (no password)
   - `agent_keys` — API keys for AI agents (local LLM or cloud)
   - `patients` — demographics + insurance
   - `patient_insurance` — separate medical and vision plans, priority-ordered
   - `patient_contacts` — emergency contacts and guardians (later replaced by `responsible_parties` in schema v2)
   - `patient_alerts` — structured alerts (allergy, balance, clinical, scheduling, custom) with severity levels
   - `appointment_types` — what services the practice offers
   - `provider_schedules` — recurring weekly hours per provider per service line
   - `schedule_overrides` — one-off blocks or modified hours (vacation, half day)
   - `appointments` — actual booked appointments with status lifecycle
   - `equipment_registry` — devices in the practice (OCT, visual field, etc.)
   - `device_readings` — captured data from those devices
   - `audit_events` — append-only audit trail (a database trigger blocks UPDATE and DELETE)

4. **A typed domain event bus.** When something important happens in the app, it emits an event (e.g., `patient.created`). Other parts of the app can subscribe to those events. The bus uses TypeScript's type system so you can't accidentally fire an event with the wrong shape. Lives in `src/server/events/`.

5. **The audit handler.** Subscribes to all domain events (`*` wildcard) and writes them into the `audit_events` table. Because that table has a trigger blocking UPDATE/DELETE, the audit log can never be tampered with from inside the application. Lives in `src/server/events/handlers/audit.handler.ts`.

6. **The middleware pipeline.** Every request to `/api/*` goes through:
   - **CORS** — allows the frontend (when it exists) to call the API
   - **Rate limiting** — different limits for humans vs. agents (agents get more)
   - **Auth** — checks for either an API key (`X-API-Key` header) or a JWT (`Authorization: Bearer ...`)
   - **PHI audit** — for routes that touch patient data, also writes an HTTP audit event

7. **The auth service.** Handles user creation, login (returns JWT + refresh token), token verification, and API key creation/verification. Passwords use bcrypt (12 rounds). API keys are hashed with bcrypt and prefixed with `osod_` so you can recognize them in logs. Lives in `src/server/modules/auth/`.

8. **The Hono app factory.** Wires all the above together and returns a configured Hono app. Hono is the web framework — like Express, but TypeScript-native and faster. The factory pattern lets us create test instances without starting a real server. Lives in `src/server/app.ts`.

9. **The seed script.** Populates a fresh database with realistic IVA data: practice, service lines, users, appointment types, providers with schedules, sample patients with insurance, and a few alerts. Lives in `scripts/seed.ts`.

10. **Smoke tests.** Integration tests that hit the running app via Hono's test request method. Verifies health check, login, refresh, and that protected routes reject unauthenticated requests.

## Why this design

**Local-first, multi-tenant, append-only audit.** Three architectural choices that everything else builds on:

- **Local-first:** OSOD is meant to run on your hardware. The database and the app live together. There's no cloud dependency for the core PMS to work. You can run it on a Mac mini in the back office.

- **Multi-tenant via `practice_id`:** Even though most installs will be a single practice, the schema is designed so multiple practices could live in one database. Every query is scoped to a `practice_id`. This makes the aesthetics-fork architecture trivial later — same code, different practice configurations.

- **Append-only audit:** HIPAA requires an audit trail. We enforce this in the database itself, not just the application, with a trigger. If a developer (or an attacker) tries to delete an audit event, the database refuses. This is the strongest possible guarantee.

**Hono over Express:** Hono is TypeScript-first, has better RPC support, and is significantly faster. The trade-off is a smaller ecosystem, but Hono's middleware and routing are direct equivalents of Express patterns.

**Tag-based permissions over RBAC roles:** This was actually finalized in Schema V2 (next chunk), but the design intent was here from the start. Real practices have staff who cross-train (an aesthetician at IVA also runs front desk and helps in the optical). Rigid roles don't fit. Permissions are tags assigned to roles assigned to users.

## Key files

```
src/server/
├── config/index.ts            # Zod-validated env config
├── db/
│   ├── pool.ts                # PostgreSQL connection pool
│   ├── migrate.ts             # Migration runner
│   └── migrations/
│       └── 001_foundation.sql # 15-table schema
├── events/
│   ├── types.ts               # Domain event type definitions
│   ├── bus.ts                 # InProcessEventBus
│   └── handlers/audit.handler.ts
├── middleware/
│   ├── cors.ts
│   ├── rate-limit.ts
│   ├── auth.ts                # JWT + API key middleware
│   └── audit.ts               # PHI request auditing
├── modules/auth/
│   ├── schemas.ts             # Zod input validation
│   ├── service.ts             # AuthService class
│   └── routes.ts              # /api/auth/* endpoints
├── app.ts                     # Hono app factory
└── index.ts                   # Server entry point
scripts/seed.ts                # Sample data population
```

## Test coverage

- Config parsing (5 tests)
- Database pool (2 tests)
- Domain event bus (6 tests)
- Audit handler (2 tests)
- Auth service (11 tests — createUser, login, refresh, verify, agent keys)
- Auth middleware (4 tests)
- Rate limit middleware (4 tests)
- Smoke tests (6 tests — health, login, refresh, protected routes)

**Total at end of foundation:** 52/52

## Known limitations

- **No frontend.** This is API-only. A React frontend comes later.
- **No clinical data.** Encounters, exam findings, prescriptions — all deferred to the clinical module.
- **No billing.** Charges, payments, claims — all deferred to the billing module.
- **Single-process.** No horizontal scaling. Fine for one practice, not for SaaS-scale.

## How to verify locally

```bash
# Start the database
docker compose -f docker/docker-compose.yml up -d

# Apply migrations
DATABASE_URL="postgresql://osod:osod_dev@localhost:5432/osod" npm run db:migrate

# Seed sample data
DATABASE_URL="postgresql://osod:osod_dev@localhost:5432/osod" npm run db:seed

# Run all tests
npx vitest run

# Start the dev server
DATABASE_URL="postgresql://osod:osod_dev@localhost:5432/osod" \
JWT_SECRET="test-secret-that-is-at-least-32-characters-long-for-validation" \
npm run dev

# Hit the health endpoint
curl http://localhost:3000/health
```

## Rollback plan

The foundation IS the floor. You can't roll back without losing everything else. If something is wrong with foundation, fix forward.

To wipe and restart fresh:

```bash
psql postgresql://osod:osod_dev@localhost:5432/osod \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
DATABASE_URL="postgresql://osod:osod_dev@localhost:5432/osod" npm run db:migrate
DATABASE_URL="postgresql://osod:osod_dev@localhost:5432/osod" npm run db:seed
```

## Common breakage and fixes

**"Migration failed: relation already exists"** — your database has partial state from a previous run. Wipe and re-migrate using the commands above.

**"DATABASE_URL environment variable is required"** — you forgot to set the env var. Either prefix the command with it (`DATABASE_URL=... npm run ...`) or add it to a `.env` file.

**"JWT_SECRET must be at least 32 characters"** — the config validator caught a too-short secret. Generate a longer one: `openssl rand -base64 48`.

**"Login returns 401 for valid credentials"** — most likely you're passing the wrong `practiceId`. Login requires email + password + practiceId all matching one row in the users table. Check the seed output for the practice ID, or query: `SELECT id, name FROM practices;`

**"Tests fail with 'pool already used' or connection errors"** — vitest is running test files in parallel and they're stomping each other on the shared test database. The `vitest.config.ts` has `fileParallelism: false` to prevent this. If you removed it, put it back.
