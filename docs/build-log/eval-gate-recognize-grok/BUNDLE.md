# Grok coder recognition — author evidence

Status: **NOT EVALUATED**. Codex authored this change; Claude Opus 5.5 must evaluate the exact PR head before merge.

Branch: `drbang-iva/eval-gate-recognize-grok`  
Base: `205d95c8d53cdfbca1bc28a6b1d05d735f53f405`

## Result

The evaluation gate now recognizes Grok as a coding tool in visible `Coded-by:` declarations. Grok remains absent from `TRUSTED_MODEL_PATTERN`, so Grok evaluation signatures still fail as `untrusted-model`. Existing Codex/Claude single-coder diagnostics remain unchanged. Multi-coder diagnostics derive their tool names from the shared Codex/Claude/Grok name map.

## Premises

- P1: base `TOOL_TOKENS` contained Codex and Claude only, and visible coder declarations accepted only `Codex|Claude`.
- P2: trusted-model rejection runs before tool-independence classification; Grok remains untrusted.
- P3: the base multi-coder message was hard-coded to Codex and Claude. Existing regex assertions at lines 1003–1006 and the Codex+Claude message pins remained unchanged and green.
- P4: the 106 existing focused tests remained green. Six appended tests bring the focused file to 112 tests.
- P5: the PR template used `<Codex | Claude>` and both template guards failed closed. The edited `<Codex | Claude | Grok>` placeholder also fails closed.

## Checks

The initial base run used the dedicated `odos-grokgate-base-205d95c8` PostgreSQL 16 container. The authorized base rerun and candidate runs used the fresh dedicated `odos-grokgate-base-rerun` container. Each run set `ODOS_POSTGRES_URL`; `.odos/operator.env` and `.odos/operator-identity.json` were absent for every unit run.

### Base full MCP suite

Command: `ODOS_ALLOW_UNGATED_MCP=1 ODOS_POSTGRES_URL=<task-postgres> npm --prefix mcp test`

The first untouched-base run produced the ruled `educationEnrollmentApi.test.ts` local-server flake:

```text
# tests 6470
# pass 6410
# fail 1
# skipped 59
not ok 2017 - sequence API records a new stage while an old attempt is unknown and only practitioner acknowledgement releases its hold
error: fetch failed
```

R2 authorized one full rerun. The rerun was green:

```text
# tests 6470
# pass 6411
# fail 0
# cancelled 0
# skipped 59
```

Recorded unrelated flakes: the observed `educationEnrollmentApi.test.ts` local `app.listen(0)` `fetch failed` flake, and the previously known `r10OcularHealthDoorAuthzLive.test.ts:280` flake. Neither path is used by this gate change.

### Candidate checks

Focused gate file:

```text
# tests 112
# pass 112
# fail 0
# skipped 0
```

Full MCP suite:

```text
# tests 6476
# pass 6417
# fail 0
# cancelled 0
# skipped 59
```

MCP typecheck: `npm --prefix mcp exec tsc -- --noEmit` — exit 0, no output.

Preflight: `ODOS_POSTGRES_URL=<task-postgres> npm run preflight`

```text
ODOS preflight complete: 0 warning(s), 0 hard block(s).
```

No live lane was run because the evaluation gate is pure local parsing logic. The full suite explicitly acknowledged its 47 ungated live-stack skips.

## Scope and risk

Changed files are limited to the gate parser, PR template, appended gate tests, and this build-log directory. `TRUSTED_MODEL_PATTERN`, `EXPECTED_FORM`, the workflow, `scripts/eval-post-verdict.sh`, and the template fixture remain unchanged. The primary remaining risk is a parser edge case outside the appended Grok cases; the existing 106-test gate suite and V1–V6 mutations constrain that risk.

No medical terminology, FHIR artifact URL, or regulatory citation changed, so Mandate 14 adds no ledger row. No new product decision was made in this repository; the operator ruling already lives in the companion decision record.
