> Historical bot guidance below is superseded by AGENTS.md: poll CodeRabbit and PR-Agent at the final head; do not trigger or wait for the former bot. Adjudicate all existing findings.

# Three-Role Permission Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five shipped practice roles with Provider, Staff, and Admin while enforcing practice-wide operational reads, constrained writes, provider-only clinical authorship/signature, Admin-only financial and inventory correction, and a safe fixture-tested migration.

**Architecture:** `mcp/src/authz/roles.ts` remains the canonical role and AccessPolicy compiler. Each role receives separate practice-read and constrained-write rules so broad reads cannot widen writes. A dry-run-first migration creates three new canonical policies and conditionally rebinds legacy membership access entries without running against Iris in this PR.

**Tech Stack:** TypeScript, Node test runner, Medplum FHIR R4 `AccessPolicy` and `ProjectMembership`, React/Vite.

**Spec:** `/Users/ericr.bang/GitHub/performance-od/decisions/2026-08-13-odos-three-role-model-provider-staff-admin.md`, the attached kickoff, and Eric's 2026-08-13 approval/correction message.

## Global Constraints

- Work only on `drbang-iva/three-role-model`, based on `origin/main` commit `344e0c6e3853e2ed0beb12a64f3bcf9b6b0ae679`.
- Do not touch `mcp/src/clinical-graph/provider-assignment-endpoint.ts`, cross-project tenancy code, `ui/src/lib/roles.ts`, or `policy/observation-status-machine.ts`.
- Do not run the migration against Iris or any live/shared Medplum instance; prove it with deterministic fixtures only.
- Do not inspect, delete, modify, or verify ownership of any live account; every test identity is synthetic fixture data.
- Keep `ODOS_PRACTICE_ROLE_SYSTEM` exactly `https://odos2020.com/fhir/NamingSystem/practice-role`.
- Provider correction authority is clinical only. Payment void/day seal/margins and inventory count/pricing correction belong to Admin only.
- Preserve patient-compartment and other resource-specific write gates while making the named operational read surface practice-scoped for all three roles.
- Do not add medical terminology or regulatory citations; no Mandate 14 ledger row is required for this authorization-only slice.
- Do not merge the PR. Codex is the author, so Fable/Opus must independently evaluate the exact final head.

---

### Task 1: Canonical Three-Role Registry and Split AccessPolicy Rules

**Files:**
- Modify: `mcp/src/authz/roles.ts`
- Modify: `mcp/tests/v05a-authz.test.ts`
- Modify: authorization tests that use the retired `PracticeRoleId` values

**Interfaces:**
- Produces: `PracticeRoleId = "provider" | "staff" | "admin"` and canonical role declarations.
- Produces: separate read and write rules for the same resource types, with practice reads carrying no compartment criterion.
- Produces: `payment.void`, `inventory.adjust`, and `inventory.price` business actions.

- [ ] **Step 1: Write failing registry and policy tests**

Add tests that require exactly three role IDs; verify every role has practice-scoped read rules for Patient, clinical, insurance, and scheduling resources; verify Staff write rules retain compartment/criteria fences; verify Staff lacks clinical sign, post-final write authority, payment correction/day seal/margins, and inventory correction/pricing; verify Provider lacks financial/inventory correction; verify Admin lacks clinical sign.

- [ ] **Step 2: Run focused authorization tests and capture RED**

Run: `node --import tsx --test tests/v05a-authz.test.ts`

Expected: failures showing the five-role registry, scoped reads, Staff day-seal grant, and missing correction actions.

- [ ] **Step 3: Implement the minimal three-role registry**

Build shared practice-read rules and separate Staff, Provider, and Admin write-rule arrays. Give Staff preliminary-finding writes and routine custody operations; extend those clinical rules for Provider; extend financial/inventory/admin rules for Admin. Replace the admin wildcard write grant with explicit rule groups so Admin cannot bypass clinical constraints.

- [ ] **Step 4: Run focused authorization tests and capture GREEN**

Run: `node --import tsx --test tests/v05a-authz.test.ts`

Expected: all focused authorization tests pass with zero failures.

- [ ] **Step 5: Update retired role references and typecheck**

Update active authorization callers, fixtures, and assertions to the new role IDs. Preserve non-role clinical vocabulary such as provenance source labels when it is not a `PracticeRoleId`.

Run: `npm run build` from `mcp/`.

### Task 2: Provider-Only Authorship, Signature, and Final-State Enforcement

**Files:**
- Modify: `mcp/src/index.ts`
- Modify: `mcp/src/clinical-graph/protocol-endpoint.ts`
- Modify: `mcp/src/authz/roles.ts`
- Modify: `mcp/src/fhir/scribeAttestation.ts` only where active role identifiers require replacement
- Modify: `mcp/src/series-tracker/series-tracker-endpoint.ts`
- Modify: focused protocol, attestation, and role tests

**Interfaces:**
- Consumes: `clinical.sign` from the Provider declaration.
- Produces: route-level and handler-level `clinical.sign` enforcement for sign cleanup.
- Produces: Staff write constraints that allow create/edit of preliminary findings but reject final and post-final transitions, plus an Encounter constraint rejecting `finished`.

- [ ] **Step 1: Write failing sign and status tests**

Add a handler test where Staff receives 403 before any sign-cleanup side effect and Provider succeeds. Add compiled-policy tests proving Staff cannot create/finalize/correct a final Observation or finish an Encounter while Provider can finalize and correct.

- [ ] **Step 2: Run focused tests and capture RED**

Run the exact protocol/sign and AccessPolicy test files with `node --import tsx --test`.

Expected: Staff currently passes the chart-write gate or lacks the required constraint.

- [ ] **Step 3: Implement minimal route, handler, and policy gates**

Change the Express route authenticator and `handleProtocolSignCleanupRequest` business-action check to `clinical.sign`. Add role-specific FHIRPath constraints in `roles.ts` without editing `policy/observation-status-machine.ts`.

- [ ] **Step 4: Run focused tests and capture GREEN**

Run the same test files and confirm zero failures.

### Task 3: Admin-Only Financial Correction

**Files:**
- Modify: `mcp/src/payments/payment-credit-handler.ts`
- Modify: `mcp/tests/paymentCreditHandler.test.ts`
- Modify: `mcp/tests/patientPaymentsHandler.test.ts`
- Modify: `mcp/tests/paymentEndpoint.test.ts`
- Modify: day-close tests as required by the renamed roles

**Interfaces:**
- Consumes: `payment.charge`, `payment.void`, and `payment.seal-day`.
- Produces: Staff/Provider 403 and Admin authorization for void and day seal; taking and applying routine payments remains available to Staff.

- [ ] **Step 1: Write failing financial-custody tests**

Require Staff to take/list/apply payment credits while receiving 403 on void and seal-day. Require Provider to receive the same correction denials. Require Admin to void and seal.

- [ ] **Step 2: Run focused payment tests and capture RED**

Run: `node --import tsx --test tests/paymentCreditHandler.test.ts tests/patientPaymentsHandler.test.ts tests/paymentEndpoint.test.ts tests/dayClose.test.ts`

- [ ] **Step 3: Implement action-specific authorization**

Make the void path resolve `payment.void`; leave routine payment paths on `payment.charge`. Ensure returned UI capability flags do not advertise void to Staff or Provider.

- [ ] **Step 4: Run focused payment tests and capture GREEN**

Run the same command and confirm zero failures.

### Task 4: Inventory Receipt Versus Correction

**Files:**
- Modify: `mcp/src/authz/roles.ts`
- Modify: `mcp/tests/v05a-authz.test.ts`
- Modify: `ui/src/lib/optical-frames.ts`
- Modify: `ui/src/scenes/OpticalFrames.tsx`
- Modify: relevant frame inventory tests

**Interfaces:**
- Produces: Staff create/read and constrained forward-transition access for frame inventory units.
- Produces: Staff read-only access to variant settings and 403 for deletion, reversal, arbitrary unit-field change, and pricing writes.
- Produces: Admin correction/pricing authority; Provider receives neither.

- [ ] **Step 1: Write failing compiled-policy and frame behavior tests**

Require immutable Staff unit identity, catalog URL, receipt time, and location; no delete; only valid forward unit-status transitions. Require variant-settings writes only for Admin and prove the role-aware receipt surface does not offer price inputs to Staff.

- [ ] **Step 2: Run focused MCP/UI frame tests and capture RED**

Run the exact frame tests from `mcp/` and `ui/`.

- [ ] **Step 3: Implement split rules and role-aware UI behavior**

Add the minimal FHIRPath constraint and read/write split. Pass authenticated practice roles into the existing frame receipt surface without changing the separate presentation-only `ui/src/lib/roles.ts` module.

- [ ] **Step 4: Run focused MCP/UI frame tests and capture GREEN**

Run the same files and confirm zero failures.

### Task 5: Dry-Run-First Legacy Membership Migration

**Files:**
- Create: `scripts/migrate-three-role-model.ts`
- Create: `tests/setup-wizard/migrate-three-role-model.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: a pure migration planner mapping legacy policy tags to canonical policy references while preserving access parameters.
- Produces: a CLI that prints a plan by default and requires `--apply` for conditional audited writes.
- Stops on: ambiguous legacy tags, missing IDs/versions, project ownership mismatch, unknown/unmappable policy references, or non-unique canonical policies.

- [ ] **Step 1: Write failing deterministic migration tests**

Cover the exact five-to-three mapping; parameter preservation; dedupe only for identical canonical reference plus identical parameters; unrelated access preservation; ambiguity, ownership, version, and unmappable-reference stops; dry-run zero writes; apply-mode If-Match and audit behavior; idempotent second run.

- [ ] **Step 2: Run migration tests and capture RED**

Run: `node --import tsx --test ../tests/setup-wizard/migrate-three-role-model.test.ts` from `mcp/`.

Expected: module-not-found before implementation.

- [ ] **Step 3: Implement the pure planner and guarded CLI**

Create three new canonical policies from the shipped builders rather than renaming old policies. Rebind access references according to the approved fold-in map, preserve parameters byte-for-byte, patch with `If-Match`, and record role/policy changes through the existing audit runtime. Keep legacy role strings isolated to this migration file and never accept them in runtime/UI role types.

- [ ] **Step 4: Run migration tests and capture GREEN**

Run the same command and confirm zero failures. Do not execute the CLI against any server.

### Task 6: UI Role Catalog and Routing

**Files:**
- Modify: `ui/src/lib/practice-roles.ts`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/scenes/settings/StaffSettings.tsx`
- Modify: `ui/src/components/AppShell.tsx` only if label rendering needs adaptation
- Modify: `ui/tests/roleRouting.test.tsx`
- Modify: `ui/tests/staffSettings.test.tsx`
- Modify: `ui/tests/appShell.test.tsx`

**Interfaces:**
- Produces: UI-visible roles Provider, Staff, and Admin / Manager.
- Produces: Provider defaults to Clinic, Staff/Admin default to Desk, and multi-role Provider+Admin can cross sides.

- [ ] **Step 1: Write failing UI role tests**

Require exactly three invite options, Staff default, correct labels, role-chip rendering, and routing for each single/multi-role combination.

- [ ] **Step 2: Run focused UI tests and capture RED**

Run the exact three UI test files with `node --import tsx --test`.

- [ ] **Step 3: Implement minimal UI role changes**

Update only the real practice-role module and its consumers. Do not edit `ui/src/lib/roles.ts`.

- [ ] **Step 4: Run focused UI tests and capture GREEN**

Run the same files and confirm zero failures.

### Task 7: Universal Audit and Live-Pattern Fixture Acceptance

**Files:**
- Modify: `mcp/src/authz/odosAudit.ts`
- Modify: `mcp/tests/staffRouteAudit.test.ts`
- Modify: `mcp/tests/clinicianRbacLive.test.ts` or rename it to a three-role-neutral filename
- Modify: fixture helpers required to provision separate Staff and Provider identities

**Interfaces:**
- Produces: identical FHIR audit-row behavior for Staff, Provider, and Admin.
- Produces: fixture/live-pattern assertions for the approved role matrix without using Iris.

- [ ] **Step 1: Write failing audit-equivalence tests**

Run the same Patient read through staff-route clients for each role and compare every audit field except the expected actor identity/role values.

- [ ] **Step 2: Write failing live-pattern role matrix**

Using disposable fixture identities and generated policies, require Staff read of an unassigned patient, preliminary finding creation, payment-taking access, and 403 for sign/finalize/void/inventory adjustment. Require Provider sign and post-final correction but 403 for financial/inventory correction. Require Admin void/day-seal/inventory correction.

- [ ] **Step 3: Run focused acceptance tests and capture RED**

Run the exact audit and live-pattern fixture files.

- [ ] **Step 4: Implement only missing audit/fixture seams**

Rename audit visibility checks from retired roles and keep recording universal. Do not add role exemptions.

- [ ] **Step 5: Run focused acceptance tests and capture GREEN**

Run the same command and report passed/failed/skipped counts.

### Task 8: Full Verification, PR Publication, and Handoff

**Files:**
- Modify: only files required by failing gates.
- PR description: include the tracked provider-assignment tenancy re-check and the sealed bundle.

**Interfaces:**
- Produces: exact-head branch, commit(s), pushed draft PR, review-bot status, and independent-evaluation handoff.

- [ ] **Step 1: Confirm forbidden files and tenancy code are untouched**

Run `git diff --name-only origin/main...HEAD` and inspect the complete diff.

- [ ] **Step 2: Run full verification gates**

Run MCP tests, MCP build, UI tests, UI build, and root `npm run preflight`. Record actual totals, pass/fail/skipped counts, and build exit results.

- [ ] **Step 3: Commit intentionally and push**

Use focused commits without bypassing hooks. Push `drbang-iva/three-role-model` normally; never force-push.

- [ ] **Step 4: Open a draft PR targeting `main`**

Include the sealed bundle, exact current-state role/action mapping, migration mechanism, verification evidence, explicit no-live-migration/account-work statement, the synthetic acceptance matrix an operator should repeat post-merge, and tracked re-check of `decisions/2026-08-13-odos-provider-assignment-appointment-anchored-tenancy.md`.

- [ ] **Step 5: Adjudicate current-head bot findings**

Poll PR-Agent and Greptile at the exact head, reply to every present thread, and rerun affected gates after fixes. Do not invoke CodeRabbit.

- [ ] **Step 6: Stop for independent evaluation**

Return the exact PR head and sealed bundle for Fable/Opus. Do not merge and do not claim the slice evaluated.
