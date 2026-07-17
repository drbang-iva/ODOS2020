# Clover sandbox setup (v0.6c payments — in-clinic POS adapter)

The Clover adapter (`mcp/src/payments/adapters/clover-adapter.ts`) drives a physical Clover device
through the **REST Pay Display API (cloud connection)**: ODOS dispatches the charge, the device
collects the card, and on SUCCESS the adapter settles the order's Invoice with a FHIR
`PaymentReconciliation`. No card data ever enters ODOS — the device and Clover's cloud handle the
card-present exchange (PCI scope minimization per the 2026-05-05 payment-processor architecture).

**Every step on this page is performed by a human.** Account creation, logins, app registration,
and token generation are authentication flows — agents do not traverse them (security policy,
`performance-od/reference/core/soul.md`).

---

## 1. What the adapter needs (runtime config)

| Config | Where it comes from | Env var (suggested; `.env` is gitignored — never commit values) |
|---|---|---|
| Base URL | Sandbox: `https://apisandbox.dev.clover.com` (exported as `CLOVER_SANDBOX_BASE_URL`) | `CLOVER_BASE_URL` |
| Access token | OAuth **expiring** token from the v2/OAuth flow — Clover's docs are explicit: an OAuth-generated API token, **not** a static merchant token | `CLOVER_ACCESS_TOKEN` |
| Device id | The device serial (Setup app on the device → Devices, or the merchant web dashboard) | `CLOVER_DEVICE_ID` |
| POS id | A stable POS identity string, e.g. `ODOS-Dispensary` | `CLOVER_POS_ID` |

Tokens expire and refresh — treat `CLOVER_ACCESS_TOKEN` as a rotating secret. The adapter uses it
for the `Authorization` header only; it is never written to any FHIR resource or log (unit test
asserts the persisted PaymentReconciliation does not contain it).

## 2. Sandbox setup steps (operator)

1. **Create a sandbox developer account** — sandbox.dev.clover.com (the sandbox and production
   developer accounts are separate).
2. **Create a test merchant** in the sandbox Developer Dashboard.
3. **Create a semi-integrated app** with REST Pay Display configuration enabled, and generate the
   **Remote App ID (RAID)** — this is distinct from the app id.
4. **Generate the OAuth expiring token** (access + refresh pair) for the test merchant via the
   v2/OAuth flow.
5. **Device** — see §3; then install/launch **Cloud Pay Display** on it so the cloud connection can
   reach it, and note the device serial.
6. Put the four values in `.env` and run the dispensary charge flow against the sandbox merchant.

## 3. The device reality (verified 2026-07-05, docs.clover.com)

- **Cloud Pay Display cannot be emulated** — it requires physical Clover hardware (Flex / Mini /
  Compact); Android emulators do not support its secure WebSocket + hardware interactions.
- **A production Clover device cannot be associated with a sandbox account.** The bank-provided
  IV&A Clover terminals will NOT work against sandbox.
- Therefore a true end-to-end sandbox card-present test needs a **Clover Dev Kit** (developer
  hardware associated with the sandbox test merchant).

Options, in order of increasing spend:

| Option | What it validates | Cost |
|---|---|---|
| Mocked-transport unit tests (already shipped, 7 green) | Adapter request/response mapping + the full FHIR seam (PR → receipt) | $0 |
| Buy a Clover Dev Kit and associate it with the sandbox test merchant | True card-present E2E in sandbox with test cards | Dev Kit hardware (~a few hundred dollars) |
| Go straight to a supervised live pilot on the bank-provided device once the ISV/API-access path is confirmed | Production reality | $0 hardware, but gated on §4 |

## 4. The live path (pending operator question)

IV&A's Clover devices come through the bank's merchant-services program. **Open question with the
bank/Clover rep:** does that plan allow third-party REST Pay Display API integration, and is API
access provisioned directly through Clover developer tooling or through the bank's ISV channel?
The sandbox work above proceeds regardless — this question gates only the live hookup. Never
handle live payment credentials in this repo; live tokens live in the practice's local secrets
store per Mandate 8.

## 5. What is deliberately deferred (v0.7 fence)

Refunds (`POST /connect/v1/payments/{paymentId}/refunds` — endpoint verified, workflow deferred to
the v0.7 refund-authorization admin tool), voids, settlement-batch reconciliation, and transaction
status lookup. The adapter throws explicit deferral errors for all four.
