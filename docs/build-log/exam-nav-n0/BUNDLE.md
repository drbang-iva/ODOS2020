# Exam navigation N0 — History completion

Status: needs-review. NOT EVALUATED. Independent signer: HUB in a separate Claude session. Do not merge without the independent exact-head evaluation.

Base: `f21c44fa6affc9d6581b954c81577a9cf080f614`.
Branch: `drbang-iva/exam-nav-n0-history-examined`.

## Summary

An active template complaint now prevents the History requirement from becoming examined until its live answers satisfy the existing `historyTemplateComplete` rule. Saving the aggregate History capture alone produces partial/unresolved. Answering the presentation and every required active section produces examined/resolved. Multiple template complaints must all be charted.

Absent or empty optional rows preserve the previous projection. Free-text-only and no-complaint cases remain unchanged. No FHIR requests, response keys, registry entries, or UI code were added or changed. The clinical-completeness registry's billing boundary is unchanged.

## Files

- `mcp/src/clinical-graph/exam-overview-endpoint.ts`: compute complaint rows from already-loaded complaints and Observations using the existing template declarations, answer recognition/parser, and completion function.
- `mcp/src/clinical-graph/exam-overview-projection.ts`: accept optional rows and apply the prescribed History state before constructing the completeness trace.
- `mcp/tests/examNavigationN0.test.ts`: nine synthetic tests, including G1–G6 and zero-evidence, mixed-complaint, retired/unrelated-answer, and inactive-complaint coverage. G2–G6 use the real complaint/capture/overview handlers as applicable, backed by in-memory FHIR persistence.
- `docs/build-log/exam-nav-n0/GUARDS.md`: every required mutation's red and restored-green suite summary.
- `docs/build-log/exam-nav-n0/BUNDLE.md`: premise checks, regression summaries, limits, and handoff.

No existing tests were edited. `history-template-engine.ts` was unchanged; no added helper was needed. No new decision or Mandate 14 terminology/artifact was introduced, so no decision index or terminology ledger change applies.

## Premises at origin/main

Fetched and verified `origin/main` at the pinned base before implementation. Premises were read using `git show origin/main:<file>`, not working-tree source.

- P1: History is a finding requirement with the `hpi` prefix in both scopes. Undeferred Observations normalize to examined; the existing section rollup computes the base state.
- P2: `hpi_ros` uses section key `hpi`.
- P3: reuse `HISTORY_TEMPLATES`, `activeTemplateSections` through `historyTemplateComplete`, and the unchanged presentation-plus-required-sections completion rule. The only shipped `on` section is optional; no invented on-scoped-required guard was added.
- P4: the endpoint already fetches encounter Observations and complaints. Rows use those collections; no new FHIR call is needed.
- P5: operator-authorized correction: the answer encounter is set at `history-answer-observation.ts:187`. Line 51 belongs to review attestations. The substantive premise holds.
- P6: templateKey is optional; real free-text complaint creation remains supported and is tested unchanged.
- P7: adding a complaint already reports completed false in the client. No client change is needed.
- P8: completed the MCP/UI sweep with the operator-authorized correction below. No additional assertion was found that this implementation flips.

### P8 sweep

Searched `mcp/tests` and `ui/tests` at `origin/main` for `hpi_ros`, History section state, completeness trace, and Examined/Partial labels; inspected matching assertions and fixture setup/call paths. The protected endpoint, projection, HPI, and R10 assertions remain byte-identical. R10 overview fixtures call the projection without complaint rows, preserving their prior result. UI entry-sheet fixtures use not-examined; the Partial examination assertion at board line 2993 belongs to ocular health.

Authorized P8 correction: `ui/tests/examOverviewBoard.test.tsx:3731-3784` combines a template complaint and an empty History answer response with a **mocked** examined overview. It tests refresh wiring, not the real overview handler. It remains unchanged and passes; G6 proves the corrected handler behavior.

## Proof and environment

Dedicated Postgres container: `odos-n0-history-examined` (`postgres:16`), using the CI MCP step's database/user with its own dynamically allocated localhost port. Every MCP suite had `ODOS_POSTGRES_URL` set to that container. Inherited ODOS/Medplum configuration was removed from suite environments. `.odos/operator.env` and `.odos/operator-identity.json` were absent from this fresh worktree, so neither needed moving; no reader-checkout operator identity was copied. Nothing under `.odos/` is committed.

All handler data is synthetic. The FHIR backing store is in memory: this proves handler wiring and projection semantics, not live AccessPolicy enforcement or browser rendering. No authorization policy or FHIR operation changed. No shared database, deployed service, or real-practice system was used. `vf-prac1b-walk-db` was left alone; the stack reaper was not run.

G1–G6 each had one failing test under its specified mutation and one passing test after restoration, with zero skips. Full quoted suite summaries and failure direction appear in [GUARDS.md](GUARDS.md). All mutations were restored. Existing assertions never failed during the focused implementation runs.

### Suite commands

From `mcp/`, focused Node runs use `node --import tsx --test --test-concurrency=1` followed by the named test files.

- Baseline: `tests/examOverviewEndpoint.test.ts tests/examOverviewProjection.test.ts tests/hpiEndpoint.test.ts tests/r10-parity.test.ts`.
- Protected final: the baseline plus `tests/examNavigationN0.test.ts tests/historyTemplateEngine.test.ts tests/complaintEndpoint.test.ts`.
- N0-only development runs: `tests/examNavigationN0.test.ts`.
- Combined implementation run: baseline plus the N0 file.
- Full MCP: `npm test` (the existing runner).
- MCP typecheck: `node node_modules/typescript/bin/tsc --noEmit`.
- UI regression, from `ui/`: `node --import tsx --test --test-concurrency=1 tests/examOverviewBoard.test.tsx tests/hpiSection.test.tsx tests/examShelf.test.tsx tests/examViewState.test.tsx`.

### Development failures

The first new fixture omitted the eye required by current-treatment validation; adding the synthetic eye corrected that setup error. An extra foreign-subject case initially expected partial, but the existing shared finding reader refuses a same-encounter resource outside the patient compartment with 502. The new test now verifies that refusal. These fixes changed only the new test file, never existing assertions, and did not broaden product code.

## All suite-run summaries

### baseline

```text
# tests 272
# suites 0
# pass 272
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2034.229208
exit=0
```

### initial-red

```text
not ok 1 - N0 G1 summary plus an unanswered template complaint is partial and unresolved
not ok 2 - N0 G2 presentation and every required section resolve History
not ok 3 - N0 G3 presentation with a missing required section remains partial
not ok 4 - N0 G4 an entered-in-error presentation cannot complete History
not ok 6 - N0 G6 real complaint, capture, and overview handlers change unresolved to resolved
not ok 7 - N0 projection distinguishes untouched, started, fully charted, and mixed complaints without summary evidence
not ok 8 - N0 live answers exclude cancelled, foreign encounter, foreign subject, and non-answer observations
not ok 9 - N0 answers belong to their complaint and inactive or unknown templates add no requirements
# tests 9
# suites 0
# pass 1
# fail 8
# cancelled 0
# skipped 0
# todo 0
# duration_ms 245.662
exit=1
```

### initial-red-corrected-fixture

```text
not ok 1 - N0 G1 summary plus an unanswered template complaint is partial and unresolved
not ok 3 - N0 G3 presentation with a missing required section remains partial
not ok 4 - N0 G4 an entered-in-error presentation cannot complete History
not ok 6 - N0 G6 real complaint, capture, and overview handlers change unresolved to resolved
not ok 7 - N0 projection distinguishes untouched, started, fully charted, and mixed complaints without summary evidence
not ok 8 - N0 live answers exclude cancelled, foreign encounter, foreign subject, and non-answer observations
not ok 9 - N0 answers belong to their complaint and inactive complaints add no requirements
# tests 9
# suites 0
# pass 2
# fail 7
# cancelled 0
# skipped 0
# todo 0
# duration_ms 258.485917
exit=1
```

### implemented

```text
not ok 8 - N0 live answers exclude cancelled, foreign encounter, foreign subject, and non-answer observations
# tests 281
# suites 0
# pass 280
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1931.483417
exit=1
```

### green-fixture

```text
not ok 8 - N0 live answers exclude cancelled, foreign encounter, foreign subject, and non-answer observations
# tests 9
# suites 0
# pass 8
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 254.756459
exit=1
```

### guards-green

```text
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 250.989459
exit=0
```

### typecheck

```text

exit=0
```

### protected-final

```text
# tests 307
# suites 0
# pass 307
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2271.722916
exit=0
```

### ui-protected

```text
# tests 164
# suites 0
# pass 164
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 16512.431291
exit=0
```

### mcp-full

```text
# tests 6488
# suites 0
# pass 6429
# fail 0
# cancelled 0
# skipped 59
# todo 0
# duration_ms 174357.927042
exit=1
```

The full runner returned exit 1 because the credentialed live stack was intentionally not configured. It reported 6,429 passes, zero failures, and 59 skips; the runner identified 47 of those skips as missing credentialed live-stack coverage. This is not a green full-suite gate; focused synthetic tests and typechecking are the completed author proof. No skipped authorization/clinical integration case is claimed as verified.

## Risks and follow-ups — not done

- Top menu, Overview landing, and stepper (N1–N2) are not done.
- Clipboard ocular, medical, family, social, and ROS groups are not History requirements in this slice (N2).
- Free-text complaints without a History template are not completion requirements; their prior behavior is preserved.
- No UI change is done. The mocked board test's no-answers/Examined scenario describes the pre-fix server and must be re-scenarioed in the next UI slice touching the board, N2 at the latest.
- No other walkthrough finding is done.
- No on-scoped required-section guard was added; no shipped template makes it reachable.
- Independent evaluation is not done. HUB must evaluate the final PR head. The coder posts no verdict and does not merge.

## Cleanup

`docker stop odos-n0-history-examined` returned `odos-n0-history-examined`.

`docker ps --filter name=odos-n0-history-examined` after shutdown:

```text
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
```

`docker ps --filter name=vf-prac1b-walk-db --format '{{.Names}} {{.Status}}'`:

```text
vf-prac1b-walk-db Up 6 days
```

The protected endpoint, projection, HPI, R10 parity, and board test files were checked byte-for-byte against the base: 5/5 unchanged. `git diff --check` passed. No shared service was stopped.
