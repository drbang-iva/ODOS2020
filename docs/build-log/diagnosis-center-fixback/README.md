# Diagnosis-center slice 1 fixback — sealed author bundle

**Status: needs-review.** Branch `drbang-iva/dx-status`, worktree `.worktrees/dx-status`. This fixes the independent evaluation of slice-1 commit `b504005f04bea7e315c09b422bc27bff68d15347`. No push, PR, merge, deployment, or independent verdict was performed. The original slice-1 evidence remains in `../diagnosis-center-slice1/`; this bundle supersedes its claim that stored `new` was automatically generated provenance.

The latest matching prior visit inside the preceding 12 calendar months governs: resolved → New; any other clinical status → Established; no match → New. Older matching visits cannot overrule the latest one. The doctor can choose New or Established with one click, including explicitly accepting the same value as the suggestion. The header identifies “ODOS suggestion” versus “Doctor's choice.” This choice is separate from the nine-option visit-status picker and from complexity/MDM.

Assessment has a completion pointer instead of duplicate editors. It passes the diagnosis reference through EncounterCharting's existing guarded view transition. Both New/Established and visit status lock on signed visits. Failed visit-status reads retain the chart and show a local error/Retry. Failed history reads leave an explicit doctor choice available; they do not manufacture a New suggestion.

## Scope and current truth

Re-fetched `origin/main` on 2026-09-14: `6baea1d51666461e3de94ded1287ffe8817d2f70`. Since original pin `ddf6ba4a4f5e06efb13c59759d4941159fe49d0a`, only the unrelated Guarantor link operations and recovery merge (#592) landed. The cited diagnosis files did not change. Fresh open-PR query returned #593 (guarantor-g2b2a); its file list has no overlap with this slice.

Companion checkout verified at `../performance-od`. Read the design §1/§2.1/§7 item 1, R5, the NEEDS WORK evaluation, and `decisions/2026-09-14-odos-diagnosis-center-slice1-fixback-codex-kickoff.md`, including the latest-visit clarification. Existing diagnosis pick callers do not automatically write `new`; legacy stored `new` is treated as Doctor New. No new business decision was created, so `decisions/INDEX.md` was not changed. No companion files were edited.

Original slice-1 still supplies ten stored visit statuses, nine pickable statuses, identical UI/server vocabularies, the ninth No MDM complexity, and removal of both editors from Assessment. Its original consumer audit and No MDM/no-New break/restore evidence remain valid; final full UI and focused MCP checks include those tests. Plans, findings behavior, write-ups, R10/R11, and the E&M footer/override are unchanged.

## Matching and storage contract

- Both Conditions have catalog stable keys: exact key equality, after the existing parser strips encounter prefix and laterality suffix. Current, legacy laterality-suffixed and bare identifiers are supported. Different present keys never fall through to ICD matching. The parser was extracted from carry-forward and reused by both callers.
- Either Condition lacks a catalog key: compare the first three characters of existing normalized ICD-10-CM coding strings (three-character category). Laterality is ignored. **This fallback is coarse and can group different subtypes; it is not exact clinical equivalence.** No fuzzy text or SNOMED-only matching. Unmatchable identities yield no match.
- Search the patient's Encounters through the existing bounded pagination helper (1,000 rows maximum), then locally require start in `[current start minus 12 calendar months, current start)`. Leap day clamps to the preceding year's last February day. Cancelled/error visits and refuted/error Conditions are excluded. Only linked relative Condition references are considered; absolute/other-resource references are not matched.
- A matching Condition is read from its prior visit, not the current visit. Missing/unreadable history, inconsistent patient/encounter ownership, missing full start timestamps, pagination failure or limits refuse the suggestion. Distinct visits with identical start times and conflicting resolution states also refuse. For multiple matching Conditions on the latest visit, all must be resolved to suggest New.
- Suggestions are computed on GET and never stored. Explicit overrides live in the separate `odos_encounter_diagnosis_newness_overrides` SQL table keyed by encounter and Condition, with recorder/time. This preserves the distinction between a changing suggestion and a deliberate choice without changing FHIR clinicalStatus or the existing visit-status vocabulary.
- The new migration runs through the existing schema ledger and copies legacy status `new` to Doctor New once. Changing a legacy visit status later also preserves Doctor New; an existing explicit override wins. SQL constrains override values to New/Established. This migration is necessary for the fixback's new persisted choice, unlike the original unconstrained visit-status expansion.
- GET/PUT use the existing chart.read/chart.write route pattern. PUT checks signed state, confirmed encounter-diagnosis membership, patient and encounter linkage before writing. No policy grants were widened.
- Assessment feeds effective New to the existing protocol ranker exactly when New/Established reads New. Doctor Established suppresses legacy `new`; other visit statuses remain available for their scopes. Status-read failure reports unavailable ranking rather than applying stale newness. This is not connected to MDM, claims, or billing.

## Executed checks

Commands are relative to this worktree unless a different cwd is stated. The linked logs contain actual output; trailing whitespace in TAP output was trimmed for repository whitespace checks.

| Command | Actual result | Evidence |
| --- | --- | --- |
| `npm --prefix ui test` | `# tests 1509`, `# pass 1509`, `# fail 0`, `# skipped 0` | `ui-full.tap` |
| cwd `mcp`: `node --import tsx --test tests/diagnosisNewness.test.ts tests/diagnosisVisitStatus.test.ts tests/diagnosisCarryForward.test.ts tests/v035b-ui-view.test.ts` | `# tests 157`, `# pass 155`, `# fail 0`, `# skipped 2` | `mcp-focused.tap` |
| Disposable Postgres, `ODOS_NEWNESS_TEST_POSTGRES=... node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/diagnosisNewness.test.ts` | `# tests 12`, `# pass 12`, `# fail 0`, `# skipped 0` | `postgres.tap` |
| `npm --prefix ui run build` | exit 0; TypeScript clean, Vite built; existing large-bundle warning | `ui-build.txt` |
| cwd `mcp`: `npx tsc --noEmit` | exit 0; no diagnostics | `mcp-typecheck.txt` |
| `node .claude/skills/tier0-census/scripts/check-proxy-coverage.mjs` | 25 route families, 28 proxy entries; every family covered; advisory check | `proxy-coverage.txt` |
| `node docs/build-log/diagnosis-center-fixback/browser-proof.mjs` | actual EncounterCharting parent → Assessment → selected diagnosis; save/reload three controls; signed locks; isolated status failure | `browser.txt`, `browser-proof.json`, four PNGs |
| `git diff --check` | exit 0, no output | final author check |

The two focused MCP skips are the optional database test without its opt-in and the pre-existing carry-forward Postgres test. The new database test was separately executed with zero skips against our disposable `postgres:16-alpine` container on port 19972. No shared database was used. It proves migration from a legacy row, SQL validation, migration-ledger single application, later legacy preservation, and independent store reload of Doctor Established.

The four required history examples all passed through the read handler: active then resolved → New; resolved then active → Established; active 13 months ago → New; no prior → New. Additional checks cover non-resolved `inactive`, resolved prior, leap day, key parsing, and recomputation after historical resolution changes. The read-handler integration proves saved Established overrides a freshly computed New after reload.

The browser uses real EncounterCharting, AssessmentSection and DiagnosisWorkspace in Chromium, with synthetic intercepted HTTP responses. It follows the parent's real view-switch callback; no test-only callback replaces navigation. It reloads the page and reselects the diagnosis before checking persisted values. This is **not** proof of an authenticated RouteSwitch journey, live Medplum AccessPolicy enforcement, or browser-to-live-database persistence. SQL persistence and server handler checks are separate evidence. Browser fixture setup initially omitted unrelated visit/procedure charge response arrays and selected the navigation group instead of the row; the final harness supplies those contracts and uses the actual row. An initial MCP invocation from root hit cwd-relative fixture paths; the recorded final invocation uses `mcp` and passed.

## Mandate 17 — demonstrated guards

`python3 docs/build-log/diagnosis-center-fixback/mutate-guards.py` broke and restored each guard. All 11 have **broken exit 1 / restored exit 0**, recorded in `guards.json` and paired `*-broken.tap` / `*-restored.tap` files:

1. Most recent governs: change to any unresolved match; active-six-months/resolved-five-months example fails (`established` versus expected `new`).
2. Resolved prior: remove resolved → New branch.
3. Twelve-month window: remove lower-bound exclusion.
4. Computed override precedence: bypass saved choices in GET.
5. Visit-status signed UI lock.
6. New/Established signed UI lock.
7. Newness server signed lock.
8. Assessment protocol-ranking feed.
9. Explicit Established precedence over legacy Doctor New.
10. Assessment completion pointer diagnosis reference.
11. Status-read failure degradation.

`python3 docs/build-log/diagnosis-center-fixback/postgres-guard.py` additionally removed the new migration from initialization: **broken exit 1 / restored exit 0** on separate disposable databases, in `migration-guard.json` and paired TAPs. The script expects the named disposable container and fresh databases; it is not intended for a shared database. The original slice's No MDM exclusion, no-New picker, and vocabulary/artifact mutation results remain under `../diagnosis-center-slice1/`.

The earlier `ui-focused.tap` is checkpoint evidence (46 passing); `ui-full.tap` is the final regression result.

## Files, limitations and handoff

`files.txt` enumerates every fixback file, including evidence. `all-slice-files.txt` enumerates the complete diff from fetched main. Source changes: newness types/reader/handlers, shared identifier parser, status store/migration/route registration, UI client/header/Assessment/navigation, server and UI tests, and one Mandate 14 ledger row. No dependency changes.

Mandate 14: the added ledger row documents local choice semantics and the ICD category fallback; CMS and CDC/NCHS official FY2026 guideline copies agree on three-character category structure. No new standard medical code, FHIR canonical, or billing threshold was introduced. The ledger row itself is documentation, not an enforced registry; the migration and choice constraint are enforced and tested.

Remaining review attention: coarse ICD category fallback; unsupported absolute/history references and missing timestamps; bounded history read cost; same-instant conflicting visits; real Medplum policy/whole-app integration not exercised. The implementation follows the existing signed-state check pattern, not an atomic cross-system sign/write transaction. No doctor-choice reset-to-auto action was requested or added.

**NOT EVALUATED — hand this exact final commit to Fable (high) or Opus (medium) in Claude for independent evaluation. Codex authored it and cannot supply its own verdict.** No PR, push or merge is authorized by this bundle.
