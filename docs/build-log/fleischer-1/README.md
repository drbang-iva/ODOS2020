# FLEISCHER-1 author evidence

Base: `ba87e1595d2287a76f5f8f81b08dca882575cdd6` (freshly fetched origin/main). Branch: `drbang-iva/fleischer-disposition`.

## Scope

One production row changed in `mcp/src/clinical-graph/finding-disposition-registry.ts:159`: Fleischer's iron-line subtype is descriptive, with the operator's exact supplied reason. Its definition key, field code, option code, and qualifier context are unchanged. The disposition type, seeds, diagnosis mappings, option lists, qualifiers, deferral rules, and other registry rows are unchanged.

`mcp/tests/findingDisposition.test.ts` adds the two requested guards and updates existing iron-line expectations/census. Guard 1 checks the qualified registry lookup and runs the actual mapping-trigger evaluator against an abnormal corneal finding selecting iron-line + subtype=fleischers: zero diagnosis proposals. A direct keratoconus selection provides a positive control for the same evaluator. Guard 2 filters every exported FINDING_DISPOSITION_ROWS entry by its disposition kind and asserts zero awaiting-ruling rows. It does not enumerate identities.

The ruling file was re-read from the verified PerformanceOD checkout. Both the ruling and kickoff are already in decisions/INDEX.md; no new decision or companion-repo edit was needed. No medical codes, FHIR artifact URLs, or regulatory claims were introduced; no Mandate 14 ledger rows were added.

## Row census and counting control

Counts are computed from the imported, built `FINDING_DISPOSITION_ROWS` array, never source-text occurrence counts.

| Kind | Before | After |
|---|---:|---:|
| Total rows | 211 | 211 |
| awaiting-ruling | 1 | 0 |
| descriptive (control) | 17 | 18 |
| proposes | 54 | 54 |
| pending | 139 | 139 |

The source-text trap was independently reproduced: before the change there were 2 textual awaiting-ruling matches and 18 descriptive matches; afterward there are 1 and 19. In each case the extra match is the type declaration, not a registry row.

## Ratchet tradeoff

I agree with keeping zero awaiting-ruling rows as a hard CI ratchet. A genuine operator-blocked question should be visibly blocking. `pending` remains available for work that has not been classified, but should not be used to disguise an actual unresolved operator decision. Adding awaiting-ruling therefore deliberately creates a failing guard until the ruling lands or the operator explicitly revises this invariant. The guard is not softened to a ceiling or identity allowlist.

## Mandate 17

```text
Guard 1: RED exit 1; GREEN exit 0
Guard 2: RED exit 1; GREEN exit 0
```

- Guard 1 mutation: replace Fleischer's disposition with `{ kind: "proposes", entrySurface: "finding" }`. [Verbatim RED](guard-1-red.txt), [verbatim restored GREEN](guard-1-green.txt).
- Guard 2 mutation: replace Hudson-Stähli's descriptive disposition with a synthetic awaiting-ruling row. [Verbatim RED](guard-2-red.txt), [verbatim restored GREEN](guard-2-green.txt).

Each focused mutation run reported 1 failed test, exit 1; each restored run reported 1 passed test, exit 0. Production bytes were restored in a finally block. Baseline suite: 21/21 passed. Final focused suite: 23/23 passed. The new guards also failed on the initial unmodified production source before the row edit.

## Report-only review and limitations

Scoped sibling review established no additional inconsistency requiring a change. Vogt striae (line 160) and hydrops (line 168) remain pending as explicitly directed; Hudson-Stähli (157) and Stocker's (158) remain descriptive. Any reconsideration of those pending signs is a separate operator decision, not a follow-up silently folded into this patch.

This is registry/test work with no UI component change. Before/after evidence is the measured row census above; no new browser-surface claim is made. No deployment or data migration is included. Tests of the actual mapping evaluator do not establish real AccessPolicy enforcement.

Author evidence only. NOT EVALUATED. Independent evaluation by a model that wrote none of this change is required at the PR's exact head before merge. No evaluation marker or operator override label is supplied.

## Checks

Each command's own exit status was captured directly, without piping the test command. Full local logs: `/tmp/fleischer-1-evidence/`.

- `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15474/medplum ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test`: exit 0, 4,333 passed, 0 failed, 45 skipped. PostgreSQL was a disposable task-owned container. The explicit opt-out acknowledges 41 unconfigured live-stack tests; this is not an authorization gate.
- `mcp/node_modules/.bin/tsc -p mcp/tsconfig.json --noEmit`: exit 0, no diagnostics.
- `ui/node_modules/.bin/tsc -p ui/tsconfig.json --noEmit --skipLibCheck`: exit 0, no diagnostics.
- `npm run typecheck:scripts`: exit 0, no diagnostics.
- `npm run preflight`: exit 0; read grants PASS (46 literal/marked resourceTypes), operation coverage PASS (843 operations), 0 warnings, 0 hard blocks. The scan's stated limits remain applicable.

Verbatim MCP summary:

```text
# tests 4378
# suites 0
# pass 4333
# fail 0
# cancelled 0
# skipped 45
# todo 0
# duration_ms 107084.333125
```

`cd ui && npm test`: exit 0; 1,304 passed, 0 failed, 0 skipped. Verbatim summary:

```text
# tests 1304
# suites 0
# pass 1304
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 200747.668542
```
