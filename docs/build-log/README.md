# OSOD Build Log

This is the human-readable history of OSOD. Each file in this directory covers one major chunk of work — what we built, why, what could break, and how to fix it.

It's written for two audiences:

1. **Independent O.D.s and practice managers** who want to understand what their software does and how to troubleshoot when something goes wrong. You don't need to read code to follow these.
2. **Developers contributing to OSOD** who need the WHY behind the architecture, not just the what.

## How to read these

Each chunk follows the same structure:

- **What we built** — plain English summary of the feature
- **Why this design** — the trade-offs and rationale
- **Key files** — where to look in the code
- **Test coverage** — what's verified and what isn't
- **Known limitations / deferred work** — what's intentionally not in this version
- **How to verify locally** — commands to prove it works
- **Rollback plan** — what to do if you need to undo this
- **Common breakage and fixes** — what's likely to go wrong and how to handle it

## The chunks (in build order)

| # | Chunk | What it gives you |
|---|-------|------------------|
| 00 | [Foundation](00-foundation.md) | Database schema, auth (JWT + API keys), event bus, audit trail, config |
| 01 | [Schema V2](01-schema-v2.md) | Treatment library, permissions, guardian linking, FHIR-aligned patient fields |
| 02 | [Scheduling](02-scheduling.md) | Provider calendars, appointment CRUD, availability engine, status lifecycle |
| 03 | [Patients](03-patients.md) | Patient CRUD, search, insurance, guardians, structured alerts |
| 04 | [Practice admin](04-practice-admin.md) | Settings, service lines, users, roles, treatment library, body areas, appointment types |
| 05 | [Audit query API](05-audit-query.md) | Search and entity history over the audit trail |
| 06 | [Equipment registry](06-equipment-registry.md) | Device CRUD + device readings (manual entry, prep for DICOM/parser integrations) |
| 07 | [Billing data model](07-billing-data-model.md) | Fee schedules, charges, payments, adjustments, patient ledger |

## What's NOT in OSOD yet

These are intentionally deferred. Most are blocked on either external API signups, clinical input from a practicing O.D., or both.

- **Clinical exam module** (21-point exam, specialty modules) — needs Eric's red-pen on every field
- **Claim.MD integration** (claim submission, ERA/835 parsing) — needs Claim.MD account
- **PVerify integration** (eligibility verification, weather report) — needs PVerify account
- **WENO integration** (e-prescribing) — needs WENO account
- **Patient portal** (statements, online payment, scheduling)
- **Frontend UI** — currently API-only; React app comes later
- **Equipment parsers** (DICOM, folder watch, serial) — table is ready, parsers are not
- **TZ-aware scheduling** — provider schedule times currently treated as UTC; full timezone support is Phase 2.5

## Status as of the last merge to main

- **Tests:** 257/257 passing
- **TypeScript:** clean (`npx tsc --noEmit`)
- **Modules on main:** auth, schedule, patients, practice, catalog, audit, equipment, billing
- **Endpoints:** ~80 across all modules
- **Database tables:** 24 tables + 1 view across 3 migrations

## How OSOD itself is built (the daily loop)

The repo follows a strict pattern:

1. **Feature branch per module** — `feat/module-name`. Never commit straight to main.
2. **Small, named commits** — usually 1 commit per "concept" (e.g., the billing module is 7 commits, one per sub-service).
3. **Tests pass on the feature branch** before merge.
4. **Push the feature branch to GitHub regularly** as a remote checkpoint.
5. **Merge with `--no-ff`** to preserve the merge commit on main (makes history easier to read).
6. **Push main only after a green test run.**

This means if anything breaks, you can identify the exact commit that introduced the problem with `git bisect` and either revert that one commit or roll back to before the merge. It's the safest pattern for an open source project that real practices will depend on.
