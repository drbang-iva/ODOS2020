# S3c-2c-2b-2 — fee interpretation answer + charge snapshot

**Status: needs-review.** Coded-by: Codex — gpt-5.6-sol, high effort. NOT EVALUATED. Branch `drbang-iva/followup-s3c2c2b2-fee-interpretation` is based on `dd7e4b636f86f716e39c7c0f5f8cfdd2c7ce2db6`; the PR URL and final head SHA are in the handoff.

## Summary

Every built-in fee now has a fixed interpretation answer; custom fees may carry one, and older custom fees remain unanswered. All four accepted-charge writers snapshot `{ answer, feeVersion, at }` at acceptance. The fee editor exposes the answer; ChargeItem materialization remains unchanged. R1 and R2 granted exact existing-test additions. G1–G9 each broke red and restored green. Full MCP/UI suites, smoke, integration, authorization, the admin/provider Chromium proofs, all three typechecks, and preflight completed with the exact results below. The accepted fundus charge held `fundus-photo` at the pre-accept fee version `2` after retirement moved the fee to version `3`; the custom OCT charge snapshot also survived retirement. The change is ready for independent review and has not been merged.

## Premises and scope

P1–P6 were verified against base `dd7e4b63`: ChargeItemDefinition extension/routing template and both virtual seed builders; strict admin fee routes; accepted writers W1 manual Add/Follow-up Accept, W2 Restore, W3 protocol acceptCharges, W4 Visit charge mutation; Basic JSON storage; five billable imaging categories; and descriptor-driven UI with conditional adapter fields. P7 was amended by R1 for MCP whole-proposal pins and by R2 for the UI descriptor pin. `mcp/scripts/run-tests.mjs` includes `mcp/src/__tests__/**/*.test.ts`. The separate `opticalPricingSettings.test.tsx` descriptor pin stayed unchanged and passed in the full UI run.

Source files touched: `mcp/src/clinical-graph/procedure-fee-schedule.ts`, `procedure-fee-schedule-endpoint.ts`, `protocol-types.ts`, `manual-procedure-charge-endpoint.ts`, `protocol-endpoint.ts`, `ui/src/scenes/settings/FeeScheduleSettings.tsx`, `ui/src/lib/procedure-fee-schedule.ts`.

Tests touched: new `mcp/tests/feeInterpretation.test.ts`; appended `mcp/tests/followUpAccept.test.ts` and `ui/tests/feeScheduleSettings.test.tsx`; R1 exact-key grants in `mcp/src/__tests__/procedure-charges.test.ts` and `visit-billing-codes.test.ts`; R2's two assertions in `ui/tests/visitBillingCodes.test.tsx`. No `.odos/` content is tracked. This build-log directory contains the bundle, synthetic practice-admin and provider screenshots, and aggregate proof observations. No `.odos/` content is tracked.

## R1 assertion grants — before and after

1. `procedure-charges.test.ts`, “procedure create uses stable manual identity and the sole principal diagnosis”: before, the expected accepted proposal had no `interpretation` key between `state: "accepted"` and `provenance`; after, exactly `interpretation: { answer: "not-required", feeVersion: "1", at: NOW }` was inserted there. W1.
2. `procedure-charges.test.ts`, “procedure patch edits, clears, removes, and revives only mutable fields”: before `manualProcedure({ id, dxPointers: [], state: "accepted", lastAmendment })`; after `manualProcedure({ id, dxPointers: [], state: "accepted", interpretation: { answer: "not-required", feeVersion: "1", at: NOW }, lastAmendment })`. W2.
3. `visit-billing-codes.test.ts`, “visit charge handlers enforce chart access and create one stable manual proposal”: before, the expected accepted proposal had no `interpretation` key between `state` and `provenance`; after, exactly `interpretation: { answer: "not-required", feeVersion: "1", at: NOW }` was inserted there. W4.

No fixture helper or protected-proposal assertion changed. The focused MCP set containing those assertions was 91/91.

## R2 UI assertion grants — before and after

`ui/tests/visitBillingCodes.test.tsx`, “fee settings round-trip the optional billing code while allowing practice concept creation.” The two complete assertions before R2 were:

```tsx
  assert.deepEqual(descriptor.fields, [
    { type: "text", key: "billingCode", label: "Billing code" },
    { type: "text", key: "modifier", label: "Modifier (recorded only)" },
    {
      type: "select",
      key: "routing",
      label: "Routing (recorded only)",
      options: [
        { value: "insurance-billable", label: "Insurance billable" },
        { value: "self-pay", label: "Self-pay" },
      ],
    },
    { type: "currency", key: "priceCents", label: "Fee", min: 0 },
  ]);
  assert.deepEqual(descriptor.facts?.(ROUTINE_ITEM), ["S0620", "Unpriced", "Version 1"]);
```

After R2 they are:

```tsx
  assert.deepEqual(descriptor.fields, [
    { type: "text", key: "billingCode", label: "Billing code" },
    { type: "text", key: "modifier", label: "Modifier (recorded only)" },
    {
      type: "select",
      key: "routing",
      label: "Routing (recorded only)",
      options: [
        { value: "insurance-billable", label: "Insurance billable" },
        { value: "self-pay", label: "Self-pay" },
      ],
    },
    {
      type: "select",
      key: "interpretation",
      label: "Needs an interpretation?",
      options: [
        { value: "not-required", label: "No" },
        { value: "visual-field", label: "Yes — visual field" },
        { value: "fundus-photo", label: "Yes — fundus photo" },
        { value: "anterior-segment-photo", label: "Yes — anterior segment photo" },
        { value: "oct", label: "Yes — OCT" },
        { value: "biometry", label: "Yes — biometry" },
      ],
    },
    { type: "currency", key: "priceCents", label: "Fee", min: 0 },
  ]);
  assert.deepEqual(descriptor.facts?.(ROUTINE_ITEM), ["S0620", "Interpretation: not answered", "Unpriced", "Version 1"]);
```

No other line of that test changed. The R2 field break removed the descriptor entry temporarily: `not ok 1 - fee settings round-trip the optional billing code while allowing practice concept creation`, `# tests 1; # pass 0; # fail 1`. Byte-for-byte restoration: `# tests 1; # pass 1; # fail 0`. The fact break removed only the active missing-answer fact and produced the same red and green summaries.

## Mandate 17 breaks (each source restored byte for byte)

Each output below is from the single named test or tests selected by `--test-name-pattern`; the red output names the failing assertion. G9 uses the existing absent-field request-body assertion, which is the relevant guard for “always send the key”.

| Break | Red output | Restored output |
|---|---|---|
| G1 | `not ok 1 - S3c2c2b2 G1 every seed has its fixed interpretation answer and custom absence stays unanswered`; `# pass 0`, `# fail 1` | `# tests 1`, `# pass 1`, `# fail 0` |
| G2-refusal | `not ok 1 - S3c2c2b2 G2 custom answers persist and an equal seed answer permits the rest of a save`; `# pass 0`, `# fail 1` | `# tests 1`, `# pass 1`, `# fail 0` |
| G2-equal-save | `not ok 1 - S3c2c2b2 G2 custom answers persist and an equal seed answer permits the rest of a save`; `# pass 0`, `# fail 1` | `# tests 1`, `# pass 1`, `# fail 0` |
| G3 | `not ok 1 - S3c2c2b2 G3 fee routes round-trip answers and reject unknown values without changing old creates`; `# pass 0`, `# fail 1` | `# tests 1`, `# pass 1`, `# fail 0` |
| G4a | `not ok 1 - S3c2c2b2 G4a Visit procedure Add snapshots the custom fee answer, version and time; not ok 2 - S3c2c2b2 G4a Follow-up Accept snapshots the service fee on the caller-written charge`; `# pass 0`, `# fail 2` | `# tests 2`, `# pass 2`, `# fail 0` |
| G4b | `not ok 1 - S3c2c2b2 G4b Restore takes a fresh snapshot after the fee answer changes`; `# pass 0`, `# fail 1` | `# tests 1`, `# pass 1`, `# fail 0` |
| G4c | `not ok 1 - S3c2c2b2 G4c protocol acceptCharges snapshots each staged proposal when it becomes accepted`; `# pass 0`, `# fail 1` | `# tests 1`, `# pass 1`, `# fail 0` |
| G4d | `not ok 1 - S3c2c2b2 G4d Visit charge create and concept change take fresh snapshots while diagnosis edits keep one`; `# pass 0`, `# fail 1` | `# tests 1`, `# pass 1`, `# fail 0` |
| G5 | `not ok 1 - S3c2c2b2 G5 diagnosis patches preserve a charge snapshot through answer change and fee retirement`; `# pass 0`, `# fail 1` | `# tests 1`, `# pass 1`, `# fail 0` |
| G6 | `not ok 1 - S3c2c2b2 G6 accepting unanswered and absent custom fees records explicit unanswered snapshots`; `# pass 0`, `# fail 1` | `# tests 1`, `# pass 1`, `# fail 0` |
| G7 | `not ok 1 - S3c2c2b2 G7 charge materialization remains byte-identical with or without the snapshot`; `# pass 0`, `# fail 1` | `# tests 1`, `# pass 1`, `# fail 0` |
| G8 | `not ok 1 - S3c2c2b2 G8 Add requires a six-answer interpretation select and active legacy fees show not answered`; `# pass 0`, `# fail 1` | `# tests 1`, `# pass 1`, `# fail 0` |
| G9 | `not ok 1 - fee schedule adapter lists, edits, and deactivates through the server-mediated API`; `# pass 0`, `# fail 1` | `# tests 1`, `# pass 1`, `# fail 0` |

G4a's red result contains both Visit Add and Follow-up Accept. G2 was broken twice: seeded refusal removed and equal-answer save returned before price write. G7's break was a temporary mutation inside `materializeAcceptedChargeProposals`; the delivered function is unchanged.

## Checks and live proof

| Check | Actual output/result |
|---|---|
| Baseline full MCP at `dd7e4b63`, dedicated `odos-s3c2c2b2-tests-pg`, `ODOS_POSTGRES_URL` set, operator files absent | `# tests 6303; # pass 6248; # fail 0; # skipped 55` |
| Current full MCP, same dedicated Postgres and operator-file condition | `# tests 6315; # pass 6260; # fail 0; # skipped 55` (12 added, 12 passing) |
| Baseline full UI | `# tests 1855; # pass 1855; # fail 0; # skipped 0` |
| R2 full UI, `npm --prefix ui test` | `# tests 1857; # pass 1857; # fail 0; # skipped 0`; duration `224902.298417` ms (2 added, 2 passing) |
| Focused R2 existing UI test | `# tests 1; # pass 1; # fail 0; # skipped 0` |
| Fresh stack `odos-s3c2c2b2-r2b-live` | Separate task Postgres, Redis, and Binary volumes; ignored task credentials; `MEDPLUM_BASE_URL` matched configured `http://localhost:18103/` byte for byte. Initial healthcheck attempt 8: HTTP 200, `{"ok":true,"version":"5.1.8-d50cd6f","platform":"linux","runtime":"v24.14.1","postgres":true,"redis":true,"redisInstances":{"default":true}}`. R5 restart healthcheck attempt 1: HTTP 200, `postgres=True`, `redis=True`. |
| Smoke before repair | `# tests 12; # pass 12; # fail 0; # skipped 0` |
| Integration before repair | `# tests 218; # pass 218; # fail 0; # skipped 0`; duration `197605.512584` ms |
| `repair-practice-roles`, `GITHUB_ACTIONS=true` only for that command | Exit 0; 3 policies created (`provider`, `staff`, `admin`); membership reconciliation `CHANGED`; roles `staff`, `admin`, `provider`; primary role `staff`. Fresh admin membership read: `{"admin":true,"accessPolicy":null}`. |
| Same-project disposable operator caller | Client-credentials exchange verified. Admin caller `/auth/me`: `admin: true`, `accessPolicy: null`; service client `/auth/me`: `admin: null`, `accessPolicy: null`. |
| Live authorization after repair | `# tests 78; # pass 78; # fail 0; # skipped 0` |
| Chromium practice-admin fee proof | Save disabled without an interpretation answer; custom synthetic fee saved with `oct`, version `1`, HTTP 201; built-in fundus answer visible. Evidence: `r2b-fee-answer-required.png`, `r2b-fee-answers-saved.png`, `r2b-admin-fee-observation.json`. |
| R3 admin fee setup | `POST /clinical-graph/fee-schedule/fundus-photography`, request `{ "action": "save", "billingCode": "SYNTHFUNDUSR3", "interpretation": "fundus-photo", "priceCents": 10000, "active": true }`; HTTP 200. `listActiveCodedNonVisitProcedureFees` returned `{ "procedureConceptKey": "fundus-photography", "billingCode": "SYNTHFUNDUSR3", "priceCents": 10000, "interpretation": "fundus-photo", "version": "2" }`. Evidence: `r3-fundus-fee-observation.json`. |
| R4 provider Chromium proof | Immediately before Accept, `listActiveCodedNonVisitProcedureFees` returned fundus fee version `2`. Provider Accept returned HTTP 200, retina row `billed`. Medplum Basic JSON held `interpretation.answer = "fundus-photo"`, `feeVersion = "2"`, equal to the captured version. Provider custom OCT charge returned HTTP 201 and its Basic snapshot matched `answer = "oct"`, version `1`. Evidence: `r4-provider-before-accept.png`, `r4-provider-after-accept.png`, `r4-provider-charge-observation.json`. |
| R5 retirement proof on those preserved charges | Admin Chromium deactivated the custom OCT fee, HTTP 200; its accepted Basic charge snapshot stayed `oct`, version `1`. Admin route deactivated fundus, HTTP 200. The server's admin fee list then returned fundus inactive at version `3`. The accepted fundus Basic charge still read `fundus-photo`, version `2`, exactly its pre-accept snapshot. Evidence: `r4-custom-fee-retired.png`, `r4-retire-observation.json`. |
| MCP typecheck, `npm --prefix mcp run build` | Exit 0; `> tsc` with no diagnostics. |
| UI typecheck, `./ui/node_modules/.bin/tsc --noEmit --skipLibCheck --project ui/tsconfig.json` | Exit 0; no diagnostics. |
| Scripts typecheck, `npm run typecheck:scripts` | Exit 0; `> tsc -p tsconfig.scripts.json` with no diagnostics. |
| `npm run preflight` | Exit 0; `ODOS preflight complete: 0 warning(s), 0 hard block(s).` |

## R5 proof-harness repair — before and after

The R4 product assertions completed, but the ignored `.odos/s3c2c2b2/r4-provider-charge-proof.mjs` crashed while writing an observation. Two occurrences of `customResponse.status()` (the observation field and console summary) were changed to `customResponse.status`. Before: `TypeError: customResponse.status is not a function` at line 117; no observation file. After: `node --check` exited 0 and the recovery recorder wrote `r4-provider-charge-observation.json` from the preserved, already asserted session: `{"recovered":true,"preAcceptFeeVersion":"2","fundusAnswer":"fundus-photo","fundusSnapshotFeeVersion":"2","customAnswer":"oct","customSnapshotFeeVersion":"1"}`. No expected value, request, or product file changed; the accepted writes were not repeated. The retirement proof then passed against those same charge IDs.

## Risks and follow-ups

- The sign gate/refusal and R-d warning, reading snapshots in billing, CSV import asking the question, Q7, the sign race, and editing built-in answers remain future slices.
- This slice records fee answers and accepted-charge snapshots; signing and billing behavior are unchanged.
- The fresh stack used synthetic records and task-only credentials. Its containers were stopped; volumes retained. Final `docker ps --format '{{.Names}} {{.Ports}}'`: `vf-prac1b-walk-db 127.0.0.1:55481->5432/tcp`. That container was untouched.
- Coder review is not an independent evaluation. `NOT EVALUATED` remains until Claude Opus 5 evaluates the final head.

needs-review
