# Follow-up S1b — no category defaults

NOT EVALUATED. Coder: Codex (GPT-6), high effort. Independent evaluator requested by kickoff: Claude Opus 5. No evaluation marker or merge.

Section groups now become effective only through pull-in or saved content. The catalog no longer resolves or returns visit-type categories/defaults; strict create/update schemas reject the removed field by name. Legacy rows load regardless of that obsolete key's value, and their next save omits it. Settings retains create/edit/deactivate without category controls. The chart recomputes pulled-in ∪ content-pinned groups after removal.

## Scope and premises

Base fetched and verified before starting: `aa73bf4d711f6c4a0649e04fe4fe2fa5a50abfad`. Branch: `drbang-iva/followup-s1b-no-category-defaults`. Open PR #626 touched only AGENTS.md; no implementation overlap. Premises were read from `origin/main`, not the root working tree.

- P1 confirmed: endpoint schemas, category resolution, private `loadVisitTypeCategories` (one caller), default/pull-in/content union and catalog fields.
- P2 confirmed: store type, empty seeded defaults, resolver, parser and JSON serialization.
- P3 confirmed: UI group/catalog fields.
- P4 confirmed: Settings draft/load/new/save, display and category picker.
- P5 confirmed: chart catalog state and post-remove default union.
- P6 confirmed: MCP and UI tests still assumed category defaults.
- P7 confirmed experimentally on a separate untouched base checkout: deleting the live-status filter left **23 tests, 23 pass, 0 fail** (`proof/P7-baseline-mutation.txt`). REV 2 correctly states old G2 inserted canonicalFact directly.

Permanent application/test changes are exactly the seven kickoff files. `finding-section-content.ts` was mutated temporarily and restored byte-for-byte. All additional files are under this evidence directory. No new decision was made, so no decisions/INDEX.md change; no new terminology/FHIR URL assertions were introduced into application code, so no Mandate 14 ledger rows. Existing builders/constants supply synthetic fixtures.

## F1 writer proof

`S1b G4` uses the real `executeFindingCommand`, called by the chart's custom-section endpoint and diagnosis-findings endpoint. It writes live and retired states through the writer, checks applied/complete outcomes, verifies pinning and 409 while live, then verifies no pin and successful removal after clear. The writer-harness supplies the in-memory FHIR implementation; group Basic searches retain their existing fake semantics. Clinical resources are read directly from the writer-owned store, never hand-inserted or manually flipped between states. The first attempt passed; no fallback was needed.

## Browser proof (1440 × 1100)

Only the disposable `odos-s1b-proof` stack was used. No Iris or real-practice data was accessed. Existing user containers were left alone.

1. Settings picker present in `01-settings-before.png`, absent in `01-settings-after.png`. Creation returned 201 and edit returned 200; `02-settings-created-edited.png` shows the saved group. UI guard also proves deactivate.
2. Comprehensive encounter: `03-comprehensive-hidden.png` → `04-pulled-in.png` → `05-save-pinned.png` → `06-empty-before-remove.png` → `07-empty-removed.png`. Save returned 200; pinned removal returned 409 with `section-group-has-content`; clear returned 200; removal after clearing returned 200 and sections disappeared. See `proof/fresh-http.json`, `proof/clear-http.json`, and `proof/chart-browser-final.txt`.
3. Clear and refused removal were invoked through actual same-origin chart endpoints from the authenticated synthetic browser session. The Symptoms page has no Clear chart button; the initial locator failure is retained in `proof/chart-browser.txt`. The final complete proof uses `/void` with section scope, then reloads before removal. This is not a claim that Symptoms gained a clear control. F1's atomic writer proof is separately covered above.

Screenshots were visually inspected. The first captures used an uncommitted patch and disclosed that limitation. After CodeRabbit's provenance finding, all after screenshots and browser proof were regenerated from clean committed head `d4bf0d9ab682c0a036ecee43d084b8b2f779cbdf`, with `dirty: false`. `proof/served-identity.json` records that head, served asset hashes, image digest, process/port identity and application-source hashes. Its root is repository-relative (`.`). The final evidence commit changes only this evidence directory; application and test code are identical to the clean captured commit. The baseline screenshot still represents aa73bf4d.

CodeRabbit findings addressed: portable Chrome channel; repository-relative sealed root; clean-commit rebuild/recapture. The Settings proof now uses a unique synthetic group key so repeated runs do not collide. Both Settings create/edit and the full chart flow passed on the clean build. A recapture startup hit synthetic login HTTP 429; after the rate-limit window the unchanged stack passed readiness and both proofs. No policy or credential change was made to bypass it.

## Verification

Exact full-suite commands:

```sh
# Original setup attempt (default PostgreSQL unavailable)
ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test
# Corrected baseline in detached s1b-baseline checkout, and changed checkout
ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:27433/medplum ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test
npm --prefix ui test
npm --prefix mcp run build
npm --prefix ui run build
node .claude/skills/tier0-census/scripts/check-proxy-coverage.mjs
```

The first MCP setup attempt reported 5,989 pass / 28 fail / 67 skipped (6,084 test-runner entries including a failed file hook). Those failures were default-database connection failures and are retained in `proof/mcp-before.txt`. The corrected base used this task's isolated PostgreSQL and passed. Full MCP runs intentionally acknowledge unavailable general live-authz fixtures with `ODOS_ALLOW_UNGATED_MCP=1`; they are not credentialed authorization proof. The browser lane did use real local policies and endpoints.

Builds completed with exit 0. Vite reported its existing large-chunk warning. Proxy census: 25 route families / 28 entries, every family covered (advisory census). Focused suites: MCP 27 pass / 0 fail; UI 11 pass / 0 fail.

## Remaining category consumers and limits

- `exam-overview-endpoint.ts` still resolves `visitTypeCategoryId`; `exam-overview-projection.ts` selects `CLINICAL_SECTION_REQUIREMENTS` with it. The `exams` policy controls required/completeness sections. This remains exam-scope category behavior and is reported, not fixed.
- `clinic/eye-exam-visit.ts` still classifies visits by category for its callers; this slice does not alter it. Search evidence: `proof/remaining-category-consumers.txt`.
- General live-authz suites remain skipped; do not infer full policy enforcement from fake-store unit tests.
- Kickoff author must check live settings before merge. Legacy practice rows are tolerated, not migrated.
- Follow-up profiles: not done. Shelf and search: not done. Visit types/scheduling categories themselves: not changed. Iris migration: not done.
- NOT EVALUATED — hand to Claude Opus 5 for the independent evaluation before merge. No merge authorized.

## G1–G6 mutation outputs

Mutations and exact commands: `proof/mutations.py`; full outputs: `proof/guards/`. Each mutant was restored before its green run.

### G1

RED:

```text
# tests 1
# pass 0
# fail 1
```

GREEN:

```text
# tests 1
# pass 1
# fail 0
```

### G2

RED:

```text
# tests 1
# pass 0
# fail 1
```

GREEN:

```text
# tests 1
# pass 1
# fail 0
```

### G3

RED:

```text
# tests 2
# pass 0
# fail 2
```

GREEN:

```text
# tests 2
# pass 2
# fail 0
```

### G4

RED:

```text
# tests 1
# pass 0
# fail 1
```

GREEN:

```text
# tests 1
# pass 1
# fail 0
```

### G5

RED:

```text
# tests 8
# pass 6
# fail 2
```

GREEN:

```text
# tests 8
# pass 8
# fail 0
```

### G6

RED:

```text
# tests 1
# pass 0
# fail 1
```

GREEN:

```text
# tests 1
# pass 1
# fail 0
```

G4 restoration:

```sh
git diff --stat -- mcp/src/clinical-graph/finding-section-content.ts
```

Output: empty.

## Full-suite counts and final container state

| Suite | Before | After |
|---|---|---|
| MCP, isolated PostgreSQL | 6,028 pass / 0 fail / 55 skipped (6,083 total) | 6,032 pass / 0 fail / 55 skipped (6,087 total) |
| UI | 1,762 pass / 0 fail / 0 skipped | 1,762 pass / 0 fail / 0 skipped |

Full outputs are `proof/mcp-before-configured.txt`, `proof/mcp-after.txt`, `proof/ui-before.txt`, `proof/ui-after.txt`. One obsolete default-resolver test was removed and five S1b tests added (+4). Existing UI coverage was extended in place.

`docker ps --format '{{.Names}}\t{{.Status}}'` after stopping the owned stack:

```text
vf-prac1b-walk-db	Up 18 hours
odos-matrix-proof-medplum-server-1	Up 4 days
odos-matrix-proof-postgres-1	Up 4 days (healthy)
odos-matrix-proof-redis-1	Up 4 days (healthy)
odos-matrix-1-medplum-server-1	Up 4 days
odos-matrix-1-postgres-1	Up 4 days (healthy)
odos-matrix-1-redis-1	Up 4 days (healthy)
odos-consent-safety-redis-1	Up 4 days (healthy)
odos-consent-safety-postgres-1	Up 4 days (healthy)
odos-history-1d5-postgres-1	Up 4 days (healthy)
odos-history-1d5-redis-1	Up 4 days (healthy)
```

No running `odos-s1b-` containers. Task app processes stopped; volumes retained.
