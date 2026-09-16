# Findings assertion migration ledger

Baseline: `15722129`. Exact original assertion text and replacement assertions are listed below. Untouched assertions are omitted. Legacy mutation scenarios now prove read-only refusal (V3); canonical replacement coverage lives in `diagnosisFindingsCommands.test.ts` (W-a/W-b/W-c), including independent eyes, carry replay, grade, home changes and pagination-reader integration. No captured baseline or divergence records changed.

## mcp/tests/diagnosisFindings.test.ts

### 1. mcp/tests/diagnosisFindings.test.ts:51 — V3

Before:

```ts
assert.equal(create.mock.callCount(), 0, "no Observation or Provenance may be created before refusal")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:43`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:44`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:45`: `assert.deepEqual(fhir.resources, before)`

### 2. mcp/tests/diagnosisFindings.test.ts:52 — V3

Before:

```ts
assert.equal(update.mock.callCount(), 0, "no existing resource may change before refusal")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:43`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:44`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:45`: `assert.deepEqual(fhir.resources, before)`

### 3. mcp/tests/diagnosisFindings.test.ts:77 — V3

Before:

```ts
assert.equal(response.status, observationOnly ? 200 : 403, JSON.stringify(response.body))
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:56`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:57`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:58`: `assert.deepEqual(fhir.resources, before)`

### 4. mcp/tests/diagnosisFindings.test.ts:78 — V3

Before:

```ts
assert.deepEqual(fhir.resources.filter((row) => row.resourceType === "Condition"), beforeConditions)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:56`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:57`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:58`: `assert.deepEqual(fhir.resources, before)`

### 5. mcp/tests/diagnosisFindings.test.ts:80 — V3

Before:

```ts
assert.equal(create.mock.callCount(), 0)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:56`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:57`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:58`: `assert.deepEqual(fhir.resources, before)`

### 6. mcp/tests/diagnosisFindings.test.ts:81 — V3

Before:

```ts
assert.equal(update.mock.callCount(), 0)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:56`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:57`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:58`: `assert.deepEqual(fhir.resources, before)`

### 7. mcp/tests/diagnosisFindings.test.ts:83 — V3

Before:

```ts
assert.equal(update.mock.calls.some((call) => call.arguments[0] === "Observation"), true)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:56`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:57`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:58`: `assert.deepEqual(fhir.resources, before)`

### 8. mcp/tests/diagnosisFindings.test.ts:135 — W-c / V4

Before:

```ts
assert.equal(response.status, 403)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:107`: `assert.equal(response.status, 403)`

### 9. mcp/tests/diagnosisFindings.test.ts:222 — W-c / V4

Before:

```ts
assert.deepEqual(
    body.findings.map((row) => ({
      id: row.atomicFindingId,
      presence: row.presence,
      grade: row.grade,
      condition: row.conditionReference,
      source: row.source,
    })),
    [
      {
        id: atomicId("unique-section"),
        presence: "present",
        grade: "2+",
        condition: "Condition/unique",
        source: "section",
      },
      {
        id: atomicId("offered-only"),
        presence: undefined,
        grade: undefined,
        condition: undefined,
        source: "offered",
      },
    ],
  )
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:118`: `assert.equal(response.status, 200, JSON.stringify(response.body))`
- `mcp/tests/diagnosisFindings.test.ts:143`: `assert.deepEqual(body.diagnosis.applicableFindingDefinitionIds, [LENS_DEFINITION.id])`
- `mcp/tests/diagnosisFindings.test.ts:144`: `assert.deepEqual(body.catalog, [     {       atomicFindingId: atomicId("ambiguous-section"),       findingDefinitionId: LENS_DEFINITION.id,       findingDefinitionKey: LENS_DEFINITION.stableKey,       fieldCode: LENS_FIELD,       optionCode: "ambiguous-section",       display: "Ambiguous section finding",       sectionKey: LENS_DEFINITION.sectionKey,       gradeScale: [],       diagnosisKeys: ["dx_second", "dx_unique"],       origin: "shipped",     },     {       atomicFindingId: atomicId("offered-only"),       findingDefinitionId: LENS_DEFINITION.id,       findingDefinitionKey: LENS_DEFINITION.stableKey,       fieldCode: LENS_FIELD,       optionCode: "offered-only",       display: "Offered only finding",       sectionKey: LENS_DEFINITION.sectionKey,       gradeScale: [],       diagnosisKeys: ["dx_unique"],       origin: "shipped",     },     {       atomicFindingId: atomicId("unique-section"),       findingDefinitionId: LENS_DEFINITION.id,       findingDefinitionKey: LENS_DEFINITION.stableKey,       fieldCode: LENS_FIELD,       optionCode: "unique-section",       display: "Unique section finding",       sectionKey: LENS_DEFINITION.sectionKey,       gradeScale: ["1+", "2+"],       diagnosisKeys: ["dx_unique"],       origin: "shipped",     },     {       atomicFindingId: atomicId("unmatched-section"),       findingDefinitionId: LENS_DEFINITION.id,       findingDefinitionKey: LENS_DEFINITION.stableKey,       fieldCode: LENS_FIELD,       optionCode: "unmatched-section",       display: "Unmatched section finding",       sectionKey: LENS_DEFINITION.sectionKey,       gradeScale: [],       diagnosisKeys: ["dx_missing"],       origin: "shipped",     },   ])`
- `mcp/tests/diagnosisFindings.test.ts:194`: `assert.deepEqual(     body.findings.map((row) => ({       id: row.atomicFindingId,       presence: row.presence,       grade: row.grade,       condition: row.conditionReference,       kind: row.kind,     })),     [       { id: atomicId("ambiguous-section"), presence: "present", grade: undefined, condition: undefined, kind: "fact" },       {         id: atomicId("unique-section"),         presence: "present",         grade: "2+",         condition: "Condition/unique",         kind: "fact",       },       {         id: atomicId("offered-only"),         presence: undefined,         grade: undefined,         condition: undefined,         kind: "offered",       },     ],   )`
- `mcp/tests/diagnosisFindings.test.ts:220`: `assert.deepEqual(     body.unassigned.map((row) => [row.atomicFindingId, row.kind]),     [       [atomicId("unmatched-section"), "fact"],     ],   )`
- `mcp/tests/diagnosisFindings.test.ts:226`: `assert.deepEqual(     body.bySection[LENS_DEFINITION.sectionKey!]?.map((row) => row.atomicFindingId),     [       atomicId("ambiguous-section"),       atomicId("unique-section"),       atomicId("unmatched-section"),     ],   )`

### 10. mcp/tests/diagnosisFindings.test.ts:247 — W-c / V4

Before:

```ts
assert.deepEqual(
    body.unassigned.map((row) => [row.atomicFindingId, row.source]),
    [
      [atomicId("ambiguous-section"), "section"],
      [atomicId("unmatched-section"), "section"],
    ],
  )
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:118`: `assert.equal(response.status, 200, JSON.stringify(response.body))`
- `mcp/tests/diagnosisFindings.test.ts:143`: `assert.deepEqual(body.diagnosis.applicableFindingDefinitionIds, [LENS_DEFINITION.id])`
- `mcp/tests/diagnosisFindings.test.ts:144`: `assert.deepEqual(body.catalog, [     {       atomicFindingId: atomicId("ambiguous-section"),       findingDefinitionId: LENS_DEFINITION.id,       findingDefinitionKey: LENS_DEFINITION.stableKey,       fieldCode: LENS_FIELD,       optionCode: "ambiguous-section",       display: "Ambiguous section finding",       sectionKey: LENS_DEFINITION.sectionKey,       gradeScale: [],       diagnosisKeys: ["dx_second", "dx_unique"],       origin: "shipped",     },     {       atomicFindingId: atomicId("offered-only"),       findingDefinitionId: LENS_DEFINITION.id,       findingDefinitionKey: LENS_DEFINITION.stableKey,       fieldCode: LENS_FIELD,       optionCode: "offered-only",       display: "Offered only finding",       sectionKey: LENS_DEFINITION.sectionKey,       gradeScale: [],       diagnosisKeys: ["dx_unique"],       origin: "shipped",     },     {       atomicFindingId: atomicId("unique-section"),       findingDefinitionId: LENS_DEFINITION.id,       findingDefinitionKey: LENS_DEFINITION.stableKey,       fieldCode: LENS_FIELD,       optionCode: "unique-section",       display: "Unique section finding",       sectionKey: LENS_DEFINITION.sectionKey,       gradeScale: ["1+", "2+"],       diagnosisKeys: ["dx_unique"],       origin: "shipped",     },     {       atomicFindingId: atomicId("unmatched-section"),       findingDefinitionId: LENS_DEFINITION.id,       findingDefinitionKey: LENS_DEFINITION.stableKey,       fieldCode: LENS_FIELD,       optionCode: "unmatched-section",       display: "Unmatched section finding",       sectionKey: LENS_DEFINITION.sectionKey,       gradeScale: [],       diagnosisKeys: ["dx_missing"],       origin: "shipped",     },   ])`
- `mcp/tests/diagnosisFindings.test.ts:194`: `assert.deepEqual(     body.findings.map((row) => ({       id: row.atomicFindingId,       presence: row.presence,       grade: row.grade,       condition: row.conditionReference,       kind: row.kind,     })),     [       { id: atomicId("ambiguous-section"), presence: "present", grade: undefined, condition: undefined, kind: "fact" },       {         id: atomicId("unique-section"),         presence: "present",         grade: "2+",         condition: "Condition/unique",         kind: "fact",       },       {         id: atomicId("offered-only"),         presence: undefined,         grade: undefined,         condition: undefined,         kind: "offered",       },     ],   )`
- `mcp/tests/diagnosisFindings.test.ts:220`: `assert.deepEqual(     body.unassigned.map((row) => [row.atomicFindingId, row.kind]),     [       [atomicId("unmatched-section"), "fact"],     ],   )`
- `mcp/tests/diagnosisFindings.test.ts:226`: `assert.deepEqual(     body.bySection[LENS_DEFINITION.sectionKey!]?.map((row) => row.atomicFindingId),     [       atomicId("ambiguous-section"),       atomicId("unique-section"),       atomicId("unmatched-section"),     ],   )`

### 11. mcp/tests/diagnosisFindings.test.ts:315 — W-c / V4

Before:

```ts
assert.deepEqual(body.findings.filter((row) =>
    row.atomicFindingId === atomicId("unique-section") ||
    row.atomicFindingId === atomicId("offered-only")
  ).map((row) => ({
    id: row.atomicFindingId,
    source: row.source,
    presence: row.presence,
    carried: row.carried,
    priorPresence: row.priorPresence,
    priorGrade: row.priorGrade,
    priorLaterality: row.priorLaterality,
    observationReference: row.observationReference,
  })), [
    {
      id: atomicId("unique-section"),
      source: "atomic",
      presence: "present",
      carried: true,
      priorPresence: undefined,
      priorGrade: undefined,
      priorLaterality: undefined,
      observationReference: "Observation/current-unique-present",
    },
    {
      id: atomicId("offered-only"),
      source: "offered",
      presence: undefined,
      carried: undefined,
      priorPresence: "absent",
      priorGrade: "historical-grade",
      priorLaterality: "OD",
      observationReference: undefined,
    },
  ])
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:263`: `assert.equal(response.status, 200, JSON.stringify(response.body))`
- `mcp/tests/diagnosisFindings.test.ts:282`: `assert.deepEqual(body.carryProvenance, {     pulledFromDate: "2026-07-10T09:00:00.000Z",     unchangedSinceDate: "2026-07-10T09:00:00.000Z",     edited: false,   })`
- `mcp/tests/diagnosisFindings.test.ts:287`: `assert.deepEqual(body.findings.filter((row) =>     row.atomicFindingId === atomicId("unique-section") ||     row.atomicFindingId === atomicId("offered-only")   ).map((row) => ({     id: row.atomicFindingId,     kind: row.kind,     presence: row.presence,     carried: row.carried,     priorPresence: row.priorPresence,     priorGrade: row.priorGrade,     priorLaterality: row.priorLaterality,     observationReference: row.observationReference,   })), [     {       id: atomicId("unique-section"),       kind: "fact",       presence: "present",       carried: true,       priorPresence: undefined,       priorGrade: undefined,       priorLaterality: undefined,       observationReference: undefined,     },     {       id: atomicId("offered-only"),       kind: "offered",       presence: undefined,       carried: undefined,       priorPresence: "absent",       priorGrade: "historical-grade",       priorLaterality: "OD",       observationReference: undefined,     },   ])`
- `mcp/tests/diagnosisFindings.test.ts:321`: `assert.deepEqual(body.bySection[LENS_DEFINITION.sectionKey!]?.map((row) => row.atomicFindingId), [     atomicId("unique-section"),   ])`

### 12. mcp/tests/diagnosisFindings.test.ts:385 — W-c / V4

Before:

```ts
assert.deepEqual(rows.map((row) => ({
    atomicFindingId: atomicId("offered-only"),
    source: row.source,
    presence: row.presence,
    priorPresence: row.priorPresence,
    conditionReference: row.conditionReference,
    observationReference: row.observationReference,
  })), [{
    atomicFindingId: atomicId("offered-only"),
    source: "offered",
    presence: undefined,
    priorPresence: "absent",
    conditionReference: undefined,
    observationReference: undefined,
  }])
```

After (canonical replacement suite):

See `mcp/tests/diagnosisFindingsCommands.test.ts` canonical operation acceptance/rejection and replay assertions; source scenario migrated by the wire contract.

### 13. mcp/tests/diagnosisFindings.test.ts:411 — V3

Before:

```ts
assert.equal(asserted.status, 200, JSON.stringify(asserted.body))
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:369`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:370`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:371`: `assert.deepEqual(fhir.resources, before)`

### 14. mcp/tests/diagnosisFindings.test.ts:430 — V3

Before:

```ts
assert.equal(rows.carryProvenance?.pulledFromDate, "2026-07-10T09:00:00.000Z")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:369`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:370`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:371`: `assert.deepEqual(fhir.resources, before)`

### 15. mcp/tests/diagnosisFindings.test.ts:432 — V3

Before:

```ts
assert.equal(reassertedRows.length, 1)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:369`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:370`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:371`: `assert.deepEqual(fhir.resources, before)`

### 16. mcp/tests/diagnosisFindings.test.ts:433 — V3

Before:

```ts
assert.equal(reassertedRows[0]?.source, "atomic")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:369`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:370`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:371`: `assert.deepEqual(fhir.resources, before)`

### 17. mcp/tests/diagnosisFindings.test.ts:434 — V3

Before:

```ts
assert.equal(reassertedRows[0]?.presence, "absent")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:369`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:370`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:371`: `assert.deepEqual(fhir.resources, before)`

### 18. mcp/tests/diagnosisFindings.test.ts:435 — V3

Before:

```ts
assert.equal(reassertedRows[0]?.carried, undefined)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:369`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:370`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:371`: `assert.deepEqual(fhir.resources, before)`

### 19. mcp/tests/diagnosisFindings.test.ts:436 — V3

Before:

```ts
assert.equal(reassertedRows[0]?.priorPresence, undefined)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:369`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:370`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:371`: `assert.deepEqual(fhir.resources, before)`

### 20. mcp/tests/diagnosisFindings.test.ts:437 — V3

Before:

```ts
assert.match(reassertedRows[0]?.observationReference ?? "", /^Observation\//)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:369`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:370`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:371`: `assert.deepEqual(fhir.resources, before)`

### 21. mcp/tests/diagnosisFindings.test.ts:440 — V3

Before:

```ts
assert.equal(reassertions.length, 1)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:369`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:370`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:371`: `assert.deepEqual(fhir.resources, before)`

### 22. mcp/tests/diagnosisFindings.test.ts:441 — V3

Before:

```ts
assert.equal(reassertions[0]?.target.some((target) => target.reference === observationReference), true)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:369`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:370`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:371`: `assert.deepEqual(fhir.resources, before)`

### 23. mcp/tests/diagnosisFindings.test.ts:450 — V3

Before:

```ts
assert.equal(carryState.observationReasserted[observationReference], true)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:369`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:370`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:371`: `assert.deepEqual(fhir.resources, before)`

### 24. mcp/tests/diagnosisFindings.test.ts:463 — V3

Before:

```ts
assert.equal(before.observationCarried["Observation/current-unique-present"], true)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:382`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:383`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:384`: `assert.deepEqual(fhir.resources, before)`

### 25. mcp/tests/diagnosisFindings.test.ts:464 — V3

Before:

```ts
assert.equal(before.observationReasserted["Observation/current-unique-present"], undefined)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:382`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:383`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:384`: `assert.deepEqual(fhir.resources, before)`

### 26. mcp/tests/diagnosisFindings.test.ts:473 — V3

Before:

```ts
assert.equal(asserted.status, 200, JSON.stringify(asserted.body))
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:382`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:383`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:384`: `assert.deepEqual(fhir.resources, before)`

### 27. mcp/tests/diagnosisFindings.test.ts:478 — V3

Before:

```ts
assert.equal(after.observationCarried["Observation/current-unique-present"], false)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:382`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:383`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:384`: `assert.deepEqual(fhir.resources, before)`

### 28. mcp/tests/diagnosisFindings.test.ts:479 — V3

Before:

```ts
assert.equal(after.observationReasserted["Observation/current-unique-present"], true)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:382`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:383`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:384`: `assert.deepEqual(fhir.resources, before)`

### 29. mcp/tests/diagnosisFindings.test.ts:522 — V3

Before:

```ts
assert.equal(failed.status, 502)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:421`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:422`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:423`: `assert.deepEqual(fhir.resources, before)`

### 30. mcp/tests/diagnosisFindings.test.ts:523 — V3

Before:

```ts
assert.equal(retried.status, 200, JSON.stringify(retried.body))
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:421`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:422`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:423`: `assert.deepEqual(fhir.resources, before)`

### 31. mcp/tests/diagnosisFindings.test.ts:524 — V3

Before:

```ts
assert.equal(findingReassertionProvenances(fhir).length, 1)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:421`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:422`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:423`: `assert.deepEqual(fhir.resources, before)`

### 32. mcp/tests/diagnosisFindings.test.ts:542 — V3

Before:

```ts
assert.equal(first.status, 200, JSON.stringify(first.body))
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 33. mcp/tests/diagnosisFindings.test.ts:543 — V3

Before:

```ts
assert.equal(atomicObservations(fhir)[0]?.valueBoolean, false)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 34. mcp/tests/diagnosisFindings.test.ts:546 — V3

Before:

```ts
assert.equal(second.status, 200, JSON.stringify(second.body))
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 35. mcp/tests/diagnosisFindings.test.ts:548 — V3

Before:

```ts
assert.equal(observations.length, 1)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 36. mcp/tests/diagnosisFindings.test.ts:549 — V3

Before:

```ts
assert.equal(observations[0]?.status, "preliminary")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 37. mcp/tests/diagnosisFindings.test.ts:550 — V3

Before:

```ts
assert.equal(observations[0]?.valueBoolean, false)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 38. mcp/tests/diagnosisFindings.test.ts:551 — V3

Before:

```ts
assert.equal(observations[0]?.component?.some((row) => row.code.coding?.some((coding) => coding.code === "GRADE")), false)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 39. mcp/tests/diagnosisFindings.test.ts:552 — V3

Before:

```ts
assert.equal(observations[0]?.focus, undefined)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 40. mcp/tests/diagnosisFindings.test.ts:553 — V3

Before:

```ts
assert.equal(observationLateralityCode(observations[0]!), "OD")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 41. mcp/tests/diagnosisFindings.test.ts:554 — V3

Before:

```ts
assert.equal(componentString(observations[0]!, "LATERALITY_SOURCE"), "inherited")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 42. mcp/tests/diagnosisFindings.test.ts:556 — V3

Before:

```ts
assert.deepEqual(conditionEvidence(fhir, "unique"), [reference])
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 43. mcp/tests/diagnosisFindings.test.ts:557 — V3

Before:

```ts
assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Provenance").length, 2)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 44. mcp/tests/diagnosisFindings.test.ts:558 — V3

Before:

```ts
assert.equal(findingReassertionProvenances(fhir).length, 0)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 45. mcp/tests/diagnosisFindings.test.ts:565 — V3

Before:

```ts
assert.equal(reloaded.status, 200, JSON.stringify(reloaded.body))
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 46. mcp/tests/diagnosisFindings.test.ts:572 — V3

Before:

```ts
assert.equal(finding?.presence, "absent")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 47. mcp/tests/diagnosisFindings.test.ts:573 — V3

Before:

```ts
assert.deepEqual(
    reloadedBody.bySection[LENS_DEFINITION.sectionKey!]?.filter((row) =>
      row.atomicFindingId === atomicId("offered-only")
    ).map((row) => ({
      atomicFindingId: row.atomicFindingId,
      presence: row.presence,
      source: row.source,
    })),
    [{ atomicFindingId: atomicId("offered-only"), presence: "absent", source: "atomic" }],
  )
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:434`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:435`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:436`: `assert.deepEqual(fhir.resources, before)`

### 48. mcp/tests/diagnosisFindings.test.ts:599 — V3

Before:

```ts
assert.equal(response.status, 200, JSON.stringify(response.body))
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:447`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:448`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:449`: `assert.deepEqual(fhir.resources, before)`

### 49. mcp/tests/diagnosisFindings.test.ts:600 — V3

Before:

```ts
assert.deepEqual(response.body, { observationReference: "Observation/existing-page-two" })
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:447`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:448`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:449`: `assert.deepEqual(fhir.resources, before)`

### 50. mcp/tests/diagnosisFindings.test.ts:601 — V3

Before:

```ts
assert.equal(atomicObservations(fhir).length, 1)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:447`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:448`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:449`: `assert.deepEqual(fhir.resources, before)`

### 51. mcp/tests/diagnosisFindings.test.ts:602 — V3

Before:

```ts
assert.equal(atomicObservations(fhir)[0]?.valueBoolean, false)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:447`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:448`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:449`: `assert.deepEqual(fhir.resources, before)`

### 52. mcp/tests/diagnosisFindings.test.ts:603 — V3

Before:

```ts
assert.deepEqual(fhir.followedUrls, ["/fhir/R4/Observation?_page=2"])
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:447`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:448`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:449`: `assert.deepEqual(fhir.resources, before)`

### 53. mcp/tests/diagnosisFindings.test.ts:632 — W-b

Before:

```ts
assert.deepEqual(response.body, { error: "FHIR diagnosis findings dependency failed." }, scenario)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:477`: `assert.equal(response.status, 502, scenario)`
- `mcp/tests/diagnosisFindings.test.ts:478`: `assert.deepEqual(response.body, { result: "unavailable", kind: "upstream", error: "Encounter search failed." }, scenario)`

### 54. mcp/tests/diagnosisFindings.test.ts:648 — W-b

Before:

```ts
assert.deepEqual(response.body, {
      error: status === 500
        ? "FHIR diagnosis findings dependency failed."
        : "Diagnosis findings are outside the caller's patient compartment.",
    }, String(status))
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:493`: `assert.equal(response.status, status === 500 ? 502 : 403, String(status))`
- `mcp/tests/diagnosisFindings.test.ts:494`: `assert.deepEqual(response.body, {       result: "unavailable", kind: status === 500 ? "upstream" : "refused", error: "Encounter findings could not be loaded.",     }, String(status))`

### 55. mcp/tests/diagnosisFindings.test.ts:667 — W-b

Before:

```ts
assert.deepEqual(await response.json(), {
      error: status === 500
        ? "FHIR diagnosis findings dependency failed."
        : "Diagnosis findings are outside the caller's patient compartment.",
    })
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:510`: `assert.equal(response.status, status === 500 ? 502 : 403)`
- `mcp/tests/diagnosisFindings.test.ts:511`: `assert.deepEqual(await response.json(), {       result: "unavailable", kind: status === 500 ? "upstream" : "refused", error: "Encounter findings could not be loaded.",     })`

### 56. mcp/tests/diagnosisFindings.test.ts:698 — W-b

Before:

```ts
assert.deepEqual(response.body, { error: "Diagnosis findings resources were not found." })
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:539`: `assert.equal(response.status, 404, \`${dependency} ${status}: ${JSON.stringify(response.body)}\`)`
- `mcp/tests/diagnosisFindings.test.ts:540`: `assert.deepEqual(response.body, { result: "unavailable", kind: "missing", error: dependency === "Encounter" ? "Encounter findings could not be loaded." : "Encounter search resource is missing." })`

### 57. mcp/tests/diagnosisFindings.test.ts:715 — W-c / V4

Before:

```ts
assert.equal(response.status, 200, JSON.stringify(response.body))
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:557`: `assert.equal(response.status, 200, JSON.stringify(response.body))`
- `mcp/tests/diagnosisFindings.test.ts:560`: `assert.equal(visit?.laterality, "OS")`

### 58. mcp/tests/diagnosisFindings.test.ts:748 — W-b

Before:

```ts
assert.deepEqual(await cyclicResponse.json(), { error: "FHIR diagnosis findings dependency failed." })
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:573`: `assert.equal(missingResponse.status, 200)`
- `mcp/tests/diagnosisFindings.test.ts:577`: `assert.equal(missingBody.carryProvenance?.edited, true)`
- `mcp/tests/diagnosisFindings.test.ts:578`: `assert.match(missingBody.carryProvenance?.integrityWarning ?? "", /missing|gone|unavailable/i)`
- `mcp/tests/diagnosisFindings.test.ts:589`: `assert.equal(cyclicResponse.status, 502)`
- `mcp/tests/diagnosisFindings.test.ts:590`: `assert.deepEqual(await cyclicResponse.json(), { result: "unavailable", kind: "upstream", error: "Encounter search failed." })`

### 59. mcp/tests/diagnosisFindings.test.ts:786 — V3

Before:

```ts
assert.equal((await mutate(fhir, { ...base, presence: "present" })).status, 200)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:627`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:628`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:629`: `assert.deepEqual(fhir.resources, before)`

### 60. mcp/tests/diagnosisFindings.test.ts:787 — V3

Before:

```ts
assert.equal((await mutate(fhir, { ...base, presence: "absent", laterality: "OS" })).status, 200)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:627`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:628`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:629`: `assert.deepEqual(fhir.resources, before)`

### 61. mcp/tests/diagnosisFindings.test.ts:792 — V3

Before:

```ts
assert.deepEqual(observations.map((observation) => ({
    laterality: observationLateralityCode(observation),
    presence: observation.valueBoolean,
  })), [
    { laterality: "OD", presence: true },
    { laterality: "OS", presence: false },
  ])
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:627`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:628`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:629`: `assert.deepEqual(fhir.resources, before)`

### 62. mcp/tests/diagnosisFindings.test.ts:799 — V3

Before:

```ts
assert.deepEqual(conditionEvidence(fhir, "unique").sort(), observations
    .map((observation) => `Observation/${observation.id}`).sort())
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:627`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:628`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:629`: `assert.deepEqual(fhir.resources, before)`

### 63. mcp/tests/diagnosisFindings.test.ts:812 — V3

Before:

```ts
assert.equal(asserted.status, 200, JSON.stringify(asserted.body))
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 64. mcp/tests/diagnosisFindings.test.ts:821 — V3

Before:

```ts
assert.equal(invalidGrade.status, 400)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 65. mcp/tests/diagnosisFindings.test.ts:822 — V3

Before:

```ts
assert.equal(componentString(atomicObservations(fhir)[0]!, "GRADE"), undefined)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 66. mcp/tests/diagnosisFindings.test.ts:824 — V3

Before:

```ts
assert.equal((await mutate(fhir, {
    action: "grade",
    patientReference: "Patient/p1",
    observationReference,
    grade: "2+",
  })).status, 200)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 67. mcp/tests/diagnosisFindings.test.ts:830 — V3

Before:

```ts
assert.equal(componentString(atomicObservations(fhir)[0]!, "GRADE"), "2+")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 68. mcp/tests/diagnosisFindings.test.ts:831 — V3

Before:

```ts
assert.equal((await mutate(fhir, {
    action: "grade",
    patientReference: "Patient/p1",
    observationReference,
    grade: null,
  })).status, 200)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 69. mcp/tests/diagnosisFindings.test.ts:837 — V3

Before:

```ts
assert.equal(componentString(atomicObservations(fhir)[0]!, "GRADE"), undefined)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 70. mcp/tests/diagnosisFindings.test.ts:839 — V3

Before:

```ts
assert.equal((await mutate(fhir, {
    action: "laterality",
    patientReference: "Patient/p1",
    observationReference,
    laterality: "OS",
  })).status, 200)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 71. mcp/tests/diagnosisFindings.test.ts:845 — V3

Before:

```ts
assert.equal(observationLateralityCode(atomicObservations(fhir)[0]!), "OS")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 72. mcp/tests/diagnosisFindings.test.ts:846 — V3

Before:

```ts
assert.equal(componentString(atomicObservations(fhir)[0]!, "LATERALITY_SOURCE"), "explicit")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 73. mcp/tests/diagnosisFindings.test.ts:847 — V3

Before:

```ts
assert.equal((await mutate(fhir, {
    action: "laterality",
    patientReference: "Patient/p1",
    observationReference,
    laterality: null,
  })).status, 200)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 74. mcp/tests/diagnosisFindings.test.ts:853 — V3

Before:

```ts
assert.equal(observationLateralityCode(atomicObservations(fhir)[0]!), "OD")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 75. mcp/tests/diagnosisFindings.test.ts:854 — V3

Before:

```ts
assert.equal(componentString(atomicObservations(fhir)[0]!, "LATERALITY_SOURCE"), "inherited")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:640`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:641`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:642`: `assert.deepEqual(fhir.resources, before)`

### 76. mcp/tests/diagnosisFindings.test.ts:871 — V3

Before:

```ts
assert.equal(wrongPatient.status, 400)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:653`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:654`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:655`: `assert.deepEqual(fhir.resources, before)`

### 77. mcp/tests/diagnosisFindings.test.ts:879 — V3

Before:

```ts
assert.equal(wrongCondition.status, 400)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:653`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:654`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:655`: `assert.deepEqual(fhir.resources, before)`

### 78. mcp/tests/diagnosisFindings.test.ts:894 — V3

Before:

```ts
assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:653`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:654`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:655`: `assert.deepEqual(fhir.resources, before)`

### 79. mcp/tests/diagnosisFindings.test.ts:895 — V3

Before:

```ts
assert.equal(atomicObservations(fhir)[0]?.status, "entered-in-error")
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:653`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:654`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:655`: `assert.deepEqual(fhir.resources, before)`

### 80. mcp/tests/diagnosisFindings.test.ts:896 — V3

Before:

```ts
assert.deepEqual(conditionEvidence(fhir, "unique"), [])
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:653`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:654`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:655`: `assert.deepEqual(fhir.resources, before)`

### 81. mcp/tests/diagnosisFindings.test.ts:910 — V3

Before:

```ts
assert.equal((await mutate(fhir, {
    action: "assign",
    patientReference: "Patient/p1",
    observationReference,
    conditionReference: "Condition/second",
  })).status, 200)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:666`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:667`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:668`: `assert.deepEqual(fhir.resources, before)`

### 82. mcp/tests/diagnosisFindings.test.ts:916 — V3

Before:

```ts
assert.equal((await mutate(fhir, {
    action: "assign",
    patientReference: "Patient/p1",
    observationReference,
    conditionReference: "Condition/second",
  })).status, 200)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:666`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:667`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:668`: `assert.deepEqual(fhir.resources, before)`

### 83. mcp/tests/diagnosisFindings.test.ts:922 — V3

Before:

```ts
assert.deepEqual(conditionEvidence(fhir, "unique"), [])
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:666`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:667`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:668`: `assert.deepEqual(fhir.resources, before)`

### 84. mcp/tests/diagnosisFindings.test.ts:923 — V3

Before:

```ts
assert.deepEqual(conditionEvidence(fhir, "second"), [observationReference])
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:666`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:667`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:668`: `assert.deepEqual(fhir.resources, before)`

### 85. mcp/tests/diagnosisFindings.test.ts:924 — V3

Before:

```ts
assert.equal(atomicObservations(fhir)[0]?.focus, undefined)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:666`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:667`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:668`: `assert.deepEqual(fhir.resources, before)`

### 86. mcp/tests/diagnosisFindings.test.ts:926 — V3

Before:

```ts
assert.equal((await mutate(fhir, {
    action: "standalone",
    patientReference: "Patient/p1",
    observationReference,
  })).status, 200)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:666`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:667`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:668`: `assert.deepEqual(fhir.resources, before)`

### 87. mcp/tests/diagnosisFindings.test.ts:931 — V3

Before:

```ts
assert.deepEqual(conditionEvidence(fhir, "unique"), [])
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:666`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:667`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:668`: `assert.deepEqual(fhir.resources, before)`

### 88. mcp/tests/diagnosisFindings.test.ts:932 — V3

Before:

```ts
assert.deepEqual(conditionEvidence(fhir, "second"), [])
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:666`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:667`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:668`: `assert.deepEqual(fhir.resources, before)`

### 89. mcp/tests/diagnosisFindings.test.ts:933 — V3

Before:

```ts
assert.equal(atomicObservations(fhir)[0]?.focus, undefined)
```

After (same scenario):

- `mcp/tests/diagnosisFindings.test.ts:666`: `assert.equal(response.status, 409)`
- `mcp/tests/diagnosisFindings.test.ts:667`: `assert.equal((response.body as { reason: string }).reason, "pre-rebuild-test-encounter")`
- `mcp/tests/diagnosisFindings.test.ts:668`: `assert.deepEqual(fhir.resources, before)`

## mcp/tests/fixtures/r10/premise-replay.ts

### 90. mcp/tests/fixtures/r10/premise-replay.ts:53 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal(r.status,200,JSON.stringify(r.body))
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 91. mcp/tests/fixtures/r10/premise-replay.ts:64 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal((await get(f)).length,2)
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 92. mcp/tests/fixtures/r10/premise-replay.ts:67 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal(pick.status,422)
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 93. mcp/tests/fixtures/r10/premise-replay.ts:74 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal(cleared.status,200)
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 94. mcp/tests/fixtures/r10/premise-replay.ts:75 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal(after[0].source,'section')
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 95. mcp/tests/fixtures/r10/premise-replay.ts:77 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal(denied.status,400)
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 96. mcp/tests/fixtures/r10/premise-replay.ts:80 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal((await get(ou))[0].laterality,'OU')
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 97. mcp/tests/fixtures/r10/premise-replay.ts:81 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal((await mutate(ou,{action:'clear',observationReference:`Observation/${oa.id}`})).status,200)
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 98. mcp/tests/fixtures/r10/premise-replay.ts:107 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal(cf.length,2)
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 99. mcp/tests/fixtures/r10/premise-replay.ts:107 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.ok(cf.find((r:any)=>r.findingInstanceId===old.id)?.candidates.some((c:any)=>c.diagnosisKey===dx.stableKey))
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 100. mcp/tests/fixtures/r10/premise-replay.ts:130 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal((await get(can)).length,1)
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 101. mcp/tests/fixtures/r10/premise-replay.ts:140 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal(pick.status,422)
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 102. mcp/tests/fixtures/r10/premise-replay.ts:142 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'legacy-section-snapshot')
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 103. mcp/tests/fixtures/r10/premise-replay.ts:143 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.equal(denied.status,400)
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

### 104. mcp/tests/fixtures/r10/premise-replay.ts:145 — W-a / W-c / W-d / W-e (authorized E2/E4/E5/E6/E7/E11/E17 and atom/transport only)

Before:

```ts
assert.deepEqual(project(dupe.rows).conflicts.map(r=>r.eye),['OD'])
```

After (same scenario):

- `mcp/tests/fixtures/r10/premise-replay.ts:36`: `assert.ok(i>=0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:54`: `assert.equal(r.status,200,JSON.stringify(r.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:56`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:61`: `assert.equal(result.complete,true,JSON.stringify(result))`
- `mcp/tests/fixtures/r10/premise-replay.ts:66`: `assert.equal(r.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.ok(nested)`
- `mcp/tests/fixtures/r10/premise-replay.ts:71`: `assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:72`: `assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:76`: `assert.equal((await get(f)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:77`: `assert.equal(findingInstancesFromObservation(a,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:79`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:82`: `assert.equal(findingInstancesFromObservation(view,defs).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:83`: `assert.equal(overview([view]).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:86`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:87`: `assert.equal(after[0].kind,'fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:89`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:92`: `assert.deepEqual((await get(ou)).map((r:any)=>r.eye),['OD','OS'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:93`: `assert.equal((await mutate(ou,commandBody('clear',factTargets(ou,'retired')))).status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:94`: `assert.equal((await get(ou)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.equal((await get(dupe)).length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:96`: `assert.deepEqual((await get(dupe)).map((r:any)=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal((await get(neg)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.equal(nh[0].state,'normal')`
- `mcp/tests/fixtures/r10/premise-replay.ts:101`: `assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.deepEqual(tr.value,[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:105`: `assert.ok(tr.findingDetails[lensOption].colour)`
- `mcp/tests/fixtures/r10/premise-replay.ts:107`: `assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:108`: `assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:113`: `assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:114`: `assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0')`
- `mcp/tests/fixtures/r10/premise-replay.ts:118`: `assert.equal(cr.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.equal(cf.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:119`: `assert.ok(!cf.some((r:any)=>r.findingInstanceId===old.id))`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal((await get(stale)).length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:120`: `assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2)`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.equal(qr.status,200,JSON.stringify(qr.body))`
- `mcp/tests/fixtures/r10/premise-replay.ts:126`: `assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details)`
- `mcp/tests/fixtures/r10/premise-replay.ts:129`: `assert.equal(customFieldEntries(effective).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal(complete.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:134`: `assert.equal((complete.body as any).diagnoses.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:136`: `assert.equal((complete.body as any).diagnoses.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal(vp.status,200)`
- `mcp/tests/fixtures/r10/premise-replay.ts:138`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:140`: `assert.equal((await get(unk))[0].laterality,'UNKNOWN')`
- `mcp/tests/fixtures/r10/premise-replay.ts:142`: `assert.equal((await get(can)).length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:151`: `assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)`
- `mcp/tests/fixtures/r10/premise-replay.ts:152`: `assert.equal(pick.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:153`: `assert.equal(overview(project([s,a]).definitionViews).findings.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(cleared.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:154`: `assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'canonical-fact')`
- `mcp/tests/fixtures/r10/premise-replay.ts:155`: `assert.equal(denied.status,409)`
- `mcp/tests/fixtures/r10/premise-replay.ts:156`: `assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).conflicts,[])`
- `mcp/tests/fixtures/r10/premise-replay.ts:157`: `assert.deepEqual(project(dupe.rows).currentFacts.map(r=>[r.eye,r.presence]),[['OD','absent'],['OS','present']])`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:158`: `assert.equal(p.panels[0].negativeActs.length,1)`
- `mcp/tests/fixtures/r10/premise-replay.ts:159`: `assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])`
- `mcp/tests/fixtures/r10/premise-replay.ts:160`: `assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)`
- `mcp/tests/fixtures/r10/premise-replay.ts:161`: `assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])`
- `mcp/tests/fixtures/r10/premise-replay.ts:162`: `assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)`
- `mcp/tests/fixtures/r10/premise-replay.ts:163`: `assert.equal(project([s],[effective]).currentFacts.length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:164`: `assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:165`: `assert.equal((vp.body as any).count,0)`
- `mcp/tests/fixtures/r10/premise-replay.ts:166`: `assert.equal(project(unk.rows).unresolved[0].reference,\`Observation/${ua.id}\`)`
- `mcp/tests/fixtures/r10/premise-replay.ts:167`: `assert.equal(project(can.rows).currentFacts[0].status,'retired')`

Changed/removed assertion records: 104.
