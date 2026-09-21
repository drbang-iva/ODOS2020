# Follow-up unavailable wording evidence

Base: `d87f015c6e4469300997006e62f2aa237c026b66` (`origin/main` when verified). The change is limited to fourteen seeded reasons, four seed versions, the queue fallback, one existing assertion, appended seed guards, and this evidence directory. No stored visit, practice copy, orderability, or unrelated `unavailableReason` was changed.

## Premises checked at base

- P1: fourteen recursive `unavailableReason` occurrences in five seeds; glaucoma has none.
- P2: all five seeds were version 1. `profilesApplied` records the seed version at shaping; no runtime branch uses it. The cited `examShapeRecord` assertion reads `seed.version`. Two other existing tests hardcode glaucoma version 1; glaucoma stays version 1.
- P3: queue reason precedence was frozen reason, pending orderable fallback, then catalogue fallback; the existing S3c2a G5 asserted all three.
- P4: existing seed guards G1–G3 checked section availability, test availability, and recursive absence of MDM keys. All three remained unchanged.
- P5: the queue row and Settings profile editor render the reason. No UI test asserted a seeded reason.
- P6: the Meibography capture route and gland structure component are present, and the vital dye choices omit rose bengal. The kickoff's component line `291–298` points to selectors; the capture call is earlier in the same component.

## Guard proof

Each mutation was restored before the next. Targeted runs set `ODOS_POSTGRES_URL` to a dedicated `odos-wording-*` Postgres container.

| Guard | Break | Red | Restored green |
|---|---|---|---|
| G1 | Old ERG developer string | 1 test, 0 pass, 1 fail | 1 test, 1 pass, 0 fail |
| G2 | One-character OCT sentence change | 1 test, 0 pass, 1 fail | 1 test, 1 pass, 0 fail |
| G3 | Macula seed version 1 | 1 test, 0 pass, 1 fail | 1 test, 1 pass, 0 fail |
| G4 | Old pending fallback literal | 1 test, 0 pass, 1 fail | 1 test, 1 pass, 0 fail |
| G5 | Pending fallback before frozen reason | 1 test, 0 pass, 1 fail | 1 test, 1 pass, 0 fail |

The new seed tests were also run before implementation: 6 tests, 3 pass, 3 fail (G1–G3). After implementation: 6 tests, 6 pass, 0 fail.

## Suite and static checks

The MCP commands used the CI file set (`src/__tests__/**/*.test.ts`, `tests/**/*.test.ts`, and the nine root test families), `node --import tsx --test --test-concurrency=1`, and `ODOS_POSTGRES_URL` pointing to dedicated `odos-wording-*` Postgres containers. The initial macOS Bash run lacked `globstar` and selected fewer files; it is excluded from the comparison. Baseline and head below used the same zsh expansion.

| Check | Base | Head |
|---|---:|---:|
| `npm --prefix ui test` | 1,844 tests; 1,844 pass; 0 fail | 1,844 tests; 1,844 pass; 0 fail |
| Full MCP CI file set | 6,265 tests; 6,210 pass; 0 fail; 55 skip | 6,268 tests; 6,213 pass; 0 fail; 55 skip |
| `npm run typecheck:scripts` | — | exit 0 |
| `npx tsc --noEmit` in `mcp` | — | exit 0 |
| `npx tsc --noEmit --skipLibCheck` in `ui` | — | exit 0 |
| `npm run preflight` | — | exit 0; 0 warnings; 0 hard blocks |

The 55 MCP skips were present in both runs. No existing assertion failed.

## Browser proof

The same synthetic macula-retina shape was passed through `resolveProfileTests` and `deriveFollowUpQueue` at base and head, then shown by the unchanged `FollowUpQueue` component in Chromium on separate Vite servers. `before.png` and `after.png` use identical 1000 × 700 viewports. This is component browser proof with a synthetic queue response, not a credentialed encounter walkthrough.

- Base: `OCT retina: No OCT retina orderable exists in ODOS yet`; `ERG: ERG is on ODOS's pending-orderables list — plan-sets/glaucoma.ts:2`.
- Head: `OCT retina: OCT retina can't be ordered in ODOS yet.`; `ERG: ERG can't be ordered in ODOS yet.`
- Frozen synthetic shape at head: `ERG: ERG is on ODOS's pending-orderables list — plan-sets/glaucoma.ts:2`. Its queue is shown in `frozen.png`.

A saved practice profile can override its seed and retains its prior text. Existing stored visits retain their frozen text. Neither was migrated.
