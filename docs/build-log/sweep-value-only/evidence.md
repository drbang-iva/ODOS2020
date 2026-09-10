# SWEEP-1 author evidence — needs review

Base: `2047ace47bf31ba1a28759075af05157668f6081` (freshly fetched origin/main).
Branch: `drbang-iva/sweep-value-only`.
Canonical decision verified present in `../performance-od/decisions/2026-09-09-odos-all-normal-rejects-surface-staining.md`; companion HEAD `ba928e8b02449b35d65ecdd125e973e510a27450` contains required ancestor `32a2089a`.

## Result and scope

Anterior All Normal leaves Surface Staining **untouched, not normal**. The shared anterior/posterior sweep requires a multi-select field before visiting a definition. The check inspects fields; it is not a Surface Staining key exclusion. No measurement, negative-act contract, server validation, definition field, completeness UI, or IOP code changed.

Files: `ui/src/components/charting/OcularHealthSection.tsx`, dedicated `ui/tests/ocularSweepValueOnly.test.tsx`, and this evidence directory (report plus two screenshots). The three shared test files remain untouched pending operator response about the contradictory existing test.

## Four-link reproduction

All four links verified before the change at the base SHA:

1. `mcp/src/clinical-graph/dry-eye-finding-definition.ts:153-173`: Surface Staining has two select fields, no multi-select field.
2. Base `ui/src/components/charting/OcularHealthSection.tsx:1222-1225`: explicit dry-eye special case admits it to the anterior sweep.
3. Base `OcularHealthSection.tsx:1232-1233`: first multi-select field lookup defaults to an empty list.
4. `mcp/src/clinical-graph/custom-section-endpoint.ts:83`: the real schema requires at least one option code.

Restoring inclusion in the guarded component produces this actual handler response:

```text
key: 'dry-eye:conjunctival-staining'
status: 400
response:
  error: 'Array must contain at least 1 element(s)'
```

## Mandate 17 — actual RED/GREEN output

All commands below ran from `ui/` with the real application seed builder `buildFindingDefinitionSeeds()` and the same `customFieldEntries(definition, true)` conversion the definition endpoint uses. Guard 1 drives the real React component through Anterior All Normal and Save, then routes every request to `handleCustomSectionCaptureRequest`. Only the staff context and FHIR persistence are test doubles; schema validation, active-code validation, capture construction, and save results are production code. It checks 9 accepted requests and 18 persisted observations.

1. Restore inclusion (replace field eligibility with `true`):

Command: `node --import tsx --test --test-name-pattern='guard 1|guard 4' tests/ocularSweepValueOnly.test.tsx`

```text
inclusion RED exit=1
not ok 1 - SWEEP-1 guard 1 REAL SEED: Anterior All Normal posts only requests accepted by the real capture handler
not ok 2 - SWEEP-1 guard 4 REAL SEED: Surface Staining has only values and remains untouched
# tests 2
# pass 0
# fail 2
inclusion GREEN exit=0
ok 1 - SWEEP-1 guard 1 REAL SEED: Anterior All Normal posts only requests accepted by the real capture handler
ok 2 - SWEEP-1 guard 4 REAL SEED: Surface Staining has only values and remains untouched
# tests 2
# pass 2
# fail 0
```

2. Replace derivation with `definition.stableKey !== DRY_EYE_ANTERIOR_STABLE_KEY`:

Command: `node --import tsx --test --test-name-pattern='guard 2' tests/ocularSweepValueOnly.test.tsx`

```text
hardcoded RED exit=1
not ok 1 - SWEEP-1 guard 2 FIXTURE: unseen anterior value-only definition is untouched
not ok 2 - SWEEP-1 guard 2 FIXTURE: unseen posterior value-only definition is untouched
# tests 2
# pass 0
# fail 2
hardcoded GREEN exit=0
ok 1 - SWEEP-1 guard 2 FIXTURE: unseen anterior value-only definition is untouched
ok 2 - SWEEP-1 guard 2 FIXTURE: unseen posterior value-only definition is untouched
# tests 2
# pass 2
# fail 0
```

3. Wrongly exclude ordinary Cornea:

Command: `node --import tsx --test --test-name-pattern='guard 3' tests/ocularSweepValueOnly.test.tsx`

```text
ordinary-exclusion RED exit=1
not ok 1 - SWEEP-1 guard 3 REAL SEED: all 14 ordinary structures sweep both eyes with the frozen active scope
# tests 1
# pass 0
# fail 1
ordinary-exclusion GREEN exit=0
ok 1 - SWEEP-1 guard 3 REAL SEED: all 14 ordinary structures sweep both eyes with the frozen active scope
# tests 1
# pass 1
# fail 0
```

4. Real-seed requirement: guards **1, 3, and 4** use the real application catalog. Guard **2** adds previously unseen anterior and posterior keys carrying cloned value-only fields; existing measurements and blank rows must stay untouched. The extra keys are intentionally fixtures, to defeat a named-key exclusion. Guard 3 checks all 14 ordinary structures, 28 eyes total, exact active scopes, matching eye/key, and no invented measurements. Guard 4 shares the real-seed inclusion RED/GREEN above.

Final command: `node --import tsx --test tests/ocularSweepValueOnly.test.tsx`

```text
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
EXIT_STATUS=0
```

All mutations restored. Full local output is retained in `/tmp/sweep-value-only-evidence/` (ephemeral).

## Requested checks

Each command's own exit code was captured directly, without a pipeline.

| Command | Actual result |
|---|---|
| `npm --prefix ui test` | Exit 1; tests 1318, pass 1316, fail 2, skipped 0 |
| `npm --prefix mcp test` | Exit 1; tests 4385, pass 4322, fail 6, skipped 57 |
| `(cd ui && ./node_modules/.bin/tsc --noEmit --skipLibCheck)` | Exit 0, no diagnostics |
| `(cd mcp && ./node_modules/.bin/tsc --noEmit)` | Exit 0, no diagnostics |
| `npm run typecheck:scripts` | Exit 0, no diagnostics |
| `npm run preflight` | Exit 0: `ODOS preflight complete: 0 warning(s), 0 hard block(s).` |
| `node .claude/skills/tier0-census/scripts/check-proxy-coverage.mjs` | Exit 0: 24 backend families, 27 proxies, every family covered; advisory only |
| `git diff --check` | Exit 0 |

UI failures:

- `customSections.test.tsx:3488`: existing `EXAM-1B per-eye negative act leaves touched OD alone and asserts OS` passes definitions with no fields and explicitly expects Surface Staining to become normal. This expectation contradicts SWEEP-1. No new guards were added there, and the file has not been changed. Approval to correct just the obsolete seed/expectations was requested.
- `examChartBarResponsive.test.tsx:197`: a 30-second timeout waiting for the visual-field diagram during the full run. The unchanged base passes this test in isolation (1/1). The final-head isolated rerun also passes: tests 1, pass 1, fail 0, exit 0. The full-suite timeout remains recorded; it was not reproduced in isolation.

MCP failures: all 6 are in `claimReadModelStore.test.ts`, with `connect ECONNREFUSED 127.0.0.1:5433`; the same six failures reproduce on unchanged base `2047ace4`. The harness also reports `LIVE STACK NOT CONFIGURED` (41 of 57 skips are registered live-stack skips). This run does not gate live authorization. No shared database or account was changed.

## Browser before/after

Chromium drove the real component with the real seed and real capture handler on separate owned Vite ports: base 15381, proposed 15382. Disposable in-memory FHIR writes; synthetic patient and practitioner only. Screenshots were inspected at 1440x1000.

- Before: 10 requests; 9 HTTP 200 and Surface Staining HTTP 400. Failure shown; Surface Staining reads normal with zero asserted findings.
- After: 9 requests, all HTTP 200; Surface Staining stays blank, no explicit negative assertion, no write for it. 9/15 structures saved.

This is browser **component/handler** evidence, not proof of the actual EncounterCharting route, the Docker Medplum policy engine, or the deployed box. Live deployed confirmation remains owed before shipping. The existing normal-template text displayed under a blank row was not changed.

## Report, do not fix

- Real seed census: 15 segment candidates, exactly one without a multi-select field (Surface Staining); **no other value-only candidate** in either segment. All 14 ordinary seeds have nonempty active scopes. Builders: `finding-definition-store.ts:125`, `ocular-health-definition.ts:558-580`.
- `OcularHealthSection.tsx:1233-1234` can still build an empty scope for a multi-select field with no options or all options inactive. Eligibility now tests field type, while scope construction filters active options. This is a separate configured-definition edge case, not present in the 14 ordinary seeds; intentionally not fixed.
- Same builder uses the first multi-select field; an empty first field with a later populated multi-select can also yield empty scope. No second creation site found by searching all `ui/src`, `mcp/src`, `src`, and `scripts`; other references serialize, read, or clear an existing act.

## Handoff

No new design decision: this implements the existing companion decision. `decisions/INDEX.md` unchanged. No new medical codes, artifact URLs, or clinical definitions: no Mandate 14 ledger rows added. Cross-repo follow-up: record deployed confirmation and address measurement completeness in its own slice.

Status: **needs-review, not merge-ready** — contradictory shared test unresolved, broad-suite limitations above, independent evaluation still required. No evaluator marker or operator override applied. Author tests are not independent evaluation. Hand to Fable (high) or Opus (high) after the existing-test conflict is settled.
