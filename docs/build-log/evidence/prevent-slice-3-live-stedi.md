# Prevent slice 3 — Stedi production gate

Run at 2026-08-31 02:25 UTC with `STEDI_MODE=production`. The request used only
Stedi-published synthetic mock identities. No patient or practice data was sent.

## Network boundary

Exactly three requests were made:

1. `POST /2024-04-01/eligibility-manager/batch-eligibility`
2. `GET /2024-04-01/eligibility-manager/batch/{batchId}/items?pageSize=1000`
3. `GET /2024-04-01/eligibility-manager/polling/batch-eligibility?batchId={batchId}&pageSize=200`

There was one batch submit, one status poll, and one result poll/ingest. COB and
Insurance Discovery were not called live. The result and status responses were
then replayed from memory through `runEligibilitySweepTick` to prove the ingest
path without another network request.

## Actual response contract

Submit response:

- Top-level fields: `batchId`, `submittedAt`
- `batchId`: `01a055a3-18f3-7ef2-95a4-774e14445fb1`
- Format: UUID-shaped, with a version-7 nibble
- `submittedAt`: `2026-08-31T02:25:47.357Z`

Status response:

- Top-level field: `items`; no `nextPageToken`
- Three items, each with: `additionalInfo`, `batchId`, `createdAt`, `index`,
  `requestId`, `state`, `updatedAt`
- `additionalInfo.eligibility` fields observed: `aaaErrors`,
  `eligibilityCheckResult`, `eligibilitySearchId`, `id`, `outboundTraceId`,
  `payerId`, `providerName`, `providerNpi`, `submitterTransactionIdentifier`,
  `subscriberFirstName`, `subscriberLastName`, `subscriberMemberId`
- All item states were `COMPLETED`
- All three `eligibilityCheckResult` values were `FAILED`
- No item returned `INVESTIGATE`
- Terminal processing time from `submittedAt` to each `updatedAt`: 1.598 s,
  1.717 s, and 1.565 s; the full batch was terminal within 1.717 s
- The client intentionally waited 45 seconds before its only status poll, so the
  observed submit-to-poll wall time was 45.646 s

Result response:

- Top-level field: `items`; no `nextPageToken`
- Three items; order differed from submit order
- Fields common to all observed items: `batchId`, `controlNumber`,
  `eligibilitySearchId`, `errors`, `id`, `meta`, `payer`, `provider`,
  `reassociationKey`, `submitterTransactionIdentifier`, `subscriber`,
  `subscriberTraceNumbers`, `tradingPartnerServiceId`, `x12`
- The first submitted item also carried `benefitsInformation`, `dependents`,
  `planDateInformation`, and `planStatus`
- The eligibility result was not repeated at the result-item top level; it was
  present in the status item's `additionalInfo.eligibility`
- The first submitted item returned targeted AAA code `71`; the items using the
  documented AAA 72 and AAA 75 mock identifiers did not return those codes

Ingest outcome:

- Final sweep state: `healthy`, meaning the sweep completed and findings were
  persisted—not that every eligibility check was clean
- W21: three findings, all `FAILED`
- W22: three fail-safe `could-not-check` findings because the synthetic payers
  were deliberately classified `unknown`; zero live COB calls
- W23: one finding for AAA 71; Insurance Discovery used a non-network stub
- Cached replay reads: one status response and one result response

## Documentation comparison and findings

The submit response fields, UUID-shaped batch identifier, status item nesting,
terminal state, and polling result envelope matched Stedi's published batch API
contract. The implementation's original mock placed `eligibilityCheckResult` at
the item top level. The documented and live location is
`items[].additionalInfo.eligibility.eligibilityCheckResult`; a regression test
failed first, then the parser was corrected before this gate.

The production response did not reveal a batch limit. Stedi's batch guide and API
reference state a maximum of 10,000 items per request, which remains the configured
application limit.

The published mock-request identities did not produce their advertised mock
outcomes under this production credential: the supposed active case failed with
AAA 71, and the AAA 72/75 cases failed without those targeted codes. Stedi's mock
request documentation says mock requests require a test API key. This is a live
environment finding, not an implementation defect, and the gate was not rerun.

Sources accessed 2026-08-31:

- https://www.stedi.com/docs/healthcare/batch-refresh-eligibility-checks
- https://www.stedi.com/docs/healthcare/api-reference/post-healthcare-batch-eligibility
- https://www.stedi.com/docs/healthcare/api-reference/get-healthcare-batch-eligibility-check-statuses
- https://www.stedi.com/docs/healthcare/api-reference/get-healthcare-polling-eligibility
- https://www.stedi.com/docs/healthcare/api-reference/mock-requests-eligibility-checks
