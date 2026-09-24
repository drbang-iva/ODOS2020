# V1–V6 mutation results

Each named production guard was deliberately broken, its focused test was observed red, the original bytes were restored, and the same test was observed green. Commands used Node's test-name filter against `mcp/tests/evaluationVerdict.test.ts` with the task PostgreSQL URL set.

## V1 — Grok coder recognition

Mutation: removed `Grok` from the visible `Coded-by` alternation.

```text
not ok 1 - V1 Grok coder accepts trusted Claude and Codex evaluations
# tests 1
# pass 0
# fail 1
```

Restored:

```text
# tests 1
# pass 1
# fail 0
```

## V2 — whole-word coder boundary

Mutation: removed the coder alternation's trailing word boundary.

```text
not ok 1 - V2 Grok coder recognition requires a whole-word tool name
# tests 1
# pass 0
# fail 1
```

Restored:

```text
# tests 1
# pass 1
# fail 0
```

## V3 — evaluator allowlist exclusion

Mutation: added versioned Grok signatures to `TRUSTED_MODEL_PATTERN`.

```text
not ok 1 - V3 Grok remains excluded from the trusted evaluator allowlist
# tests 1
# pass 0
# fail 1
```

Restored:

```text
# tests 1
# pass 1
# fail 0
```

## V4 — declared multi-coder names

Mutation: restored the hard-coded `both Codex and Claude` diagnostic. The restored guard also verifies canonical Codex-before-Claude map order for reversed declarations and uses accurate generic guidance when a mixed Grok pair still has an independent trusted tool available.

```text
not ok 1 - V4 multi-coder message names the declared Claude and Grok tools
# tests 1
# pass 0
# fail 1
```

Restored:

```text
# tests 1
# pass 1
# fail 0
```

## V5 — Grok/Claude tool independence

Mutation: classified the Grok token as Claude as well as Grok.

```text
not ok 1 - V5 Grok-only coding remains independent from a Claude evaluation
# tests 1
# pass 0
# fail 1
```

Restored:

```text
# tests 1
# pass 1
# fail 0
```

## V6 — template placeholder fails closed

Mutation: replaced the placeholder with the valid declaration `Coded-by: Grok`.

```text
not ok 1 - V6 edited PR template keeps its Grok-inclusive placeholder fail-closed
# tests 1
# pass 0
# fail 1
```

Restored:

```text
# tests 1
# pass 1
# fail 0
```
