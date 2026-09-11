# MATRIX-2 fixback round 2 — author bundle

Confirmed saves now omit suppression-locked cells. A patient with a STOP-locked Text column submits 15 cells, no Text preferences, and no Text Consent scope. Clearing STOP therefore restores the stored Text choice. Mixed evidence names its covered channel and gap; marketing-email grammar is corrected; disabled Engage buttons are visibly dimmed.

PR: [#578](https://github.com/drbang-iva/ODOS2020/pull/578). Branch: `drbang-iva/comms-matrix-2`. Base: `87e8e5b8a4649f73dfe84a9ddab3b98419b16325`. Reviewed starting head: `76f83b1cd122e0793859917667e0b7fb9cb05858`. Final application/test source: `832a694322531092d45c0261c73245691ae2f6fa`. The publication head is sealed in the PR after the evidence-only commit. This file does not claim a self-referential commit SHA.

**Status: author verification complete, needs independent re-evaluation by Claude Opus 5 (extra).** No merge, label change, or evaluator marker.

## Files and commits

- `478092c3d782147e9e06148d65316f80f8da8be6`: `ui/src/components/patient/CommunicationPreferencesControl.tsx`, `ui/tests/communicationPreferencesControl.test.tsx`, `mcp/tests/commsPreferencesRoutes.test.ts` — exclude locked cells, two UI confirmation tests, server lifecycle/evidence test, X12 mismatched-id test. The production id check already existed and is unchanged.
- `832a694322531092d45c0261c73245691ae2f6fa`: the control and its tests above, `ui/src/components/comms/EngageSheet.tsx`, `ui/tests/engageCommunicationPreferences.test.tsx` — channel-qualified mixed evidence in both directions, corrected copy and disabled-button styles.
- Evidence-only follow-up: this directory, the parent bundle notice, capture harness, refreshed screenshots and browser proof. The capture now checks actual disabled opacity and cursor.

## Commands and failure comparison

Every reported test/build command ran directly and its own exit was captured, without a reporting pipeline. The focused command below ran from `mcp` on both revisions:

```sh
node --import tsx --test tests/commsApi.test.ts tests/commsPreferencesRoutes.test.ts tests/commsPreferences.test.ts tests/commsPreferenceWrites.test.ts tests/commsEvidence.test.ts
```

| Check | Base | Branch | Exit |
|---|---:|---:|---|
| Full UI, `npm --prefix ui test` | 1341/1341 | 1421/1421 | 0 / 0 |
| Focused MCP command above | 104/104 | 132/132 | 0 / 0 |
| `npm --prefix ui run build` | — | completed | 0 |
| `npm --prefix mcp run build` | — | completed | 0 |
| `npm run preflight` | — | 0 warnings, 0 hard blocks | 0 |
| Screen capture harness | — | 12 synthetic states and conditional save | 0 |

[Failure-name comparison](failure-diff.json): zero branch-only failures in both requested lanes. The full UI base output is the previously captured clean-base run; that unchanged base was verified again. Focused MCP was rerun at the clean base this round. The prior full-MCP eight-failure comparison remains historical evidence; this round reran the requested focused MCP suites, not the full MCP command. No production MCP source changed.

## New tests and guards

- `ui/tests/communicationPreferencesControl.test.tsx:226`: both in-person and paper confirmation submit exactly 15 cells and no `sms` when all five Text cells are locked.
- `mcp/tests/commsPreferencesRoutes.test.ts:210`: write Education Text ON, record global STOP, confirm the 15 non-Text cells, inspect Consent scope, clear the opt-out, and read Education Text as explicit ON again. The stored Text record is exactly unchanged and has no new evidence.
- `mcp/tests/commsPreferencesRoutes.test.ts:235`: a returned Patient with a different id and only a bare location yields no version report (X12).
- `ui/tests/communicationPreferencesControl.test.tsx:245`: mixed evidence names Email evidence/Text gap, and the inverse.

| Mutation | Red | Restored green | Own exits |
|---|---|---|---|
| [F1](F1.diff): send locked cells again | 17 passed, 2 failed / 19 | 19/19 | 1 / 0 |
| [X12](X12.diff): remove returned Patient-id check | 25 passed, 1 failed / 26 | 26/26 | 1 / 0 |
| [Presentation](presentation.diff): restore incorrect email grammar and omit mixed channel names | 45 passed, 5 failed / 50 | 50/50 | 1 / 0 |

Each mutation was confirmed landed with `rg`, run red, restored, then run green. Logs are beside the patches. F1 runs `node --import tsx --test tests/communicationPreferencesControl.test.tsx` from `ui`; X12 runs `node --import tsx --test tests/commsPreferencesRoutes.test.ts` from `mcp`; presentation runs the control, `engageCommunicationPreferences.test.tsx`, and `engageSheet.test.tsx` from `ui`. All three patches apply to the final source. Earlier M1–M15 packets are historical at their recorded heads; this round does not claim their re-execution.

## Existing assertions

Only the authorized marketing-email copy expectations changed: `ui/tests/engageCommunicationPreferences.test.tsx:53` (inline note, both legacy cases) and `:76` (dispatch response message). SMS expectations, disabled assertions, and all other existing assertions remain unchanged. New tests did not require fixture changes to existing tests. No guard, lint rule, or scanner changed.

## Screenshots

The existing harness was rerun and the affected images inspected: [STOP](../screenshots/stop.png), [mixed evidence](../screenshots/mixed.png), [Engage](../screenshots/engage.png), [marketing email OFF](../screenshots/engage-marketing-off.png). Paper capture was also refreshed because it includes the same evidence badge. STOP was recaptured with identical bytes. [Capture hashes](screenshots.json) and [browser proof](../screenshots/browser-proof.json) record the result. Disabled channel buttons have computed opacity `0.4` and cursor `not-allowed` (two disabled buttons in Engage, three in the marketing-OFF state).

Reproduce from the repository root:

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs docs/build-log/comms-matrix-2/capture-screens.ts
```

## Limits and follow-ups

The screen proof uses synthetic HTTP responses and actual components. The server lifecycle test uses the existing in-memory route fixture; neither is a new live AccessPolicy enforcement claim. The matching UTC form-date contract and operational membership backfill remain out of this fixback. No new vocabulary, FHIR artifact URL, dependency or medical code was introduced. No decision-index or terminology-ledger addition is needed. Public added-text and screenshot review is clean.
