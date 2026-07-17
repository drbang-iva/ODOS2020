# Stripe sandbox setup (v0.6c payments — online adapter)

The Stripe adapter (`mcp/src/payments/adapters/stripe-adapter.ts`) uses the PaymentIntents API for
test-mode, card-not-present payments. The browser-side Stripe surface creates a PaymentMethod; ODOS
passes that transient id to Stripe once and never writes it to FHIR or logs. This slice does not add
or change checkout UI.

**Every account, login, key, and browser setup step on this page is performed by a human.** Agents
do not traverse authentication or account-management flows.

## Runtime configuration

| Env var | Required | Value |
|---|---|---|
| `STRIPE_SECRET_KEY` | Yes | Test secret key beginning `sk_test_`; never commit it |
| `STRIPE_BASE_URL` | No | Defaults to `https://api.stripe.com`; any override must be a trusted, operator-controlled HTTPS test proxy |

The key is runtime-injected and sent only as an `Authorization: Bearer ...` header. The adapter
rejects live keys and non-HTTPS base URLs. Because `STRIPE_SECRET_KEY` is sent to the configured
base URL, never point `STRIPE_BASE_URL` at an untrusted endpoint. Stripe documents the `sk_test_` /
`sk_live_` prefixes and Bearer authentication: https://docs.stripe.com/api/authentication

## Human operator steps

1. Create or use a Stripe account and switch to a sandbox/test environment.
2. In the Stripe Dashboard's test environment, reveal and copy the test secret key.
3. Put it in the practice-local, gitignored `.env` as `STRIPE_SECRET_KEY=sk_test_...`.
4. Use Stripe's published PaymentMethod fixtures for test calls. `pm_card_visa` succeeds;
   `pm_card_visa_chargeDeclined` produces `card_declined` / `generic_decline`.

Test-mode transactions do not move funds and do not need live-mode account state. Never use real
card details in test mode. Source: https://docs.stripe.com/testing

## Verified API mapping (accessed 2026-07-11)

- Charge: `POST /v1/payment_intents`, form fields `amount`, `currency`, `payment_method`,
  `payment_method_types[]=card`, `confirm=true`. Creating with `confirm=true` creates and confirms
  in one request. Sources: https://docs.stripe.com/api/payment_intents/create and
  https://docs.stripe.com/api/payment_intents/confirm
- Idempotency: every mutating request sends `Idempotency-Key`; Stripe accepts idempotency keys on
  all `POST` requests. Source: https://docs.stripe.com/api/idempotent_requests
- Declines: Stripe error objects expose `code`, `decline_code`, `message`, and (for PaymentIntent
  request errors) `payment_intent`; a PaymentIntent can also expose `last_payment_error`. Sources:
  https://docs.stripe.com/api/errors and https://docs.stripe.com/api/payment_intents/object
- Refund: `POST /v1/refunds` with `payment_intent` and positive integer `amount`. The adapter does
  not send ODOS's free-text reason because Stripe accepts only `duplicate`, `fraudulent`, or
  `requested_by_customer`. Sources: https://docs.stripe.com/api/refunds/create and
  https://docs.stripe.com/api/refunds/object
- Void: `POST /v1/payment_intents/:id/cancel` with `cancellation_reason=requested_by_customer`.
  Stripe cancellation is available only for cancelable PaymentIntent states; canceling a
  `requires_capture` intent releases/refunds the remaining capturable amount. Source:
  https://docs.stripe.com/api/payment_intents/cancel
- Status: `GET /v1/payment_intents/:id`; ODOS maps `requires_capture` to authorized, `succeeded` to
  captured, `canceled` to voided, and `requires_payment_method` to declined only when
  `last_payment_error` is present. The initial state without an error is failed, not declined.
  Sources: https://docs.stripe.com/api/payment_intents/retrieve and
  https://docs.stripe.com/api/payment_intents/object
- Settlement: Stripe PaymentIntents do not return an honest daily `SettlementBatch`. `settle()`
  rejects explicitly; payout and balance-transaction reconciliation belongs to v0.7.

## PHI and BAA boundary

`vendorBaaRequired` is `false` for this adapter's deliberately PHI-free data flow. It sends no
patient reference, invoice reference, encounter reference, staff reference, clinical description,
or metadata to Stripe. That field is not a general legal determination: each deployment owner must
determine its applicable contract and BAA requirements without adding PHI or credentials to Stripe
requests. Stripe's current agreement defines Protected Health Information and restricts providing
PHI in covered data pathways: https://stripe.com/legal/ssa

## Deliberate limits

- The transient PaymentMethod id must already exist; adding Stripe Elements or another checkout UI
  is a separate slice.
- `requires_action` and `processing` return pending without creating a financial record. Completing
  3DS or another next action requires a future browser workflow.
- Processor fees and payout settlement require balance-transaction reconciliation and are deferred
  to v0.7; this adapter reports zero fees rather than estimating them.
