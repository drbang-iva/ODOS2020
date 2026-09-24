# Claim evidence excludes voided Encounters — guard proof (Mandate 17)

Status: **NOT EVALUATED**. Claude (Opus 5.5) authored this change; Codex must evaluate the exact PR head before merge.

Each guard was broken in `mcp/src/claims/interpretation-hold.ts` (`claimServiceEncounters`), the two focused files were
run, and the file was restored with `git checkout --`. Every mutant was confirmed in place with `grep -n` before its run.

Command, from `mcp/`:

```text
node scripts/run-tests.mjs tests/claimInterpretationHold.test.ts tests/claimHandlers.test.ts
```

## Pre-fix (base behaviour — the defect)

Before the filter existed, the new tests went red on the defect itself, not on setup:

```text
not ok 80 - V3 submit holds an imaging line whose only same-day interpretation is on a cancelled visit
  expected: 409
  actual: 200
not ok 99 - V1 draft handler holds imaging when the only same-day interpretation is on a cancelled visit
  + 'photo',            (photo kept by cancelled-visit evidence)
not ok 100 - V2 draft handler holds imaging when the only same-day interpretation is on an entered-in-error visit
  + 'photo',
not ok 102 - V4 draft handler raises no same-day pair advisory from a cancelled visit's proposal
  + 'Synthetic photograph and Synthetic OCT: usually not billed together on the same day — document why both were needed.'
# tests 102
# pass 98
# fail 4
```

## M1 — remove the filter (V1, V2, V3, V4)

```text
96:  return rows.filter(row => row.subject?.reference === patientReference && serviceDay(row) === day);
not ok 80 - V3 submit holds an imaging line whose only same-day interpretation is on a cancelled visit
not ok 99 - V1 draft handler holds imaging when the only same-day interpretation is on a cancelled visit
not ok 100 - V2 draft handler holds imaging when the only same-day interpretation is on an entered-in-error visit
not ok 102 - V4 draft handler raises no same-day pair advisory from a cancelled visit's proposal
# pass 98
# fail 4
```

## M2 — exclude `cancelled` only (V2)

```text
97:    row.status !== "cancelled");
not ok 100 - V2 draft handler holds imaging when the only same-day interpretation is on an entered-in-error visit
# pass 101
# fail 1
```

## M3 — keep `finished` only (V5)

```text
97:    row.status === "finished");
not ok 101 - V5 draft handler still counts an in-progress same-day visit's interpretation
# pass 101
# fail 1
```

## Restored

```text
git status --porcelain      (empty)
# pass 102
# fail 0
```

## What each guard holds

| Guard | Handler | Voided side | Control |
|---|---|---|---|
| V1 | `handleClaimDraftRequest` | E2 `cancelled` carries the only `final` report + `completed` Media → photo **held** | E2 `finished` → photo kept, no warning |
| V2 | `handleClaimDraftRequest` | E2 `entered-in-error` → photo **held** | (V1 control) |
| V3 | `handleSubmitClaimRequest` | E2 `cancelled` → `409 all-lines-held`, no Claim created | E2 `finished` → `200`, Claim created, no `heldLines` |
| V4 | `handleClaimDraftRequest` | accepted OCT proposal on E2 `cancelled` → **no** pair warning | E2 `finished` → pair warning appears |
| V5 | `handleClaimDraftRequest` | E2 `in-progress` → photo still **kept** | — |

V4's fixture keeps E1's photo line by giving it its own same-day `final` report, so the pair check actually runs in both
arms. `draftWithPairOnOtherVisit` asserts the photo is kept before either arm's warning assertion, so a held line cannot
make the "no warning" arm pass vacuously.
