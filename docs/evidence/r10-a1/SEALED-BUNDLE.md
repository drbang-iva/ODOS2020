# R10 A1 revision 2.1 — implementation and author checks complete — NOT EVALUATED

**Author: GPT-6 Astra (Codex), high effort. NOT EVALUATED.**

## Summary and status

The staff finding-link amendment passed on the real disposable Medplum: fresh Observation update **200**, stale update **412**, one resource, original components and Condition unchanged. The previous staff Condition refusals are now **EXPECTED_UNDER_RULING**. Passed P1–P7 probes were not rerun.

The identity module, read aliases, paginated loader, pure projector, unchanged helper extraction, field pin and parity harness are implemented. Homes are the deduplicated union of legacy Condition evidence and finding-side supports-diagnosis references. There are **zero public handler cutovers, UI changes or writer changes**. No pre-existing assertion was changed.

**Approved scope amendment:** the operator authorized exactly one supports-diagnosis entry in `data/canonical-extensions/registry.json`, namespace `clinical-graph`, status `active`, sliceConsumer `r10-a1`. [Registry diff](registry.diff). The existing guard is unchanged.

**A1 only READS this extension in application code. A2 is its first application writer.** The isolated synthetic P6 probe writes it solely to prove server capability.

**Status: NOT EVALUATED.** Independent evaluation belongs to **Claude Opus, high**, at the exact PR head. This author evidence is not an evaluation verdict.

## Pins and scope

- ODOS implementation base: `40c19a9e442015e1d32396958b661394318713d2`.
- Worktree: `/Users/ericr.bang/GitHub/ODOS2020/.worktrees/r10-a1`; branch: `drbang-iva/r10-a1`. The original preflight worktree was resumed as requested.
- PerformanceOD revision containing the rev-2.1 kickoff and staff-link ruling: `ea7010a5ec475020e91b321d8ed7af997cf7ab31`. Read through `git show origin/main:...`; the shared checkout was never switched, pulled, committed or edited.
- All **12 §2 premises / 13 source blobs** matched the pinned source before implementation: [premises.json](premises.json). The preflight's original rev-2 contract pin was `7e403d3fbbfbf4662e8e816d821d37e7f76f602b`; rev 2.1 changes the two staff expectations and homes rule.
- At publication, freshly fetched `origin/main` is `5f0a67922eb2bcf52a2ab60f99a9dbb810fad384` (PR #607 merged). All 13 premise blobs still match the implementation base: [publication refresh](premises-publication-refresh.json). There were no open PRs at the final scope check. No STAFF-DX-GATE code is included here.

### Files touched

Only the kickoff’s allowed paths plus the explicitly approved one-entry registry exception are changed:

- `mcp/src/clinical-graph/current-finding-identity.ts`: stable ordered identity tuple/hash, envelope verification, exact catalog resolution, roles, eye sets and typed qualifier translation.
- `mcp/src/clinical-graph/finding-read-aliases.ts`: explicit retired atomic aliases, derived using the existing retirement translations; false retired subtype does not imply absence of its replacement.
- `mcp/src/clinical-graph/current-finding-reader.ts`: full encounter paging including retired resources, incomplete refusal, canonical/legacy precedence, conflicts, homes union, raw negative panels, ephemeral definition views and per-source attribution.
- `mcp/src/clinical-graph/finding-section-helpers.ts`: moved history helpers and their dependencies.
- `mcp/src/clinical-graph/custom-section-endpoint.ts`: imports those moved helpers; removes only their original declarations and unused imports. [AST extraction proof](helper-extraction-proof.json) compares all **34 executable/type declarations** before/after, including **11 moved declarations**, byte-for-byte except the `export` modifier.
- Four new test files: `currentFindingIdentity.test.ts`, `currentFindingReader.test.ts`, `findingSectionHelpers.test.ts`, `r10-parity.test.ts`; fixtures/capture/replay under `mcp/tests/fixtures/r10/`.
- `mcp/scripts/r10-preflight.mjs`: disposable live capability harness and the staff-link-only amendment command.
- `docs/evidence/r10-a1/`: raw outputs, source ledger, guards, fixture provenance, validation and this bundle.

`data/canonical-extensions/registry.json` has exactly the one approved entry. No decision was created, so `decisions/INDEX.md` is not applicable to this coding slice. Mandate 14 has **four protocol/type rows**, including the newly added extension row. No new medical code or external profile URL was introduced.

## Live preflight: P1–P7 and amendment

Original command: `node --import tsx mcp/scripts/r10-preflight.mjs run` (executed once before the ruling). Amendment command: `node --import tsx mcp/scripts/r10-preflight.mjs staff-link`.

Final [preflight-results.json](preflight-results.json): **15 role/probe records — 11 PASS, 2 EXPECTED_UNDER_RULING, 2 INFORMATIONAL; stop=false**. Original events **1–156** remain intact. Only events **157–163** were appended. [preflight-http.json](preflight-http.json) includes exact HTTP statuses, bodies, IDs, versions and follow-up reads/searches. [preflight-output.txt](preflight-output.txt) deliberately preserves the original pre-ruling failures; [preflight-amendment-output.txt](preflight-amendment-output.txt) is the amendment's output.

| Probe | Provider | Staff |
|---|---|---|
| P1 conditional create | PASS: concurrent 201/200; count 1; existing and retired match 200; duplicated-identifier fixture 412/count 2 | Same PASS |
| P2 version-aware updates | PASS: fresh 200, stale 412/state unchanged; five concurrent pairs each exactly one 200 and one 412 | Same PASS, five pairs |
| P3 retired search | PASS: entered-in-error and cancelled returned by identifier and encounter searches | Same PASS |
| P4 history | INFORMATIONAL: 200, earlier version/components retained | Same result |
| P5 retire/restore/reassert | PASS: preliminary → entered-in-error → preliminary → update, same ID/identifier/components, count 1 | Same PASS |
| P6 Condition + Provenance | PASS: evidence 200, stale 412; unrelated evidence preserved; Provenance 201 | Original Condition 403s **EXPECTED_UNDER_RULING**; original Provenance 201. Amendment finding link **200/412**, count 1, components/Condition unchanged |
| P7 lost-response witness | PASS: existing writer; reload shows applied value; no retry write; intervening other-login edit; old version refuses 412 | Original Observation 201 then Condition 403 **EXPECTED_UNDER_RULING**; partial state retained in evidence, not a gate under rev 2.1 |

Amendment Observation: `5dcd5e60-b11e-4496-8c23-f07adbc0e8af`, baseline version `23c00fbc-7b83-40b7-bf1b-9f4fe4e4d5a8`, updated version `5ac3e578-3cf1-478d-9e11-a90c38246257`. Link target: `Condition/c1da7624-4208-4582-8587-424897aff4cd`.

### Runtime, policy and verification sources

- Project **odos-r10-a1**, isolated network **10.249.83.0/24**, Medplum at **127.0.0.1:29013**. Synthetic patient/encounter only, no shared or practice database.
- Image `medplum/medplum-server@sha256:358ab425b29390067b6cb82bfbaeee48580a703f7cc5b730bed2b2ba7184c1de`; observed server **5.1.30-9b1bd92**, Linux/Node24.18.1; host Node22.22.3. [runtime.json](runtime.json).
- Real synthetic logins **r10-provider@example.invalid** and **r10-staff@example.invalid**, neither project admin. [principals.json](principals.json) includes effective AccessPolicy IDs, versions, membership bindings and full resource rules. Current compiled policies were installed and read back. No denied write was retried under a more powerful identity.
- Seeder **r10-seeder@example.invalid** creates only the isolated project, identities and prerequisite fixtures. It is never substituted for a gated role. Condition prerequisites for staff probes are created by Provider.
- [Mandate 14 ledger](mandate-14.md): HL7 R4 HTTP/Observation/DomainResource/Extension plus Medplum's official documentation and source pinned to **9b1bd92e987aecdd338ac690b1d368ff11d7ceba**, accessed **2026-09-15**. Sources agree on conditional creation, If-Match/412, history, Observation.extension **0..*** and Extension.value[x] **0..1**, including Reference. The Condition target restriction and supports-diagnosis URL are ODOS-local.
- Credentials, tokens and signing material remain only in ignored `.odos/r10-a1/`. [private-value-scan.json](private-value-scan.json) records the known-value scan; no credentials are in the committed evidence candidates.

P1–P6 are raw HTTP. P7 imports the real existing endpoint function with live HTTP transport and verified role context; it is **not a served-route/authentication-chain proof**. The reload/diff decision is in the diagnostic harness and does not claim that today's endpoint implements A2's retry protocol. The harness maps an unexpected FHIR refusal to a diagnostic 502; the actual staff FHIR Condition result is 403, recorded separately.

## Parity and zero-visible-change proof

Before extraction, the **six unchanged suites** produced **229 captures**: 61 history responses, 14 atomic + 14 section row calls, 22 overview calls, 108 candidate calls and 10 completeness predicates. The capture run had **198 passed / 0 failed / 0 skipped**. Captures include actual production inputs/outputs, stored in an interned JSON pool. Nine incidental synthetic definition UUIDs were consistently normalized to avoid the existing privacy guard; all 61 history byte strings were verified unchanged. [Fixture README](../../../mcp/tests/fixtures/r10/README.md) describes replay and normalization.

After extraction: **61/61 history responses byte-identical**. The six baseline suite hashes remain identical. All nine required existing suites pass unchanged. The helper AST proof also covers the non-history declarations. The current reader/projector has no public handler caller; only tests import it.

The parity harness explicitly pins **five overview divergences** for retired-option translation (brunescent alone/combined, horseshoe tear, iron line, macular hole). A translated view has no safe aggregate FHIR ID, so feeding it to today's ID-requiring overview yields zero rows. The projection retains the facts/typed details. Each difference has a checked output hash and fact/conflict/unresolved counts in `parity-divergences.json`; there is no generic difference allowance. These are library integration constraints for A2/A3, with zero visible A1 changes.

E1–E17 replay: **17 original writer/reader outcomes reproduced + 17 corresponding A1 outcomes asserted**. It preserves the current atomic-pick 422, section grade 400 and atomic section-void exclusion while proving the new library semantics. OU, conflicts, latest snapshot omission, retired canonical dominance, retired legacy fallback, negative acts, cancelled/UNKNOWN, nested codes and typed qualifiers have dedicated fixtures. Homes have extension-only, evidence-only, both, disagreeing, coalesced and conflicting-source fixtures.

## Checks and exact counts

| Command | Result | Output |
|---|---|---|
| `npm --prefix mcp test` with isolated PostgreSQL | **5,280 pass / 0 fail / 51 skip**, exit 0 | [mcp-test-final.txt](mcp-test-final.txt) |
| `npm --prefix ui test` | **1,560 pass / 0 fail / 0 skip**, exit 0 | [ui-test.txt](ui-test.txt) |
| `npm --prefix mcp run build` | exit 0 | [mcp-build.txt](mcp-build.txt) |
| `npm --prefix ui run build` | exit 0; existing Vite large-chunk warning | [ui-build.txt](ui-build.txt) |
| `npm run preflight` | exit 0, **zero warnings / zero hard blocks** | [repo-preflight-final.txt](repo-preflight-final.txt) |
| New focused tests | **270 pass / 0 fail / 0 skip** | [r10-focused.txt](r10-focused.txt) |
| Existing privacy + search-contract guard checks after fixture/loader corrections | **6 pass / 0 fail** | [in-scope-guard-fixes.txt](in-scope-guard-fixes.txt) |
| `node --check mcp/scripts/r10-preflight.mjs` | exit 0 | Included in final validation |
| `git diff --check` | exit 0 for tracked diff; final all-file whitespace scan in validation | [validation.txt](validation.txt) |

The final MCP command uses `ODOS_POSTGRES_URL` pointing to the disposable PostgreSQL at **127.0.0.1:29032/odos_r10_tests**, `MEDPLUM_BASE_URL=http://127.0.0.1:29013`, and the repository's documented `ODOS_ALLOW_UNGATED_MCP=1`. Credentials are injected privately, never printed. **43 of the 51 skips are general live Medplum tests; this full-suite run does not gate live authorization.** The other eight skips require separate consent/clinician/migration/enrollment/PDF environments. A1's required real role capabilities are the separate preserved P1–P7 evidence above.

The first full MCP run (5,258 pass / 11 fail / 63 skip) is retained in `mcp-test.txt` for honesty. Missing test PostgreSQL, new fixture UUID/hash false positives and a loader wrapper that the existing search-contract analyzer could not resolve were corrected in allowed paths/environment; no old assertion or guard was changed. The second full run reduced this to the registry entry pending scope approval. After approval, the final full run has zero failures. [Test-result delta](full-suite-delta.json) confirms the registry source guard is the only changed outcome (fail → pass), with 51 skips unchanged. An intermediate post-approval run caught a broad existing copy-lint match in the bundle wording; the prose was corrected, the guard retained, and the final full run repeated. Its output remains in `mcp-test-registry-doclint.txt`. No additional application-code change was needed.

Per-suite results below are separately executed with `node --import tsx --test tests/<suite>.test.ts` from `mcp/`; [suites/results.json](suites/results.json) records each command and exit, with raw outputs alongside it.

| Suite | Pass | Fail | Skip |
|---|---:|---:|---:|
| `diagnosisFindings` | 42 | 0 | 0 |
| `customSectionEndpoint` | 55 | 0 | 0 |
| `examOverviewProjection` | 22 | 0 | 0 |
| `findingDefinitionStore` | 13 | 0 | 0 |
| `diagnosisLinkL1` | 28 | 0 | 0 |
| `diagnosisLinkL2` | 47 | 0 | 0 |
| `diagnosisLinkL3` | 4 | 0 | 0 |
| `cupDiscEndpoint` | 8 | 0 | 0 |
| `glaucoma-suspect-clinical-graph` | 49 | 0 | 0 |
| `currentFindingIdentity` | 15 | 0 | 0 |
| `currentFindingReader` | 24 | 0 | 0 |
| `findingSectionHelpers` | 62 | 0 | 0 |
| `r10-parity` | 169 | 0 | 0 |

## Mandate 17: executed mutations

Each mutation was made only in a detached scratch worktree, failed with an assertion, restored byte-for-byte and then passed. [guards/results.json](guards/results.json) includes commands, exits and original/mutant/restored hashes; `guards/<guard>-red.txt` and `-green.txt` preserve both outputs. [run-guards.py](run-guards.py) is the replay driver. **All 12 required mutations: RED exit 1 / GREEN exit 0.**

| Guard | Deliberate failure |
|---|---|
| G1 | Reorder two posterior structures → compiled field identity pin |
| G2 | Split atomic IDs on `::` → nested exact catalog resolution |
| G3 | Remove eye prefixes from views → component byte equality |
| G4a | Select the oldest snapshot → omitted option revives |
| G4b | Treat retired legacy atomic as canonical → snapshot positive suppressed |
| G4c | Ignore retired canonical → clear marker loses dominance |
| G5 | Skip OU expansion → missing two-eye facts |
| G6 | Classify a negative act as snapshot → latest positive lost |
| G7 | Return a stale constant from compatRows → captured row parity |
| G8 | Return empty projection for incomplete input → refusal guard |
| G9 | Change one character of a moved helper → 61-response history guard |
| G10 | Skip hash validation → mismatched envelope accepted |

These guards are executable. The Mandate 14 source ledger is documentation: **this list is not enforced**. The approved registry entry also has an executed removal/restore mutation: **RED 17 pass / 1 fail, exit 1; GREEN 18 pass / 0 fail, exit 0**. Deleting the entry specifically fails the existing canonical source guard. Evidence: [registry guard](registry-guard.json), [red](registry-red.txt), [green](registry-green.txt).

## Risks and follow-ups

1. **Registry scope exception approved and applied.** Exactly one entry; source guards and pre-existing assertions remain unchanged. Both preflight and the full MCP suite now pass.
2. **A2/A3 must adapt read consumers with their writers.** Merged/translated views are intentionally not linkable; today's ID-requiring consumers cannot be wired directly to them. The five pinned differences and E1–E17 replay must travel into the cutover work.
3. **Staff diagnosis gate remains a separate slice.** Today's staff finding writer still exhibits the documented half-write until that independent gate repair/A2 lands. A1 supplies no UI or writer repair.
4. **Carry attribution is supplied by the caller's existing provenance read.** Missing attribution remains unknown; it is never silently defaulted to current. Negative acts remain raw; their clinical projection belongs to B.
5. **Independent review remains required.** CodeRabbit/PR-Agent status is reported with the PR handoff. No merge, deployment, evaluated label or author verdict is claimed.

## Cleanup

The detached mutation scratch `.worktrees/r10-a1-guards` was removed after checking all restored hashes against the task files: [scratch-cleanup.json](scratch-cleanup.json). The task worktree and ignored synthetic state are retained.

Stopped, not removed, using `docker ps -q --filter "name=^odos-r10-a1-" | xargs -r docker stop`:

- `odos-r10-a1-medplum-1` — `16332e771c42`
- `odos-r10-a1-postgres-1` — `1d721efacf0f`
- `odos-r10-a1-redis-1` — `911cda9c3276`
- `odos-r10-a1-test-postgres` — `15142aa32c1d`

All four are confirmed **Exited (0)** in [containers-after-stop.txt](containers-after-stop.txt); none are running. Other containers/services were untouched. Captured text logs have trailing spaces and extra blank lines at EOF removed solely for `git diff --check`; statuses, assertion failures and counts are preserved.
