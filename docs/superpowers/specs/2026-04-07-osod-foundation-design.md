# OSOD Foundation Design — Phase 1: Patients + Scheduling

**Date:** 2026-04-07
**Status:** Approved
**Author:** Claude (builder) + Eric Bang, O.D. (clinician)

---

## 1. What We're Building

A unified PM+EHR foundation for independent optometry and multi-service clinical practices. Not two apps bolted together — one integrated system where scheduling, patient records, clinical encounters, billing, and AI agent workflows share a single data layer, a single event bus, and a single type system.

**Phase 1 delivers:** Patient records + multi-provider scheduling with the architectural foundation (event bus, audit trail, agent API, module structure) that every future phase builds on.

**Design principles:**
- Local-first: your data, your hardware, no cloud dependency
- Agent-first: every action is an API call; the UI is one client, agents are another
- Integrated: PM and EHR are modules over one database, not separate systems
- Specialty-aware: structured data, not text boxes
- Multi-service: eyecare and aesthetics (and future verticals) are parallel service lines, not separate apps

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Clients                           │
│  React UI    Local LLM Agent    Cloud LLM Agent     │
│     ↕              ↕                  ↕             │
│  Hono RPC      REST API           REST API          │
└──────┬─────────────┬──────────────────┬─────────────┘
       │             │                  │
┌──────▼─────────────▼──────────────────▼─────────────┐
│              Agent Gateway / Router                  │
│  (classify task → route local or cloud → log)       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                   Hono Server                        │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ Patient  │ │Schedule  │ │ Billing  │  ...modules │
│  │ Module   │ │ Module   │ │ Module   │            │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘            │
│       │             │            │                   │
│  ┌────▼─────────────▼────────────▼─────────────┐    │
│  │           Domain Event Bus                   │    │
│  │  patient.created → schedule subscribes       │    │
│  │  encounter.saved → billing subscribes        │    │
│  │  rx.changed → audit + alert + timeline       │    │
│  └──────────────────┬──────────────────────────┘    │
│                     │                                │
│  ┌──────────────────▼──────────────────────────┐    │
│  │         Middleware Pipeline                   │    │
│  │  auth → audit → validate → rate-limit        │    │
│  └──────────────────┬──────────────────────────┘    │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                  PostgreSQL                           │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ patients │ │schedules │ │ audit_events      │   │
│  │encounters│ │ claims   │ │ (append-only)     │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 2.1 Module Structure

Modules are logical boundaries within a single process, not microservices. Each module owns:
- Its Hono route group (e.g., `/api/patients/*`, `/api/schedule/*`)
- Its Zod schemas (input validation + TypeScript type generation)
- Its domain event emissions and subscriptions
- Its database queries (but all modules share one PostgreSQL instance)

Modules communicate through the Domain Event Bus, not by importing each other's internals. The event bus is the integration backbone — when a module needs to react to something another module did, it subscribes to the event.

### 2.2 Why Hono

- **TypeScript-native:** Not bolted-on types (`@types/express`). Types are intrinsic to the framework. Fewer casts, better inference, cleaner code.
- **Native RPC:** `hono/client` infers client types directly from route definitions. The React frontend gets compile-time type errors if the API shape changes. Zero code generation. One schema change propagates everywhere.
- **Zod integration:** `@hono/zod-validator` validates request bodies against Zod schemas in the middleware pipeline. Same schemas that generate TypeScript types also validate runtime input.
- **Modern middleware:** Composable, typed middleware chain. Audit logging, auth, rate limiting — all type-safe.
- **Performance:** Fastest Node.js framework benchmarked. Not that it matters at single-practice scale, but it means zero overhead from the framework layer.

Healthcare traditionally picks "boring" frameworks. That applies to hospital enterprise systems with legacy constraints. OSOD is greenfield, built by AI agents, targeting independent practices. The audit logging, HIPAA compliance, and security are in our middleware and data layer — not in the framework choice.

---

## 3. Technology Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Language** | TypeScript (strict) | Full-stack type safety. AI agents write it best. |
| **Runtime** | Node.js | Same language frontend and backend. |
| **Framework** | Hono | TypeScript-native, RPC for integrated PM+EHR type safety. |
| **Validation** | Zod | Single source of truth for types, API validation, event payloads. |
| **Database** | PostgreSQL | Relational. Patients→visits→claims. Battle-tested. Free. |
| **ORM/Query** | Raw pg + Zod parsing | No ORM overhead. SQL you can read. Zod validates query results. |
| **Frontend** | React 19 | Largest ecosystem. Most AI training data. |
| **Build** | Vite 6 | Fast dev server, fast builds. Already configured. |
| **Test** | Vitest | Same config as Vite. Fast. TypeScript-native. |
| **Auth** | JWT (humans) + API keys (agents) | Both logged identically in audit trail. |
| **Events** | In-process typed EventBus | Interface-abstracted. Synchronous for critical paths. No Redis. |
| **License** | AGPL v3 | Protects community from proprietary forks. |

---

## 4. Data Model (Phase 1)

### 4.1 Core Tables

#### practices
The top-level entity. Everything belongs to a practice.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| name | text | Practice name |
| schedule_block_minutes | int | 10, 15, 20, or 30. Configurable per practice. |
| timezone | text | IANA timezone (e.g., "America/Chicago") |
| settings | jsonb | Extensible practice-level configuration |
| created_at | timestamptz | |
| updated_at | timestamptz | |

#### service_lines
Parallel service verticals within a practice. Eyecare. Aesthetics. Future: fitness, coaching, derm.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| practice_id | uuid | FK → practices |
| name | text | "Eyecare", "Aesthetics", custom |
| color | text | Hex color for schedule UI |
| sort_order | int | Display ordering |
| is_active | boolean | Soft disable without deleting |
| created_at | timestamptz | |

#### users
Staff, providers, and agent identities. Single table, role-differentiated.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| practice_id | uuid | FK → practices |
| email | text | Unique per practice |
| password_hash | text | bcrypt. Null for agent users. |
| full_name | text | |
| role | text | "admin", "provider", "staff", "agent" |
| is_provider | boolean | Can appear on schedule |
| service_line_ids | uuid[] | Which service lines this user serves |
| permissions | jsonb | Granular permission flags |
| is_active | boolean | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

#### agent_keys
API keys for local and cloud LLM agents. Scoped permissions per key.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| practice_id | uuid | FK → practices |
| user_id | uuid | FK → users (agent user identity) |
| key_hash | text | bcrypt hash of the API key |
| name | text | "local-scheduling-agent", "cloud-clinical-agent" |
| model_type | text | "local" or "cloud" |
| scopes | text[] | ["patients:read", "appointments:write", ...] |
| is_active | boolean | |
| last_used_at | timestamptz | |
| created_at | timestamptz | |

#### patients
Core patient record. Demographics, pharmacy, balance. Insurance and contacts are separate tables (1:many).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| practice_id | uuid | FK → practices |
| first_name | text | |
| last_name | text | |
| preferred_name | text | Nullable |
| date_of_birth | date | |
| sex | text | "M", "F", "X" |
| email | text | Nullable |
| phone_primary | text | |
| phone_secondary | text | Nullable |
| address_line1 | text | |
| address_line2 | text | Nullable |
| city | text | |
| state | text | 2-letter code |
| zip | text | |
| preferred_pharmacy | text | Pharmacy name. WENO integration later. |
| preferred_language | text | Default "en" |
| communication_pref | text | "email", "phone", "text", "mail" |
| balance_cents | int | Outstanding balance in cents. No floats for money. |
| is_active | boolean | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

#### patient_insurance
Multiple insurance records per patient (primary, secondary, tertiary). Handles both medical and vision plans.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| patient_id | uuid | FK → patients |
| priority | int | 1=primary, 2=secondary, 3=tertiary |
| plan_type | text | "medical", "vision" |
| payer_name | text | "VSP", "EyeMed", "BCBS", etc. |
| payer_id | text | Payer ID for EDI claims |
| member_id | text | Patient's member/subscriber ID |
| group_number | text | Nullable |
| subscriber_name | text | If different from patient |
| subscriber_dob | date | If different from patient |
| subscriber_relationship | text | "self", "spouse", "child", "other" |
| effective_date | date | |
| termination_date | date | Nullable |
| copay_cents | int | Nullable |
| is_active | boolean | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

#### patient_contacts
Emergency contacts, responsible parties, guardians.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| patient_id | uuid | FK → patients |
| contact_type | text | "emergency", "responsible_party", "guardian" |
| full_name | text | |
| relationship | text | "spouse", "parent", "child", "other" |
| phone | text | |
| email | text | Nullable |
| is_primary | boolean | Primary contact of this type |
| created_at | timestamptz | |

#### patient_alerts
Persistent, severity-coded alerts. Structured, not free-text. Resolve don't delete.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| patient_id | uuid | FK → patients |
| alert_type | text | "allergy", "balance", "clinical", "scheduling", "custom" |
| severity | text | "info", "warning", "critical" |
| message | text | Alert content |
| is_resolved | boolean | Default false. Resolved, never deleted. |
| resolved_by | uuid | FK → users. Nullable. |
| resolved_at | timestamptz | Nullable |
| created_by | uuid | FK → users |
| created_at | timestamptz | |

### 4.2 Scheduling Tables

#### appointment_types
Practice-defined appointment categories. Each belongs to a service line. Duration in base blocks.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| practice_id | uuid | FK → practices |
| service_line_id | uuid | FK → service_lines |
| name | text | "Comprehensive Exam", "CL Follow-Up", "Botox", etc. |
| short_name | text | Abbreviation for schedule grid ("COMP", "CLFU") |
| color | text | Hex color for schedule display |
| duration_blocks | int | Number of base blocks (e.g., 2 blocks × 15 min = 30 min) |
| default_reason | text | Pre-fill for visit reason. Nullable. |
| is_active | boolean | |
| sort_order | int | |
| created_at | timestamptz | |

#### provider_schedules
Template schedule for each provider. Defines available hours per day of week. Multiple entries per provider per day allow split schedules (morning + afternoon with lunch break).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| provider_id | uuid | FK → users (where is_provider = true) |
| day_of_week | int | 0=Sunday, 6=Saturday |
| start_time | time | Block start (e.g., "08:00") |
| end_time | time | Block end (e.g., "12:00") |
| service_line_id | uuid | FK → service_lines. Which line during this block. |
| is_active | boolean | |
| created_at | timestamptz | |

#### schedule_overrides
Vacations, special hours, holiday closures. Override the template for specific dates.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| provider_id | uuid | FK → users |
| override_date | date | |
| override_type | text | "blocked" (day off), "modified" (different hours) |
| start_time | time | Nullable (null = all day blocked) |
| end_time | time | Nullable |
| reason | text | "Vacation", "Conference", "Holiday" |
| created_at | timestamptz | |

#### appointments
The core scheduling record. Links patient, provider, appointment type. Status tracks lifecycle.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| practice_id | uuid | FK → practices |
| patient_id | uuid | FK → patients |
| provider_id | uuid | FK → users |
| appointment_type_id | uuid | FK → appointment_types |
| service_line_id | uuid | FK → service_lines |
| start_time | timestamptz | Appointment start |
| duration_blocks | int | May differ from type default |
| status | text | "scheduled", "confirmed", "checked_in", "in_progress", "completed", "cancelled", "no_show" |
| chief_complaint | text | Patient's stated reason. Nullable. |
| notes | text | Internal notes (not clinical). Nullable. |
| cancelled_reason | text | Nullable. Populated on cancel. |
| cancelled_at | timestamptz | Nullable |
| checked_in_at | timestamptz | Nullable |
| created_by | uuid | FK → users (who booked it — human or agent) |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### 4.3 Audit Trail

#### audit_events
Append-only. No UPDATE. No DELETE. Every mutation to any PHI-bearing table is logged here automatically via middleware.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| practice_id | uuid | FK → practices |
| entity_type | text | "patient", "appointment", "insurance", etc. |
| entity_id | uuid | ID of the affected record |
| action | text | "create", "update", "delete", "access" |
| actor_id | uuid | FK → users (human or agent user) |
| actor_type | text | "human", "local_agent", "cloud_agent" |
| model_name | text | Nullable. For agents: "llama-3.1-8b", "claude-sonnet", etc. |
| confidence | decimal | Nullable. Agent confidence score for this action. |
| ip_address | text | |
| previous_state | jsonb | Nullable. State before mutation. |
| new_state | jsonb | Nullable. State after mutation. |
| metadata | jsonb | Additional context (request path, correlation ID, etc.) |
| created_at | timestamptz | Immutable timestamp |

**Indexes:**
- `audit_events(entity_type, entity_id)` — "show me everything that happened to this patient"
- `audit_events(actor_id, created_at)` — "what did this user/agent do today"
- `audit_events(created_at)` — chronological audit review
- `patients(practice_id, last_name, first_name)` — patient search
- `patients(practice_id, date_of_birth)` — DOB lookup
- `appointments(provider_id, start_time)` — schedule grid queries
- `appointments(patient_id, start_time)` — patient appointment history
- `appointments(practice_id, start_time, status)` — daily schedule view

**Constraints:** No UPDATE or DELETE grants on this table. Application-level enforcement + database-level trigger that rejects UPDATE/DELETE.

---

## 5. Domain Event Bus

### 5.1 Design

In-process typed EventEmitter behind an interface. Synchronous for critical paths (audit logging must complete before response returns). Interface-abstracted so a Redis/BullMQ implementation can replace it without touching module code.

```typescript
// The interface — modules code against this, not the implementation
interface DomainEventBus {
  emit<T extends DomainEvent>(event: T): Promise<void>
  on<T extends DomainEvent>(eventType: string, handler: (event: T) => Promise<void>): void
  off(eventType: string, handler: Function): void
}

// Phase 1 implementation — in-process
class InProcessEventBus implements DomainEventBus { ... }

// Future (if needed) — Redis-backed for multi-server
class RedisEventBus implements DomainEventBus { ... }
```

### 5.2 Phase 1 Events

| Event | Emitted By | Subscribers |
|-------|-----------|-------------|
| `patient.created` | Patient module | Audit, Schedule (patient now bookable) |
| `patient.updated` | Patient module | Audit, Timeline |
| `patient.alert.created` | Patient module | Audit, UI notification |
| `patient.alert.resolved` | Patient module | Audit |
| `appointment.scheduled` | Schedule module | Audit, Patient timeline |
| `appointment.status_changed` | Schedule module | Audit, Patient timeline, (future: clinical prep) |
| `appointment.cancelled` | Schedule module | Audit, Patient timeline |

### 5.3 Event Shape

Every event carries:

```typescript
interface DomainEvent {
  id: string           // Unique event ID (uuid)
  type: string         // "patient.created", "appointment.scheduled", etc.
  timestamp: string    // ISO 8601
  practiceId: string   // Scoped to practice
  actorId: string      // Who triggered this (human or agent user ID)
  actorType: 'human' | 'local_agent' | 'cloud_agent'
  entityType: string   // "patient", "appointment", etc.
  entityId: string     // ID of affected entity
  payload: unknown     // Event-specific data (typed per event via generics)
  correlationId: string // Links related events in a cascade
}
```

The `correlationId` is critical — when an appointment status change triggers a patient timeline update which triggers a UI notification, all three events share the same correlation ID. This is how you trace cascades in the audit trail.

---

## 6. Agent Gateway

### 6.1 Purpose

Every AI agent request (local or cloud) enters through the agent gateway. The gateway:
1. Authenticates the agent (API key → scoped permissions)
2. Classifies the task complexity
3. Routes to local or cloud model (or rejects if out of scope)
4. Logs the request, model used, and confidence in audit_events

### 6.2 Routing Logic

| Task Category | Route | Examples |
|---------------|-------|---------|
| Structured CRUD | Local model | Book appointment, update demographics, check schedule |
| Template-based | Local model | Generate recall reminder, fill referral form |
| Eligibility/lookup | Local model | Check insurance eligibility, find open slots |
| Clinical reasoning | Cloud model + human gate | Drug interaction check, treatment protocol suggestion |
| Diagnostic support | Cloud model + human gate | Differential diagnosis assistance, risk scoring |

### 6.3 Human Approval Gates

Agent actions on clinical data that affect patient care require human approval before committing. The agent stages the action; a provider reviews and approves.

Gated actions (Phase 1): none — Phase 1 is scheduling + demographics. Gates activate when clinical modules ship (Phase 4+). But the gate infrastructure is built now so modules can register gated actions without refactoring.

### 6.4 Cost Architecture

Local models run on practice hardware — zero per-token cost after hardware investment. Cloud models are pay-per-use. The routing logic defaults to local and only escalates to cloud when task classification exceeds local capability thresholds. Practices configure their own thresholds and cloud provider preferences.

```typescript
interface AgentConfig {
  localModelEndpoint: string     // e.g., "http://localhost:11434" (Ollama)
  cloudModelProvider?: string    // e.g., "anthropic", "openai"
  cloudModelApiKey?: string      // Encrypted at rest
  costThreshold?: number         // Monthly cloud spend cap in cents
  routingPolicy: 'local_first' | 'cloud_first' | 'local_only' | 'cloud_only'
}
```

---

## 7. Middleware Pipeline

Every request passes through this pipeline in order:

1. **CORS** — configured per practice (local-first: typically `localhost` origins)
2. **Rate limiting** — per API key / per session. Agents get higher limits than UI.
3. **Auth** — JWT validation (humans) or API key validation (agents). Sets `context.actor`.
4. **Audit** — logs every request touching PHI-bearing endpoints. Automatic. No opt-out.
5. **Validation** — Zod schema validation via `@hono/zod-validator`. Rejects bad input before it reaches the handler.
6. **Handler** — module route handler executes.
7. **Audit (response)** — logs response status. For mutations, logs before/after state.

---

## 8. Project Structure

```
osod/
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── docker/
│   └── docker-compose.yml          # PostgreSQL + app
│
├── src/
│   ├── server/
│   │   ├── index.ts                # Hono app entry point
│   │   ├── app.ts                  # Hono app factory (testable)
│   │   │
│   │   ├── config/
│   │   │   └── index.ts            # Environment config with Zod validation
│   │   │
│   │   ├── db/
│   │   │   ├── pool.ts             # PostgreSQL connection pool
│   │   │   ├── migrate.ts          # Migration runner
│   │   │   └── migrations/
│   │   │       └── 001_foundation.sql
│   │   │
│   │   ├── middleware/
│   │   │   ├── auth.ts             # JWT + API key auth
│   │   │   ├── audit.ts            # Automatic PHI access logging
│   │   │   ├── cors.ts             # CORS configuration
│   │   │   └── rate-limit.ts       # Rate limiting
│   │   │
│   │   ├── events/
│   │   │   ├── bus.ts              # DomainEventBus interface + InProcessEventBus
│   │   │   ├── types.ts            # All domain event type definitions
│   │   │   └── handlers/
│   │   │       └── audit.handler.ts # Audit subscriber (writes audit_events)
│   │   │
│   │   ├── modules/
│   │   │   ├── patients/
│   │   │   │   ├── routes.ts       # Hono route group: /api/patients/*
│   │   │   │   ├── schemas.ts      # Zod schemas (Patient, Insurance, Alert, etc.)
│   │   │   │   ├── service.ts      # Business logic
│   │   │   │   └── queries.ts      # PostgreSQL queries
│   │   │   │
│   │   │   └── schedule/
│   │   │       ├── routes.ts       # Hono route group: /api/schedule/*
│   │   │       ├── schemas.ts      # Zod schemas (Appointment, ProviderSchedule, etc.)
│   │   │       ├── service.ts      # Business logic
│   │   │       └── queries.ts      # PostgreSQL queries
│   │   │
│   │   └── agent/
│   │       ├── gateway.ts          # Agent routing (local vs cloud)
│   │       ├── routes.ts           # /api/agent/* endpoints
│   │       └── schemas.ts          # Agent request/response schemas
│   │
│   └── client/
│       ├── main.tsx                # React entry point
│       ├── App.tsx                 # Root component + routing
│       ├── api/
│       │   └── client.ts           # Hono RPC client (type-safe)
│       ├── components/
│       │   ├── layout/             # Shell, nav, sidebar
│       │   ├── schedule/           # Schedule grid, appointment cards
│       │   └── patients/           # Patient cards, forms, alerts
│       ├── pages/
│       │   ├── Schedule.tsx        # Multi-provider schedule grid
│       │   ├── PatientList.tsx     # Patient search/list
│       │   └── PatientDetail.tsx   # Patient record view
│       └── hooks/
│           └── useApi.ts           # Typed API hooks
│
├── tests/
│   ├── server/
│   │   ├── modules/patients/       # Patient module tests
│   │   ├── modules/schedule/       # Schedule module tests
│   │   ├── events/                 # Event bus tests
│   │   └── middleware/             # Middleware tests
│   └── client/
│       └── components/             # Component tests
│
├── scripts/
│   ├── seed.ts                     # Development seed data
│   └── migrate.ts                  # CLI migration runner
│
├── docs/
│   ├── getting-started.md
│   ├── architecture.md
│   └── api/
│
└── .github/
    └── workflows/
        └── ci.yml                  # TypeScript check + Vitest + lint
```

---

## 9. Phase 1 API Endpoints

### Patients

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/patients | List/search patients (paginated, filterable) |
| POST | /api/patients | Create patient |
| GET | /api/patients/:id | Get patient with insurance, contacts, alerts |
| PUT | /api/patients/:id | Update patient |
| POST | /api/patients/:id/insurance | Add insurance record |
| PUT | /api/patients/:id/insurance/:iid | Update insurance |
| POST | /api/patients/:id/contacts | Add contact |
| POST | /api/patients/:id/alerts | Create alert |
| PUT | /api/patients/:id/alerts/:aid | Resolve alert |

### Schedule

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/schedule/providers | List providers with availability |
| GET | /api/schedule/grid | Get schedule grid (date range, provider filter, service line filter) |
| GET | /api/schedule/slots | Get available slots (provider, date, appointment type) |
| POST | /api/appointments | Book appointment |
| GET | /api/appointments/:id | Get appointment detail |
| PUT | /api/appointments/:id | Update appointment |
| PUT | /api/appointments/:id/status | Change status (check-in, complete, cancel, no-show) |
| GET | /api/appointments/patient/:pid | Get patient's appointments (past + upcoming) |

### Admin (Practice Setup)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/practice | Get practice settings |
| PUT | /api/practice | Update practice settings |
| GET | /api/service-lines | List service lines |
| POST | /api/service-lines | Create service line |
| GET | /api/appointment-types | List appointment types |
| POST | /api/appointment-types | Create appointment type |
| GET | /api/provider-schedules/:pid | Get provider's schedule template |
| PUT | /api/provider-schedules/:pid | Update provider's schedule template |
| POST | /api/schedule-overrides | Create schedule override (vacation, etc.) |

### Agent

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/agent/action | Submit agent action (routed by gateway) |
| GET | /api/agent/status | Agent health check + capability report |

---

## 10. Scheduling Logic

### 10.1 Block System

The schedule operates on a configurable base block unit set per practice (10, 15, 20, or 30 minutes). Appointment types define their duration as a number of blocks. The grid renders in base-block increments.

**Example:** Practice uses 15-min blocks.
- Comprehensive exam = 2 blocks = 30 min
- Contact lens follow-up = 1 block = 15 min
- Dry eye evaluation = 3 blocks = 45 min

**Example:** Practice uses 10-min blocks.
- Comprehensive exam = 3 blocks = 30 min
- Quick follow-up = 1 block = 10 min

### 10.2 Multi-Provider Grid

The schedule grid shows columns per provider, rows per time block. Service line filtering lets staff view:
- All providers, all service lines (full practice view)
- Eyecare providers only
- Aesthetics providers only
- Single provider detail

A provider tagged with multiple service lines (e.g., Dr. Bang: eyecare + aesthetics) appears in both filtered views. Their schedule template can assign different time blocks to different service lines (mornings: eyecare, afternoons: aesthetics).

### 10.3 Appointment Lifecycle

```
scheduled → confirmed → checked_in → in_progress → completed
    │                                                    
    ├→ cancelled (with reason)
    ├→ no_show
```

Each status transition fires an `appointment.status_changed` event with the old and new status. Downstream modules subscribe to specific transitions (e.g., `checked_in` triggers clinical prep in future phases).

---

## 11. Auth Model

### 11.1 Human Auth (JWT)

- Login: email + password → JWT token (short-lived, 1 hour)
- Refresh: refresh token (long-lived, 7 days, rotated on use)
- JWT payload: `{ userId, practiceId, role, permissions }`
- Stored in httpOnly cookies (not localStorage — XSS protection)

### 11.2 Agent Auth (API Keys)

- API keys generated per agent identity in the admin panel
- Key shown once on creation, stored as bcrypt hash
- Each key has scoped permissions: `["patients:read", "appointments:write"]`
- Keys identify as a `user` with role "agent" — same audit trail as humans
- Keys carry `model_type` ("local" or "cloud") for audit classification

### 11.3 Permission Model

| Role | Patients | Schedule | Billing | Clinical | Admin |
|------|----------|----------|---------|----------|-------|
| admin | full | full | full | full | full |
| provider | full | own + view all | view | full | none |
| staff | read + update | full | create | none | none |
| agent | per-key scopes | per-key scopes | per-key scopes | per-key + gate | none |

---

## 12. Equipment Integration Architecture

Equipment is how clinical data gets INTO the system. This is not a Phase 6 afterthought — the data model and event patterns are foundation-level, even though device-specific parsers and integrations are built incrementally.

### 12.1 The Reality of Optometry Equipment

Every practice has different equipment. There is no universal standard. One office has a Zeiss Cirrus OCT, another has a Topcon Maestro. One uses a Marco TRS-5100 phoropter, another has a manual phoropter with no digital output. OSOD must handle all of these through a configurable, vendor-agnostic equipment registry.

**Equipment categories in a typical optometry practice:**

| Category | Examples | Common Integration |
|----------|---------|-------------------|
| **OCT** | Zeiss Cirrus, Topcon Maestro/Triton, Heidelberg Spectralis | DICOM |
| **Visual Fields** | Humphrey HFA3, Octopus | DICOM or proprietary XML |
| **Retinal Cameras** | Topcon TRC-NW400, Optos California/Daytona, Canon CR-2 | DICOM |
| **Topographers** | Zeiss Atlas, Oculus Pentacam, Medmont | DICOM or proprietary |
| **Autorefractors** | Topcon KR-1W, Huvitz HRK-1, Nidek ARK-1 | Serial ASCII protocol |
| **Lensometers** | Topcon CL-300, Nidek LM-1200 | Serial ASCII protocol |
| **Phoropters** | Marco TRS-5100, Nidek RT-5100 | Proprietary serial |
| **Tonometers** | Topcon CT-1P, Huvitz HNT-1P, Reichert ORA | Serial or CSV export |
| **Meibography** | Medmont, Firefly, LipiView | Proprietary export |
| **Specialty (VT)** | Sanet Vision Integrator, RightEye, NovaSight | Proprietary APIs |
| **Aesthetics** | VISIA Skin Analysis, OBSERVE 520, Antera 3D | Proprietary export |
| **Syntonics** | Eyeluxe, Syntonac | Manual entry (wavelength, duration) |

### 12.2 Four Integration Patterns

OSOD supports four data ingestion paths. A single practice may use all four simultaneously for different devices.

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  DICOM Push  │   │ Folder Watch │   │  Serial/USB  │   │ Manual / AI  │
│  (OCT, VF,   │   │ (autorefr,   │   │ (phoropter,  │   │ (screenshot  │
│   cameras)   │   │  lensometer) │   │  tonometer)  │   │  → extract)  │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                   │                  │
       ▼                  ▼                   ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Device Data Ingestion Layer                         │
│  Parser interface: each device model gets a parser implementation      │
│  Patient matching: MWL ID, timestamp+room, or manual confirmation     │
│  All paths produce the same output: structured DeviceReading           │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
                    device.reading_received event
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
               Audit log   Patient    Clinical module
                          timeline   (auto-populate
                                      exam fields)
```

### 12.3 Foundation Data Model (Phase 1)

These tables ship with Phase 1. They're empty until equipment integrations are built, but the schema is ready.

#### equipment_registry
Practice-configurable device list. What equipment does THIS office have?

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| practice_id | uuid | FK → practices |
| name | text | Human-readable: "Exam Room 1 - Zeiss Cirrus OCT" |
| manufacturer | text | "Zeiss", "Topcon", "Marco", "Huvitz", etc. |
| model | text | "Cirrus 6000", "TRS-5100", "KR-1W" |
| device_category | text | "oct", "visual_field", "autorefractor", "phoropter", "tonometer", "retinal_camera", "topographer", "lensometer", "meibographer", "specialty", "aesthetics" |
| integration_type | text | "dicom", "folder_watch", "serial", "manual" |
| connection_config | jsonb | Integration-specific: `{ "ae_title": "CIRRUS", "port": 4242 }` or `{ "watch_path": "/data/autorefractor/" }` or `{ "serial_port": "/dev/ttyUSB0", "baud": 9600 }` |
| location | text | "Exam Room 1", "Pre-Test Station", "Imaging Room". Nullable. |
| data_types | text[] | What this device produces: ["oct_scan", "retinal_thickness_map"] or ["sphere", "cylinder", "axis", "pd"] |
| parser_id | text | Which parser to use for this device's output. Nullable until parser built. |
| is_active | boolean | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

#### device_readings
Where ALL incoming device data lands, regardless of source. One table, structured payload.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| practice_id | uuid | FK → practices |
| equipment_id | uuid | FK → equipment_registry |
| patient_id | uuid | FK → patients. Nullable until matched. |
| matched_by | text | "mwl" (DICOM worklist), "room_assignment", "manual", "ai_match" |
| reading_type | text | "refraction", "iop", "oct_scan", "visual_field", "topography", "meibography", "retinal_image", "skin_analysis", etc. |
| structured_data | jsonb | Parsed, structured result: `{ "sphere_od": -2.50, "cylinder_od": -0.75, "axis_od": 180 }` |
| raw_data_ref | text | Path to original file (DICOM, image, CSV). Nullable. |
| source_type | text | "dicom", "folder_watch", "serial", "manual", "ai_extraction" |
| confidence | decimal | For AI-extracted data: extraction confidence. Null for direct integration. |
| needs_review | boolean | True if AI-extracted or low-confidence match. Staff must confirm. |
| reviewed_by | uuid | FK → users. Nullable. |
| reviewed_at | timestamptz | Nullable. |
| captured_at | timestamptz | When the device took the reading (not when OSOD received it) |
| created_at | timestamptz | When OSOD ingested the reading |

### 12.4 Foundation Events

| Event | When | Subscribers |
|-------|------|-------------|
| `device.reading_received` | Any integration path delivers data | Audit, patient timeline, clinical module (auto-populate exam fields) |
| `device.reading_matched` | Unmatched reading linked to patient | Audit, patient timeline |
| `device.reading_reviewed` | Staff confirms AI-extracted reading | Audit |

### 12.5 DICOM Strategy

**Orthanc** as the DICOM server — lightweight, single binary, REST API, runs on localhost. Ships in Docker Compose alongside PostgreSQL. Provides:
- **Modality Worklist (MWL):** Devices query OSOD for today's patient list → technician selects patient from dropdown instead of retyping. Eliminates mismatch errors.
- **Storage SCP (C-STORE):** Devices push completed images/data to Orthanc.
- **DICOMweb plugin:** Future FHIR ImagingStudy compatibility.

OSOD polls Orthanc's REST API for new studies, matches to patient, writes to `device_readings`.

### 12.6 Parser Architecture

Each device model gets a parser that converts raw device output to structured `device_readings.structured_data`. The parser interface:

```typescript
interface DeviceParser {
  parserId: string                    // "topcon-kr1w", "zeiss-cirrus", etc.
  supportedModels: string[]           // Device models this parser handles
  parse(rawInput: Buffer | string): DeviceReadingPayload
}

interface DeviceReadingPayload {
  readingType: string                 // "refraction", "iop", "oct_scan"
  structuredData: Record<string, unknown>  // Zod-validated per reading type
  capturedAt?: string                 // ISO 8601 timestamp from device
  rawDataRef?: string                 // Path to original file
}
```

Parsers are pluggable — community contributors can add support for their devices. Each parser is a file in `src/server/modules/equipment/parsers/`. No parsers ship in Phase 1, but the interface and registry are ready.

### 12.7 Build Order for Equipment

| Phase | What Ships |
|-------|-----------|
| **Phase 1** | `equipment_registry` and `device_readings` tables. Event definitions. Parser interface. No actual parsers. |
| **Phase 4** (Clinical EHR) | Orthanc in Docker Compose. DICOM ingestion for OCT + retinal cameras. Folder-watch for autorefractors. `device.reading_received` → auto-populate exam fields. |
| **Phase 5** (Specialty) | Specialty-specific parsers: meibography for dry eye, SVI/RightEye for VT, VISIA for aesthetics. |
| **Phase 6** (Advanced) | Serial protocol parsers for phoropters/tonometers. DICOM MWL worklist service. DICOMweb/FHIR bridge. |
| **Community** | Any device parser. The interface is open — independent O.D.s with a specific device can contribute a parser for their equipment. |

---

## 13. What Phase 1 Does NOT Include (But the Foundation Supports)

| Future Feature | Phase | Foundation Ready? |
|----------------|-------|-------------------|
| Clinical encounters / exam forms | Phase 4 | Event bus + module structure ready. Add `encounters` module. |
| E-prescribing (WENO) | Phase 2 | Agent gateway ready for WENO API integration. |
| Billing / EDI | Phase 3 | Event bus ready. `encounter.saved` will flow to billing subscriber. |
| Specialty modules (VT, dry eye, ortho-K) | Phase 5 | Module structure + service lines ready. Each specialty = new module. |
| Aesthetics module | Phase 5 | Service line architecture built. Aesthetics = parallel service line + module. |
| Pictorial patient timeline | Phase 4 | audit_events + domain events provide the data. Timeline is a UI layer over existing events. |
| Equipment parsers + DICOM | Phase 4-6 | Equipment registry, device_readings table, parser interface, events — all in Phase 1. |
| Voice input (AR glasses) | Future | Agent API accepts structured input regardless of source. |

---

## 14. Development Environment

### Docker Compose (PostgreSQL + Orthanc)

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

  orthanc:
    image: orthancteam/orthanc:24.12.1
    ports:
      - "8042:8042"   # REST API + web viewer
      - "4242:4242"   # DICOM port (C-STORE, MWL)
    volumes:
      - orthanc_data:/var/lib/orthanc/db
    environment:
      ORTHANC__REGISTERED_USERS: '{"osod": "osod_dev"}'
    profiles:
      - equipment     # Only starts when explicitly requested: docker compose --profile equipment up

volumes:
  pgdata:
  orthanc_data:
```

Orthanc is behind a Docker profile — it doesn't start by default. Practices without DICOM equipment don't need it. When needed: `docker compose --profile equipment up`.

### Dev Workflow

```bash
# Start database
docker compose up -d

# Run migrations
npm run db:migrate

# Seed development data
npm run db:seed

# Start dev server (backend + frontend concurrent)
npm run dev
```

### Seed Data

Development seed creates:
- 1 practice ("IVA — Integrated Vision & Aesthetics")
- 2 service lines ("Eyecare", "Aesthetics")
- 3 providers (Dr. Bang [eye+aesth], Dr. Smith [eye], Sarah [aesth])
- 5 appointment types per service line
- 20 sample patients with insurance and alerts
- 1 week of sample appointments
- 1 admin user, 1 staff user
- 1 local agent key, 1 cloud agent key

---

## 15. Testing Strategy

- **Unit tests:** Zod schemas, business logic in service files, event bus behavior
- **Integration tests:** API endpoints hit real PostgreSQL (test database, migrated fresh per suite). No mocks for the database.
- **Event cascade tests:** Verify that creating a patient fires `patient.created`, which the audit handler receives and writes to `audit_events`
- **Auth tests:** JWT flow, API key validation, permission enforcement
- **Vitest:** All tests. TypeScript-native. Fast. Same config as Vite.

---

## 16. Non-Functional Requirements

- **HIPAA audit trail:** Every PHI access logged. Append-only. No exceptions.
- **No PHI in application logs:** Winston/Pino for app logs. Audit trail for PHI access events. Separate concerns.
- **Encryption in transit:** TLS required for all non-localhost connections.
- **Encryption at rest:** PostgreSQL with encrypted storage (practice responsibility for local deployment).
- **No cloud dependency:** Fully functional on localhost with no internet. Cloud LLM is optional.
- **Sub-200ms API responses:** For all CRUD operations at single-practice scale.
- **Accessible:** WCAG 2.1 AA for the React frontend. Staff use this all day.
