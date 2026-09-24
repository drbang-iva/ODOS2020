# Corrected claims go through the interpretation hold — guard proof (Mandate 17)

Status: **NOT EVALUATED**. Claude (Opus 5.5) authored this change; Codex must evaluate the exact PR head before merge.

Each guard was broken in `mcp/src/claims/claimmd-handlers.ts`, the two focused files were run, and the file was
restored with `git checkout --`. Every mutant was confirmed in place with `grep -n` before its run.

Command, from `mcp/`:

```text
node scripts/run-tests.mjs tests/claimHandlers.test.ts tests/claimInterpretationHold.test.ts
```

## MC1 — skip the hold on corrections (C1, C2, C4)

This is also the pre-change behaviour of the correction path.

```text
391:    if (false) {
not ok 81 - C1 correction carrying uninterpreted imaging is refused whole and nothing is written or sent
not ok 82 - C2 correction with one held and one clean line is refused, not sent without the held line
not ok 84 - C4 correction is judged by the stored imaging ChargeItem, not a non-imaging request body
# pass 103
# fail 3
```

## MC2 — drop held lines, as ordinary submit does (C2)

```text
392:      const { held: heldLines, kept: keptLines } = await evaluateClaimLineHold(auth, resubmissionInput.chargeItems,
394:      if (heldLines.length && keptLines.length) resubmissionInput.chargeItems = keptLines;
not ok 82 - C2 correction with one held and one clean line is refused, not sent without the held line
# pass 105
# fail 1
```

## MC3 — hold voids too (C3)

```text
391:    if (true) {
not ok 83 - C3 void of a claim carrying uninterpreted imaging is never held
# pass 105
# fail 1
```

## MC4 — judge the request body instead of the stored ChargeItem (C4, and #666's V3 on submit)

```text
2196:    storedLines.push({ ...line, ...(line.diagnosisSequence ? { diagnosisSequence: line.diagnosisSequence } : {}) });
not ok 80 - V3 submit holds an imaging line whose only same-day interpretation is on a cancelled visit
not ok 84 - C4 correction is judged by the stored imaging ChargeItem, not a non-imaging request body
# pass 104
# fail 2
```

## MC5 — the extracted mechanic misreports held-line indexes (C5: ordinary submit's drop logic)

V3 is the submit-side guard. C1, C2 and C4 also go red here only because they pin `index: 0` in the refusal body.

```text
2202:  return { kept: result.kept, held: result.held.map(line => ({ ...line, index: line.index + 1 })) };
not ok 80 - V3 submit holds an imaging line whose only same-day interpretation is on a cancelled visit
not ok 81 - C1 correction carrying uninterpreted imaging is refused whole and nothing is written or sent
not ok 82 - C2 correction with one held and one clean line is refused, not sent without the held line
not ok 84 - C4 correction is judged by the stored imaging ChargeItem, not a non-imaging request body
# pass 102
# fail 4
```

## Restored

```text
git status --porcelain      (empty)
# pass 106
# fail 0
```

## Step 1 (extraction only, before the correction caller existed)

After ordinary submit was moved onto `evaluateClaimLineHold` (commit `c6330af1`): mcp `tsc --noEmit` exit 0, and
`claimHandlers`, `claimInterpretationHold`, `submitClaimsClearinghouse` and `claimDraft` ran 126 tests, 126 pass, 0 fail,
unchanged from base.

## What each guard holds

All guards run at the real handler, `handleStediClaimResubmissionRequest`, against an adjudicated non-Medicare claim
(frequency 7/8 path).

| Guard | Setup | Expected |
|---|---|---|
| C1 | Correction with an imaging line and no same-day signed interpretation | `409 correction-lines-held` with heldLines. Nothing sent, no ChargeItem or Claim written (`createHeaders` empty), original Claim deep-equal to before, failure audited. Control with a same-day final report + completed Media → 200, sent as frequency 7 |
| C2 | Correction with one held imaging line + one clean idless line | Still 409 for the whole correction; nothing sent; no ChargeItem persisted |
| C3 | Void of a claim whose snapshot line is uninterpreted imaging | 200, sent as frequency 8 |
| C4 | Stored `charge-1` is imaging in FHIR; the request body says `PROC-A` | Held: judged by the stored copy |
| C5 | Ordinary submit after extraction | #661/#666 submit guards (V3) unchanged and green |
