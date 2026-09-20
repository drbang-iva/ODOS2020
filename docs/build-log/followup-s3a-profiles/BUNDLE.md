# S3a profiles as data — REV 3 author bundle

NOT EVALUATED. Independent evaluator: Claude Opus 5.

## Summary

Five shipped profiles now have a coded-Basic store and editable practice overlays.
Writes compare the caller's version and conditionally create the first row; concurrent losers are refused.
Settings provides five picker lists, reordering, removal, on/off, copy and reset.
The server rejects unknown fields and unresolved references without an explicit reason.
Real staff reads succeed while both profile writes return 403.
No chart consumer was added; chart editor IDs and text match the base at both widths.
REV 3 changes the existing routing inventory from 56 to 57 only; its loop remains intact.
All author checks below are green; independent evaluation and merge remain outstanding.

## Identity and files

Branch: `drbang-iva/followup-s3a-profiles`. Pinned base: `b217714c2f8963a3c87d537fd00910133257c2a8`. The PR supplies the final head SHA; [verification-seal.json](verification-seal.json) binds the verified application sources and served assets by SHA-256 without a self-referential commit hash.

Latest fetched main during REV 3: `8802dcbaf868fc17f4e414566f97a754bceddd57`. Its only changes from the pinned base are ephemeral-stack compose/tooling, install documentation and package script entries; the S3a premise files did not move. The task remains on the requested base. The only open PR at that scope check was #626, affecting AGENTS.md.

New application/test files:

- `mcp/src/clinical-graph/follow-up-profile-store.ts`
- `mcp/src/clinical-graph/follow-up-profile-endpoint.ts`
- `data/canonical-extensions/odos-follow-up-profile-json.json`
- `ui/src/components/settings/FollowUpProfilesSettings.tsx`
- `ui/src/lib/follow-up-profiles.ts`
- `mcp/tests/followUpProfileStore.test.ts`
- `mcp/tests/followUpProfileEndpoint.test.ts`
- `mcp/src/__tests__/follow-up-profile-keys.test.ts`
- `ui/tests/followUpProfilesSettings.test.tsx`

Narrow edits: `mcp/src/index.ts` (route import/registration), `data/canonical-extensions/registry.json` (one entry), `deploy/frontdoor/Caddyfile` (one handle), `ui/src/scenes/ChartFieldsSettings.tsx` (import/mount), `ui/tests/clinicalGraphRouting.test.tsx` (56 → 57 only). No CSS change. Evidence and reproducible proof helpers are under this directory.

Route registration is after the existing registered routes, and its import occupies an existing blank line: this preserves existing line-bound FHIR-read inventory entries without editing the excluded inventory script.

## Premises P1–P10

| Premise | Verified result |
| --- | --- |
| P1/P1b | Section-group store shape confirmed, but its concurrency is not copied. The new store uses caller expectedVersion, If-Match carrying that version, identifier If-None-Exist, and a returned write-token winner check, following exam-scope-store:38–58. The old store is unchanged. |
| P2 | Catalogue read accepts chart.read or finding-definitions.write; create/update require the latter; unknown fields fail strict schemas. |
| P3 | The existing section-group Settings component is mounted in ChartFieldsSettings; profiles mount beside it. |
| P4 | Existing route registration remains in index.ts; the three new profile routes use the existing staff authentication path. |
| P5 | Unregistered ODOS extension URLs hard-block preflight. Both the new Basic JSON StructureDefinition and its registry entry are present. |
| P6 | Front-door route parity is blocking in CI; the new top-level route has its own Caddy handle. |
| P7 | The plan-set orderable-or-pending test is the G2 precedent, using actual PROCEDURE_FEE_SEEDS and PENDING_ORDERABLES. |
| P8 | Read-only design/profiles.json at companion commit 9e1913b4: unmodified source checker replay reports 85 checked, 85 match, 0 mismatch, all rulings hold. Seed keys and source content are preserved. |
| P9 | Template-keyed completeness and encounter scope already exist. Neither projection nor scope store nor any chart implementation changed. |
| P10 | Seeds have no MDM fields; strict request schemas reject them, including nested unknown fields. |

Original exact-module probe and premise/source details: [BLOCKED.md](BLOCKED.md), [premise-probe.mjs](premise-probe.mjs), [premise-probe-results.json](premise-probe-results.json). REV 2 resolves its two original blockers. [REV2-BLOCKED.md](REV2-BLOCKED.md) preserves the later inventory failure; REV 3 resolves it. Those files describe historical states, not the final implementation.

Source strings used as prior-value/history/diagnosis choices are retained from the supplied data. They are catalogue data only; this slice does not implement diagnosis matching, historical reads or episode creation.

## G1–G9

[GUARDS.md](GUARDS.md) quotes the command and red/restored output for every mutation. Structured evidence: [mutations.json](mutations.json) and [g7b-mutations.json](g7b-mutations.json). **17/17 deliberate breaks exit 1; 17/17 restorations exit 0.** No existing assertion was removed, shortened or skipped.

- G1: actual ocular-health builder keys, actual constructor section-group seeds, and the UI BuiltInSectionId AST form the cross-package oracle in `mcp/src/__tests__/follow-up-profile-keys.test.ts`. A fictional section fails.
- G2: fictional orderable without a reason fails against the actual orderable/pending sets.
- G3: seed MDM insertion and weakening request strictness each fail.
- G4: seed preference over a stored practice overlay fails.
- G5a: ignoring the caller version fails; G5b: dropping conditional creation fails; G5c: making the first seed overlay unconditional fails.
- G6: deleting the write permission check fails for chart.read-only staff.
- G7: accepting an unresolved reference without a reason fails.
- G7b: both the inventory and per-caller assertions are demonstrated with separate local-helper variants. The zero-argument local helper remains caller 57 and fails the loop's `doesNotMatch`; the explicit-argument local helper drops out of the literal inventory and fails `56 !== 57`. A failed count stops this sequential test before its loop, so these are intentionally separate red runs. Restored code imports the shared helper and defines neither local helper.
- G8: deleting the extension registry entry fails preflight (`odos-extension-url-shape`); deleting the Caddy handle fails front-door parity.
- G9: **verification, not mutation**. The allowlist forbids changing the chart to manufacture a red. The source seal lists all 14 application/test files and zero chart files. Every base UI test remains; only the authorized inventory number changed. Full UI: 1,808 base + 3 added = 1,811 passed.

Tests added: 15 MCP tests and 3 UI tests. Three additional Settings mutations cover picker persistence, reset caller-version forwarding and read-only controls.

Seed catalogue enforcement: G1/G2 are executable guards; breaking a resolving key goes red.

Decision files: no decisions/ file describes a chart shape repaired by this catalogue-only slice. No new design decision, decisions/INDEX.md change or companion edit was made.

## Known unavailable source references

| Reference | Reason/context preserved |
| --- | --- |
| oct-retina | No OCT-retina orderable exists. |
| erg | Explicitly pending rather than orderable. |
| ocular-surface-staining | Result section exists; no orderable. |
| tear-osmolarity | Result section exists; no orderable. |
| inflammadry-mmp-9 | Result section exists; no orderable. |
| meibography | Capture/result section exists; no orderable. |
| group:binocular-vision | Proposed group has not been built. |
| group:sensory | Proposed group has not been built. |
| punctal-plug-status | Finding has not been built; the existing procedure is not that finding. |
| dry-macular-degeneration, dry-eye, red-eye, binocular-vision history templates | Source marks these templates unbuilt. |
| rose-bengal | Source marks this dye option absent from the shipped list. |

The source's global-shelf `anterior-segment-photography` is also known absent as an orderable, but is not one of the five profiles' default queued tests. Fundus photography resolves. `vision-therapy` remains source episode-type text; episode creation is not implemented here. No new clinical/billing code, orderable concept or interval was asserted. Mandate 14 ledger additions: 0.

## Real-stack proof 1–5

Command: `node docs/build-log/followup-s3a-profiles/proof/browser.mjs`; base capture uses `--before`.

```text
before: widths [1440,390], passed true
after: widths [1440,390], passed true
each width: 5 seeds; 5 lists; overlayPersists true; shippedUntouched true; resetRestored true
each width: staff read 200; create 403; update 403; disabledLists 5
chart comparison: 2/2 widths, drawn editor IDs and text identical; zero chart page errors
```

Proof 1: `screenshots/{1440,390}-profiles-listed.png` and `-profile-five-lists.png`.
Proof 2: `screenshots/{1440,390}-profile-overlay.png`; actual picker → save → reload → API read confirms practice persistence and untouched shipped data; reset is asserted against the shipped profile.
Proof 3: `screenshots/{1440,390}-profile-read-only.png`; actual staff UI and authenticated HTTP responses, not a fake policy engine.
Proof 4: `screenshots/{1440,390}-chart-before.png` and `-chart-after.png`. Separate base/proposed worktrees and servers, ports 31692/31691, same synthetic encounter and viewport. No chart code differs. Build badge branch/time differ as expected; these are not pixel-equality claims. Existing narrow-screen chart clipping remains unchanged and outside scope.
Proof 5: full-suite and typecheck/preflight summaries below.

## Full checks

| Check | Base | Proposed |
| --- | --- | --- |
| `npm --prefix ui test` | 1,808 pass, 0 fail, 0 skip | 1,811 pass, 0 fail, 0 skip |
| Full MCP CI command below | 6,089 pass, 0 fail, 55 skip; 6,144 total | 6,104 pass, 0 fail, 55 skip; 6,159 total |
| `npx tsc --noEmit` in ui | exit 0 | exit 0 |
| `npx tsc --noEmit` in mcp | exit 0 | exit 0 |
| `npm run preflight` | 0 warnings, 0 blocks | 0 warnings, 0 blocks |

MCP count: 6,144 base + 15 added = 6,159 total. The 55 existing skips are gated tests; no new skips. Full MCP follows the repository's CI lane command from mcp/, with ODOS_POSTGRES_URL pointing to task-owned synthetic Postgres:

```sh
node --import tsx --test --test-concurrency=1 'src/__tests__/**/*.test.ts' 'tests/**/*.test.ts' '../tests/boundaries/**/*.test.ts' '../tests/observation-status-machine/**/*.test.ts' '../tests/setup-wizard/**/*.test.ts' '../tests/preflight/**/*.test.ts' '../tests/smart/**/*.test.ts' '../tests/cds/**/*.test.ts' '../tests/agentops/**/*.test.ts' '../tests/bulk-data/**/*.test.ts' '../tests/mandate-8/**/*.test.ts'
```

Production MCP/UI build and `git diff --check`: exit 0. Front-door coverage: PASS, zero missing route families. Earlier misconfigured combined MCP invocations are disclosed in REV2-BLOCKED.md; they are not counted as successful runs or hidden by test edits. Existing gated live suites are not represented as locally executed by the full CI-command run; the new feature's real staff authorization is proven separately above.

## Cleanup, limits and handoff

Both app supervisors and task containers stopped. Synthetic volumes retained for reproducibility.

```sh
docker ps --filter name=odos-s3a- --format 'table {{.Names}}\t{{.Status}}'
```

```text
NAMES     STATUS
```

No outside-allowlist edit is needed for the completed checks. REV 3's test-count exception is the only expansion used. The new top-level route is verified through Caddy. Adding a default Vite development proxy remains outside scope; development without Caddy requires the existing VITE_ODOS_MCP_BASE_URL setting.

The old section-group store's unconditional-create/stale-client weakness remains an operator follow-up; it was not repaired. Profile data is not yet consumed by the chart. The tests and browser walkthrough are author verification, not an independent verdict.

NOT DONE, intentionally: shape record; What are we following picker; board reading profiles; test queue; right-panel Follow-up tab; any change to visit opening or rendering.

Coded-by: Codex — gpt-6-astra, high effort

needs-review
