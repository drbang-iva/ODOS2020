# 07 — Billing Data Model

The largest non-clinical chunk: fee schedules, charges, payments, applications, adjustments, and the patient ledger. Built across 7 small commits with a feature-branch checkpoint after each one. This is the chunk where the slow-and-careful pattern paid off the most.

**Merged to main:** `0072d6d`
**Tests at end:** 257/257
**Commits:** 7

## What we built

Five sub-services, all wired into one billing module.

### Fee schedules
A practice can have multiple price lists — Medicare, Medicaid, custom cash, vision plan S-codes. One is marked as the **default** and is used by the charge service when prices aren't specified explicitly. Each schedule is a list of CPT/HCPCS codes with prices in cents.

### Charges
A single billable line item. CPT code, ICD-10 diagnoses, units, dollar amount. Status lifecycle (`pending → submitted → paid → denied → voided → partial`) — Phase 1 only writes `pending` and `voided`. The other statuses are wired in for the future Claim.MD integration.

Auto-price lookup: if you create a charge without specifying `unitAmountCents`, the service looks it up from the practice's default fee schedule. So a comprehensive exam create is just CPT code + ICDs — the price flows automatically.

### Payments + applications
**The trickiest concept.** Two key pieces:

1. **One payment can apply to multiple charges.** A $500 check covering three visits is ONE `payments` row + THREE `payment_applications` rows.

2. **Patient vs carrier types.** Patient payments come from the patient (cash, card, check). Carrier payments come from insurance (EOB, ERA). Same table, different `payment_type`.

**Atomic create-and-apply.** When you create a payment with applications, the whole thing is one database transaction. If any application is invalid (overpaying a charge, applying to a voided charge, charge doesn't exist), the transaction rolls back. No half-created payments.

**Unapplied credit tracking.** A $500 payment with $300 of applications leaves $200 as `unapplied_cents`. You can later use `applyToCharge()` to put that credit toward a new charge. Updates atomically.

### Adjustments
Write-offs, contractual reductions, refunds, courtesy discounts, sliding-scale, "other." Always tied to a specific charge. They reduce the charge's unpaid balance the same way a payment does.

The classic use case: VSP allows $175 on a $225 charge. You post a carrier payment for $175 and a contractual adjustment for $50. The charge is now zeroed out.

### Patient ledger (read-only)
A computed view (`patient_ledger`) joins charges, payments, applications, and adjustments to compute each patient's running balance:
```
balance = total_charged - patient_payments - carrier_payments - adjustments
```
Voided charges and voided payments are excluded by the view's WHERE clauses.

Two endpoints:
- **Summary** — one row with running totals and balance
- **Charge details** — list of every charge for the patient with paid/adjusted/balance breakdown

## Why this design

**Cents, not dollars. Integers, not floats.** Every money column is `INT` storing cents. We never use floating point. This is non-negotiable for billing — `0.1 + 0.2 !== 0.3` in floating point and you get pennies wrong over thousands of transactions.

**Transactions are not optional.** Every money-moving operation (`createPayment` with applications, `applyToCharge`) uses Postgres `BEGIN`/`COMMIT`/`ROLLBACK`. If anything fails mid-operation, nothing is written. Half-applied payments would corrupt the ledger and there's no easy way to fix it after the fact.

**Voided things stay in the database.** Voiding a charge or a payment is a soft delete: it sets `voided_at` and excludes the row from balance calculations, but the row stays for the audit trail. You can never make a billing record disappear — only mark it inactive.

**Phase 1 is wired for Phase 2 (claims) without code changes.** The charge status lifecycle includes `submitted`, `paid`, `denied`, and `partial` — values that Phase 1 never writes. When the Claim.MD integration ships, it'll write to these statuses. The schema doesn't change.

**The patient_ledger is a database view, not a service-layer calculation.** Computing balances in SQL is faster, simpler, and doesn't require loading all charges into memory. The trade-off is that the view is fixed — if you need a different aggregation, you write a new view. Easier than fighting with ORMs.

## Key files

```
src/server/db/migrations/
└── 003_billing.sql                      # 6 tables + 1 view + partial unique index
src/server/modules/billing/
├── schemas.ts                            # All Zod input schemas
├── services/
│   ├── fee-schedule.service.ts
│   ├── charge.service.ts
│   ├── payment.service.ts
│   ├── adjustment.service.ts
│   └── ledger.service.ts
└── routes/
    ├── fee-schedule.routes.ts
    ├── charge.routes.ts
    ├── payment.routes.ts
    ├── adjustment.routes.ts
    └── ledger.routes.ts
tests/server/modules/billing/             # 5 test files, 68 tests total
```

The split-service-files pattern was a deliberate choice for billing. Earlier modules used one big `service.ts`. Billing has enough complexity that one file would have been ~1500 lines and hard to navigate. Splitting by sub-domain (one file per concept) makes each file ~300 lines and focused on one thing.

## API endpoints

**Fee schedules** (`billing:read` to view, `billing:submit` to write):
- `GET/POST /api/billing/fee-schedules`
- `GET/PATCH/DELETE /api/billing/fee-schedules/:id`
- `GET/POST/PATCH/DELETE /api/billing/fee-schedules/:id/items[/:itemId]`

**Charges** (`billing:read`/`billing:submit`/`billing:void`):
- `GET/POST /api/billing/charges`
- `GET/PATCH /api/billing/charges/:id`
- `POST /api/billing/charges/:id/void`
- `GET /api/billing/charges/:id/balance`

**Payments**:
- `GET/POST /api/billing/payments`
- `GET /api/billing/payments/:id`
- `GET /api/billing/payments/:id/applications`
- `POST /api/billing/payments/:id/apply`
- `POST /api/billing/payments/:id/void`

**Adjustments**:
- `POST /api/billing/adjustments`
- `GET /api/billing/adjustments/charge/:chargeId`
- `GET /api/billing/adjustments/:id`
- `DELETE /api/billing/adjustments/:id`

**Ledger** (`billing:read`):
- `GET /api/billing/ledger/patient/:patientId` — summary
- `GET /api/billing/ledger/patient/:patientId/charges` — per-charge breakdown

## The commits (in order)

```
741862a feat(billing): commit 1/7 - migration 003_billing + Zod schemas + smoke test
1037b2d feat(billing): commit 2/7 - fee schedules service + routes + 17 tests
7bdb6d7 feat(billing): commit 3/7 - charges service + routes + 17 tests
72a27c6 feat(billing): commit 4/7 - payments + applications service + routes + 15 tests
2b7806d feat(billing): commit 5/7 - adjustments service + routes + 8 tests
01f6b69 feat(billing): commit 6/7 - patient ledger service + routes + 11 tests
3e63f58 feat(billing): commit 7/7 - wire all 5 billing routes into app + final verify
```

After each commit: full test suite + push the feature branch to GitHub. If anything broke, the bad commit would be obvious and `git revert` would handle it surgically.

## Test coverage

68 tests across 5 files:
- **fee-schedule** (17): create/list/update/deactivate, default flag swap, items CRUD, duplicate detection (CPT+modifier), modifier-aware lookup
- **charge** (17): create with explicit price, auto-lookup from default schedule, multi-unit math, modifier handling, missing schedule rejection, list with filters, update only when pending, void, balance calculation
- **payment** (15): create with applications atomic, leftover credit tracking, full credit (zero applications), reject overpayment, reject voided charge application, carrier payment validation, transaction rollback verification, applyToCharge after creation, void
- **adjustment** (8): create with type, reject for nonexistent/voided charge, list for charge, balance reduction, delete, isolation
- **ledger** (11): zero state, charge accumulation, patient payment subtraction, carrier payment subtraction, adjustment subtraction, **the combined math test** (multi-charge + carrier payment + adjustment + patient payment → correct final balance), voided charge exclusion, voided payment exclusion, charge details breakdown

**The combined math test in `ledger.test.ts` is the canary for the entire billing module.** It exercises the full pipeline end-to-end. If anything in charges, payments, adjustments, or the view is wrong, this test catches it.

## Bugs caught during the build

1. **NULL uniqueness gap on `fee_schedule_items`.** Same trap as Schema V2's `user_role_assignments`: Postgres treats NULL as distinct in unique constraints. Two items with the same CPT and no modifier would both be allowed. Fixed with a partial unique index where `modifier IS NULL`. Caught by the duplicate-detection test.

2. **Service called directly bypasses Zod defaults.** Tests call `service.create({ name: 'X' })` without going through schema parsing. Zod's `.default(false)` doesn't fire on direct calls. The DB insert was passing `undefined` and violating `NOT NULL`. Fixed two ways: (a) `?? false` in the service for `isDefault`, (b) created a service-level type alias that marks `isDefault` as truly optional so TypeScript matches the runtime behavior.

3. **Postgres returns DATE as Date object, not string.** First ledger test failed because `expect(date).toContain('2026-04-15')` doesn't work on Date objects. Fixed by converting through `.toISOString()` in the test.

4. **Postgres returns SUM as bigint string.** The view's COALESCE values come back as strings unless cast or converted. Fixed by `Number(...)` in the service after fetching.

## Known limitations

- **No claim submission.** Charges can be created and voided. Submitting them as 837P claims to a clearinghouse is a separate phase that needs Claim.MD setup.
- **No ERA/835 parsing.** Carrier payments must be entered manually from EOBs. ERA auto-posting comes with the Claim.MD integration.
- **No statements.** No statement generation, no auto-escalation, no Paubox or text-to-pay.
- **No write-off automation.** Adjustments are manual. No "auto-write-off small balances" rule.
- **No fee schedule import.** Adding 200 CPT codes to a schedule means 200 POST requests. A bulk import endpoint would be a small follow-up.
- **No reporting beyond the patient ledger.** AR aging, daily deposit, revenue by provider/CPT/payer, denial rates — all later phases.
- **Encounters don't exist yet.** Charges link to a `patient_id` and optional `appointment_id`, not an encounter. When the clinical module ships, charges will likely also link to an `encounter_id`.

## How to verify locally

```bash
# Run all billing tests
npx vitest run tests/server/modules/billing/

# Manual: full flow
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"eric@iva.com","password":"admin123!","practiceId":"<id>"}' | jq -r .accessToken)

# 1. Create a default fee schedule
curl -X POST http://localhost:3000/api/billing/fee-schedules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Cash Pay","isDefault":true}'

# 2. Add CPT 92004 at $225
curl -X POST http://localhost:3000/api/billing/fee-schedules/<schedule-id>/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"cptCode":"92004","amountCents":22500}'

# 3. Create a charge (auto-looks-up the price)
curl -X POST http://localhost:3000/api/billing/charges \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "patientId":"<patient-id>",
    "providerId":"<provider-id>",
    "serviceDate":"2026-04-08",
    "cptCode":"92004",
    "icd10Codes":["H52.13"],
    "units":1
  }'

# 4. Post a carrier payment + contractual adjustment
curl -X POST http://localhost:3000/api/billing/payments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "paymentType":"carrier",
    "paymentMethod":"eft",
    "payerName":"VSP",
    "amountCents":17500,
    "paymentDate":"2026-04-15",
    "applications":[{"chargeId":"<charge-id>","amountCents":17500}]
  }'

curl -X POST http://localhost:3000/api/billing/adjustments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "chargeId":"<charge-id>",
    "adjustmentType":"contractual",
    "amountCents":5000,
    "reason":"VSP allowed amount"
  }'

# 5. Check the ledger - should be balance: 0
curl http://localhost:3000/api/billing/ledger/patient/<patient-id> \
  -H "Authorization: Bearer $TOKEN"
```

## Rollback plan

Each commit can be reverted individually:

```bash
# Revert just commit 6 (ledger):
git revert 01f6b69
git push origin main

# Or revert the whole module via the merge commit:
git revert -m 1 0072d6d
git push origin main
```

The tables stay (revert removes the code, not the DB). To also drop the tables, you'd write a new migration `004_drop_billing.sql` and include the DROP TABLE statements. Don't manually drop tables in production — always do it through a migration so the change is tracked.

## Common breakage and fixes

**"Cannot create charge: No price provided and no fee schedule available"** — the practice has no default fee schedule. Either create one with `isDefault: true`, or pass `unitAmountCents` and `feeScheduleId` explicitly when creating the charge.

**"Cannot create charge: Price not found for CPT 92004"** — the default schedule exists but doesn't have an item for that CPT (or for that CPT+modifier combination). Add the item: `POST /api/billing/fee-schedules/<id>/items`.

**"Total applied exceeds payment amount"** — your applications array sums to more than the payment's `amountCents`. Either reduce an application, drop one, or increase the payment amount.

**"Cannot apply payment to voided charge"** — the charge was voided after you started entering the payment. You can't apply payments to voided charges (they don't have a balance). Either un-void the charge by creating a new charge or apply to a different one.

**"Cannot update X charge"** — only `pending` charges can be updated. If a charge is `submitted`, `paid`, `denied`, or `voided`, edits are rejected. To correct a non-pending charge, void it and create a corrected one.

**"Patient ledger shows negative balance"** — usually means an over-application or a refund. Check `getPatientChargeDetails` to see which charge is negative. Common causes: a payment was applied to a charge that was later partially adjusted (the adjustment + payment exceeded the charge), or a refund-type adjustment was added after the payment.

**"Voided payment still shows in totals"** — the `patient_ledger` view excludes payments where `voided_at IS NOT NULL`. If you see a voided payment counted, something is querying directly without using the view. Always go through the LedgerService for ledger reads.

**"Transaction rollback test fails"** — this is the canary that verifies atomicity. If a payment with multiple applications fails on one and the others stay committed, your billing data is corrupt and you have a bug in the transaction handling. Don't ship until this test passes.
