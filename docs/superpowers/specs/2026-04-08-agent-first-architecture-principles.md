# Agent-First Architecture Principles

**Date:** 2026-04-08
**Status:** Approved
**Author:** Claude (architect) + Eric Bang, O.D. (owner)
**Related:** [2026-04-07-osod-foundation-design.md](2026-04-07-osod-foundation-design.md) — codifies the "agent-first" principle stated on line 17 of the foundation spec

---

## Why This Document Exists

The foundation spec commits to "agent-first: every action is an API call; the UI is one client, agents are another." This document spells out the **techniques** that make that principle real, so future sessions can reference them when building any screen, endpoint, or module.

**Quick test:** If any future code violates one of the 7 principles below, that code is wrong and should be rewritten. This is not a preference — it's what makes OSOD structurally different from Eyefinity, Foxfire, and every other closed-ecosystem EHR.

---

## The Core Principle

**The API is the product. The React UI is one face. Agents are another. A mobile app would be a third. All faces are thin clients over the same rigorous API.**

This is the opposite of how most EHRs were built (UI-first, backend is whatever the UI needs). It's why Eyefinity and Foxfire are locked down — their "API" is whatever fell out of the UI, not a real contract. OSOD starts from the other end: a rigorous, self-sufficient API that any client can consume.

---

## The 7 Techniques

### 1. Every Action Exists as an API Endpoint Before Any UI Exists

No business logic lives in React. Ever. If a button does something, there's a backend endpoint behind it. The React component is a thin presentation layer that reads from the API, writes to the API, and renders whatever comes back.

**Litmus test:** Could a headless script replicate everything a human can do in the UI by calling the API? If yes, agent-first passes. If no, there's UI-only logic and the principle has failed.

**OSOD status:** ✅ The PM backend passes this test because it was built API-first. 341 tests hit the API directly, zero frontend exists yet. When the React app is built, it just skins what's already there.

### 2. Routes Are Named by Domain Intent, Not by Screen

Screen-driven (❌):
```
GET  /screens/patient-profile-data
POST /forms/chief-complaint-submit
```

Intent-driven (✅):
```
GET  /patients/:id
POST /encounters/:id/chief-complaint
```

An agent reading the route list should understand the business domain just from the URLs. Screen-named APIs only make sense to whoever built the screen.

**OSOD status:** ✅ All existing routes are domain-named.

### 3. Rich Response Objects — Always Return Enough for the Next Decision

When a UI submits a form, it usually just needs `success: true`. Agents need more. Return:
- The updated resource
- Related resources that might now be relevant
- Next possible actions

Example:
```json
POST /encounters/:id/chief-complaint
{
  "encounter": { /* full updated object */ },
  "patient": { /* patient summary */ },
  "next_recommended_sections": ["hpi", "medical_history"]
}
```

The React UI ignores most of that and renders what it needs. An agent uses it to decide what to do next without making 5 more GET calls.

**OSOD status:** Partially implemented — needs to be enforced going forward on all write endpoints.

### 4. Domain Events Are the Nervous System

When anything happens, emit an event: `patient.created`, `encounter.opened`, `appointment.cancelled`. Agents subscribe to events and stay in sync without polling.

**OSOD status:** ✅ Done. Commit `9b822ab` (domain event wiring, 266 tests) — PatientService, ScheduleService, and EquipmentService emit events. The audit handler writes `previous_state + new_state` for every change. This is not just audit logging — it's the substrate agents use to reason about what happened and why.

### 5. Audit Trail Is a First-Class Feature, Not a Side Effect

Every change records who/what/when/before/after. Agents need this because:
- They make mistakes and need to undo
- They need to explain their reasoning ("I changed X because at 3:47pm the insurance field became Y")
- They need to avoid stepping on human edits (optimistic concurrency control)

**OSOD status:** ✅ Done. Commit `f3fe94c` (audit query API) — searchable by filters AND entity history. Both humans and agents query the same log.

### 6. Shared Validation via Zod Schemas

Zod schemas are defined once in the backend and shared with:
- The backend (validates incoming requests)
- The frontend via Hono RPC (validates before sending + provides TypeScript types)
- The agent layer via auto-generated tool manifest (see #7)

**Hard rule:** If the backend doesn't enforce a rule, agents can violate it. Every validation, every permission check, every business constraint must live behind the API. The UI can render errors beautifully but it's never the only thing stopping bad data.

**OSOD status:** ✅ Zod schemas already in use throughout the backend. Frontend will inherit them via Hono RPC once the frontend is scaffolded.

### 7. Expose the API as MCP Tools (Future)

**This is the technique most projects miss.** Agents don't call REST APIs directly — they call *tools*. MCP (Model Context Protocol) is the standard. OSOD exposes every API endpoint as an MCP tool with:
- A name (matching domain intent)
- A description in natural language ("Schedule an appointment for a patient")
- Input schema (from Zod, auto-generated)
- Output schema (same)

An agent connected to the OSOD MCP server doesn't need to know OSOD uses Hono, doesn't need to build URLs, doesn't need to handle auth headers. It just sees tools like `schedule.create_appointment`, `patients.update`, `encounters.add_chief_complaint` — and calls them with natural language intent.

- The React UI is one client (using Hono RPC).
- The MCP server is another client (wrapping the same API for agents).
- Both talk to the exact same endpoints.

**OSOD status:** ❌ Not built yet. Future layer. The API itself will be ready when this layer needs to be added — MCP wrapping is mostly mechanical once the API is stable.

---

## The Build Order

```
Step 1: Build the API with tests.                    ✅ Done for PM (341 tests)
Step 2: Scaffold the React client using Hono RPC.     ← next
Step 3: Build an MCP server that wraps the API.        ← comes later
Step 4: Connect agents (Iris, Netra, Maya, etc.) to    ← final layer
        the OSOD MCP server.
```

Steps 3 and 4 wait until the backend and frontend are stable. Because the backend was built API-first, adding an MCP layer later is mostly mechanical — each route gets a corresponding tool definition. No rewrite.

---

## Daily Red-Penning: The Two-Client Rule

When building any clinical screen together, remember:

> *"If I can only do this action through the UI, I've built it wrong. If I can do it via curl and also via the UI, I've built it right."*

This keeps the architecture honest. Every time a React component is written, the question is: does the backend endpoint exist for this action? If not, write the backend endpoint first, test it, then write the UI on top.

**Enforcement:** Main conversation should surface this rule whenever a new screen or action is being designed. If a proposed feature would require UI-only logic, stop and redesign it as a backend endpoint first.

---

## Status Scorecard (as of 2026-04-08)

| Principle | Status |
|---|---|
| 1. API-first, no UI contamination | ✅ |
| 2. Domain-intent routes | ✅ |
| 3. Rich response objects | ⚠️ Partial — enforce going forward |
| 4. Domain events | ✅ |
| 5. Audit trail | ✅ |
| 6. Shared Zod schemas | ✅ |
| 7. MCP server for agents | ❌ Future layer |

5 of 7 principles are fully implemented. Principle 3 needs discipline going forward. Principle 7 is a future layer that the current architecture is already prepared for.

---

## What This Buys Us

- **Iris, Netra, Maya, and any future IVA agents** can operate OSOD without knowing its internals
- **The React UI stays thin** — no business logic to maintain in two places
- **Future mobile/tablet apps** can be built against the same API with zero backend changes
- **Third-party integrations** (Foxfire migration tools, reporting apps, community-built extensions) have a stable contract
- **OSOD can't become another Eyefinity** — the API is the product, and the API is open by design (AGPL)

---

## When to Reference This Document

- Before designing any new module
- Before adding any React component
- When deciding where a piece of logic belongs (answer: backend, always)
- When an agent integration is proposed
- When tempted to add "just a small UI-only" feature (answer: no)
