# Candidate / pick assertion ledger

Contract rev 3.2. Every changed pre-existing assertion below is mapped to W-b/W-e (typed pick response and HTTP 200) or V3 (pre-rebuild finding pick is read-only). V8/W-d cover current projection and scoped fixture loads. Newly added tests retain their explicit contract names.

## mcp/tests/diagnosisLinkL2.test.ts:261 → 264 — W-b / W-e

Before:
```ts
  assert.equal(mildOd.status, 201, JSON.stringify(mildOd.body));
  assert.equal(moderateOs.status, 201, JSON.stringify(moderateOs.body));
```
After:
```ts
  assert.equal(mildOd.status, 200, JSON.stringify(mildOd.body));
  assert.equal(moderateOs.status, 200, JSON.stringify(moderateOs.body));
```

## mcp/tests/diagnosisLinkL2.test.ts:289 → 292 — W-b / W-e

Before:
```ts
  assert.equal(result.status, 201, JSON.stringify(result.body));
```
After:
```ts
  assert.equal(result.status, 200, JSON.stringify(result.body));
```

## mcp/tests/diagnosisLinkL2.test.ts:316 → 319 — W-b / W-e

Before:
```ts
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
```
After:
```ts
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
```

## mcp/tests/diagnosisLinkL2.test.ts:347 → 351 — W-b / W-e

Before:
```ts
  assert.equal(deferred.status, 201, JSON.stringify(deferred.body));
```
After:
```ts
  assert.equal(deferred.status, 200, JSON.stringify(deferred.body));
```

## mcp/tests/diagnosisLinkL2.test.ts:377 → 381 — W-b / W-e

Before:
```ts
  assert.equal(deferred.status, 201, JSON.stringify(deferred.body));
```
After:
```ts
  assert.equal(deferred.status, 200, JSON.stringify(deferred.body));
```

## mcp/tests/diagnosisLinkL2.test.ts:401 → 405 — W-b / W-e

Before:
```ts
      assert.equal(result.status, 201, `${diagnosisKey} ${laterality}: ${JSON.stringify(result.body)}`);
```
After:
```ts
      assert.equal(result.status, 200, `${diagnosisKey} ${laterality}: ${JSON.stringify(result.body)}`);
```

## mcp/tests/diagnosisLinkL2.test.ts:417 → 421 — W-b / W-e

Before:
```ts
    assert.equal(bilateral.status, 201, `${diagnosisKey} OU: ${JSON.stringify(bilateral.body)}`);
```
After:
```ts
    assert.equal(bilateral.status, 200, `${diagnosisKey} OU: ${JSON.stringify(bilateral.body)}`);
```

## mcp/tests/diagnosisLinkL2.test.ts:750 → 756 — V3 / W-e

Before:
```ts
  assert.equal(confirmedCornea.status, 201, JSON.stringify(confirmedCornea.body));
  assert.equal((confirmedCornea.body as { condition: Condition }).condition.code?.coding?.[0]?.code, "H18.611");
```
After:
```ts
  assert.equal(confirmedCornea.status, 409, JSON.stringify(confirmedCornea.body));
  assert.equal((confirmedCornea.body as any).reason, "pre-rebuild-test-encounter");
```

## mcp/tests/diagnosisLinkL2.test.ts:800 → 806 — V3 / W-e

Before:
```ts
    assert.equal(result.status, 201, JSON.stringify(result.body));
```
After:
```ts
    assert.equal(result.status, 409, JSON.stringify(result.body));
```

## mcp/tests/diagnosisLinkL2.test.ts:806 → 812 — V3 / W-e

Before:
```ts
  assert.deepEqual(blepharitisCodes, ["H01.01A", "H01.01B"]);
```
After:
```ts
  assert.deepEqual(blepharitisCodes, []);
```

## mcp/tests/diagnosisLinkL2.test.ts:1474 → 1482 — W-b / W-e

Before:
```ts
  assert.equal(explicit.status, 201);
```
After:
```ts
  assert.equal(explicit.status, 200);
```

## mcp/tests/diagnosisLinkL2.test.ts:1574 → 1582 — W-b / W-e

Before:
```ts
    assert.equal(pick.status, 201, JSON.stringify(pick.body));
```
After:
```ts
    assert.equal(pick.status, 200, JSON.stringify(pick.body));
```

## mcp/tests/diagnosisLinkL2.test.ts:1699 → 1707 — W-b / W-e

Before:
```ts
  assert.equal(override.status, 201, JSON.stringify(override.body));
```
After:
```ts
  assert.equal(override.status, 200, JSON.stringify(override.body));
```

## mcp/tests/diagnosisLinkL2.test.ts:1858 → 1866 — V3 / W-e

Before:
```ts
  assert.equal(picked.status, 201, JSON.stringify(picked.body));
  assert.equal((picked.body as { condition: Condition }).condition.code?.coding?.[0]?.code,
    sourcedDiagnosisCode("dry_amd_early", "right"));
```
After:
```ts
  assert.equal(picked.status, 409, JSON.stringify(picked.body));
  assert.equal((picked.body as any).reason, "pre-rebuild-test-encounter");
  assert.equal(fhir.resources.some(r => r.resourceType === "Condition"), false);
```

## mcp/tests/diagnosisLinkL2.test.ts:1877 → 1885 — W-b / W-e

Before:
```ts
  assert.equal(od.status, 201);
```
After:
```ts
  assert.equal(od.status, 200);
```

## mcp/tests/diagnosisLinkL2.test.ts:1929 → 1937 — W-b / W-e

Before:
```ts
  assert.equal((await pick("possible")).status, 201);
```
After:
```ts
  assert.equal((await pick("possible")).status, 200);
```

## mcp/tests/diagnosisLinkL2.test.ts:1962 → 1970 — W-b / W-e

Before:
```ts
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
```
After:
```ts
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
```

## mcp/tests/diagnosisLinkL2.test.ts:1990 → 1998 — W-b / W-e

Before:
```ts
  assert.equal((await pick("possible")).status, 201);
```
After:
```ts
  assert.equal((await pick("possible")).status, 200);
```

## mcp/tests/diagnosisLinkL2.test.ts:2039 → 2047 — W-b / W-e

Before:
```ts
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
```
After:
```ts
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
```

## mcp/tests/diagnosisLinkL2.test.ts:2077 → 2085 — W-b / W-e

Before:
```ts
  assert.equal(possibleOd.status, 201);
```
After:
```ts
  assert.equal(possibleOd.status, 200);
```

## mcp/tests/diagnosisLinkL2.test.ts:2093 → 2101 — W-b / W-e

Before:
```ts
  assert.equal(confirmOs.status, 201);
```
After:
```ts
  assert.equal(confirmOs.status, 200);
```

## mcp/tests/diagnosisLinkL2.test.ts:2159 → 2167 — W-b / W-e

Before:
```ts
  assert.equal(first.status, 201);
```
After:
```ts
  assert.equal(first.status, 200);
```

## mcp/tests/diagnosisLinkL2.test.ts:2192 → 2200 — W-b / W-e

Before:
```ts
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(discarded.status, 201, JSON.stringify(discarded.body));
  assert.equal(third.status, 201, JSON.stringify(third.body));
```
After:
```ts
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
  assert.equal(third.status, 200, JSON.stringify(third.body));
```

## mcp/tests/diagnosisLinkL2.test.ts:2372 → 2380 — W-b / W-e

Before:
```ts
  assert.equal(result.status, 201, JSON.stringify(result.body));
```
After:
```ts
  assert.equal(result.status, 200, JSON.stringify(result.body));
```

## mcp/tests/diagnosisLinkL2.test.ts:2416 → 2424 — W-b / W-e

Before:
```ts
    assert.equal(result.status, 201);
```
After:
```ts
    assert.equal(result.status, 200);
```

## mcp/tests/diagnosisVisitStatus.test.ts:167 → 167 — W-b / W-e

Before:
```ts
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
```
After:
```ts
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
```

## mcp/tests/diagnosisVisitStatus.test.ts:242 → 242 — W-b / W-e

Before:
```ts
  assert.equal(later.status, 201, JSON.stringify(later.body));
```
After:
```ts
  assert.equal(later.status, 200, JSON.stringify(later.body));
```

## Fixture-only adjustments

- L2 MemoryFhir now supplies baseUrl; scoped candidate fixtures seed their Encounter explicitly (V8/W-d).
- L3 catalog resources now have ids, matching real persisted Basic resources; strict store page validation rejects missing ids (V8 / §3.9).
- L2 appended tests cover W10/W29/W30/W35, trigger support union, mixed option/numeric context, whole-support prevalidation, bilateral support union, conditionStep failures, no-real-id picks, and page-two diagnosis lookup.
