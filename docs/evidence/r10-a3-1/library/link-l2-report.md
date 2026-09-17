# Diagnosis Link L2 fixture migration — author evidence

Scope: only `mcp/tests/diagnosisLinkL2.test.ts` permanently edited for this bounded follow-up. Parent-owned earlier closed-encounter and strict-panel test changes remain intact. No carry implementation, policies, seeds, builders, UI, or production edits. The one authorized candidate source mutation was restored byte-for-byte.

## Fixture and wire changes

- Shared ocular checkbox capture fixtures are explicitly transformed by `captureCustomSectionFixture` to UUIDv4 command + per-eye frozen `loaded: []` / selected absent-baseline canonical targets. Every shared fixture in this suite creates a fresh definition/eye. Option-specific qualifiers are preserved. Non-shared capture calls still use their original payloads and handler.
- The MemoryFhir fixture now supports conditional `createWithOutcome`, returning `created: false` for an existing same-type identifier/tag owner; duplicate owners fail with 412. Search now respects identifier, audit tag, and Provenance target. Conditional create records only an actual insertion. This makes canonical capture/audit calls exercise their real handler paths (V18, §3.4; V20/W97).
- Shared findings are found by canonical identity or definition view instead of bare snapshot code/reference. Picks submit exact candidate key/reference/version supports and a command UUID. The existing split remains visible: pick applies the Condition and returns `link: pending`; a separate link command owns the finding change (V30).
- Existing candidate key lists, clinical family order/member count, per-eye ICD expectations, qualifier cases, allOf behavior, uncoded/code-count tests, search and no-write reads are preserved. No terminology was introduced; eyelid and cornea code literals already existed in this test; the new drusen Condition assertion uses the existing `sourcedDiagnosisCode` two-ledger helper. No Mandate 14 ledger addition needed.

## Exact assertion migration ledger

Before paths below refer to the captured pre-follow-up file `.odos/r10-a3-1/diagnosisLinkL2-before-library.ts`; after paths refer to `mcp/tests/diagnosisLinkL2.test.ts`. Full exact AST inventory is `link-l2-assertions.json`. It records 367 prior assertion calls, 358 unchanged calls, nine changed calls, and 30 replacement/new calls: 388 after. Nothing is unmapped.

### Before `mcp/tests/diagnosisLinkL2.test.ts:756` → V18/V30

Test: OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions. The shared checkbox fixture now saves canonical owners. A supported Condition pick succeeds.

Before:
```ts
assert.equal(confirmedCornea.status, 409, JSON.stringify(confirmedCornea.body))
```

After:
`mcp/tests/diagnosisLinkL2.test.ts:813`
```ts
assert.equal(confirmedCornea.status, 200, JSON.stringify(confirmedCornea.body))
```

### Before `mcp/tests/diagnosisLinkL2.test.ts:757` → V30

Test: OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions. Canonical supported picks return the Condition step with link pending; they neither synthesize Condition.evidence nor mutate the finding. Cornea ICD assertion retained and also verified on the persisted Condition.

Before:
```ts
assert.equal((confirmedCornea.body as any).reason, "pre-rebuild-test-encounter")
```

After:
`mcp/tests/diagnosisLinkL2.test.ts:815`
```ts
assert.equal(corneaCondition.code?.coding?.[0]?.code, "H18.611")
```
`mcp/tests/diagnosisLinkL2.test.ts:816`
```ts
assert.equal((confirmedCornea.body as { link: string }).link, "pending")
```
`mcp/tests/diagnosisLinkL2.test.ts:817`
```ts
assert.equal(corneaCondition.evidence, undefined)
```
`mcp/tests/diagnosisLinkL2.test.ts:818`
```ts
assert.deepEqual(fhir.resources.find(resource => resource.resourceType === "Observation" && resource.id === corneaObservation.id), corneaObservation)
```

### Before `mcp/tests/diagnosisLinkL2.test.ts:779` → V18

Test: OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions. Two eyes times two selected options now persist four canonical owners; exactly two per-eye candidate views remain. Exact option/eye tuples checked.

Before:
```ts
assert.equal(lidsObservations.length, 2)
```

After:
`mcp/tests/diagnosisLinkL2.test.ts:840`
```ts
assert.equal(lidsObservations.length, 4)
```
`mcp/tests/diagnosisLinkL2.test.ts:841`
```ts
assert.deepEqual(lidsObservations.map(observation => {
    const envelope = parseCurrentFindingEnvelope(observation);
    assert.equal(envelope.status, "valid");
    return envelope.status === "valid" ? `${envelope.key.eye}:${envelope.key.optionCode}` : "invalid";
  }).sort(), ["OD:anterior-blepharitis", "OD:anterior-blepharitis::ulcerative", "OS:anterior-blepharitis", "OS:anterior-blepharitis::ulcerative"])
```
`mcp/tests/diagnosisLinkL2.test.ts:843`
```ts
assert.equal(envelope.status, "valid")
```
`mcp/tests/diagnosisLinkL2.test.ts:852`
```ts
assert.equal(lidsRows.length, 2)
```

### Before `mcp/tests/diagnosisLinkL2.test.ts:806` → V18/V30

Test: OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions. Each per-eye subtype support produces its correctly scoped Condition step with link pending.

Before:
```ts
assert.equal(result.status, 409, JSON.stringify(result.body))
```

After:
`mcp/tests/diagnosisLinkL2.test.ts:877`
```ts
assert.equal(result.status, 200, JSON.stringify(result.body))
```
`mcp/tests/diagnosisLinkL2.test.ts:878`
```ts
assert.equal((result.body as { link: string }).link, "pending")
```

### Before `mcp/tests/diagnosisLinkL2.test.ts:812` → V30

Test: OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions. Canonical supported picks produce both existing verified blepharitis codes; total Conditions is exactly three including the cornea pick.

Before:
```ts
assert.deepEqual(blepharitisCodes, [])
```

After:
`mcp/tests/diagnosisLinkL2.test.ts:886`
```ts
assert.deepEqual(blepharitisCodes, ["H01.01A", "H01.01B"])
```
`mcp/tests/diagnosisLinkL2.test.ts:887`
```ts
assert.equal(fhir.resources.filter(resource => resource.resourceType === "Condition").length, 3)
```

### Before `mcp/tests/diagnosisLinkL2.test.ts:1836` → V18/V30

Test: posterior plain drusen returns an ordered leaf and staged family while occasional drusen stays descriptive. Exact ordered four-member clinical family object is unchanged after separating the new supportingFacts property; that property is asserted exactly against the canonical fact key/id/version.

Before:
```ts
assert.deepEqual(macula?.candidates[1], {
    familyGroup: "nonexudative-amd",
    clinicalFamily: "nonexudative-amd",
    display: "Nonexudative AMD",
    axisLabel: "Stage",
    members: [
      { stableKey: "dry_amd_early", stageLabel: "Early" },
      { stableKey: "dry_amd_intermediate", stageLabel: "Intermediate" },
      { stableKey: "dry_amd_advanced_atrophic_without_subfoveal", stageLabel: "Advanced atrophic without subfoveal involvement (geographic atrophy)" },
      { stableKey: "dry_amd_advanced_atrophic_with_subfoveal", stageLabel: "Advanced atrophic with subfoveal involvement (geographic atrophy)" },
    ],
    priority: true,
    source: "mapping",
  })
```

After:
`mcp/tests/diagnosisLinkL2.test.ts:1915`
```ts
assert.deepEqual(maculaFamily, {
    familyGroup: "nonexudative-amd",
    clinicalFamily: "nonexudative-amd",
    display: "Nonexudative AMD",
    axisLabel: "Stage",
    members: [
      { stableKey: "dry_amd_early", stageLabel: "Early" },
      { stableKey: "dry_amd_intermediate", stageLabel: "Intermediate" },
      { stableKey: "dry_amd_advanced_atrophic_without_subfoveal", stageLabel: "Advanced atrophic without subfoveal involvement (geographic atrophy)" },
      { stableKey: "dry_amd_advanced_atrophic_with_subfoveal", stageLabel: "Advanced atrophic with subfoveal involvement (geographic atrophy)" },
    ],
    priority: true,
    source: "mapping",
  })
```
`mcp/tests/diagnosisLinkL2.test.ts:1914`
```ts
assert.deepEqual(maculaSupports, [candidateSupport(maculaObservation)])
```

### Before `mcp/tests/diagnosisLinkL2.test.ts:1866` → V18/V30

Test: posterior plain drusen returns an ordered leaf and staged family while occasional drusen stays descriptive. Canonical macular support allows the Condition step.

Before:
```ts
assert.equal(picked.status, 409, JSON.stringify(picked.body))
```

After:
`mcp/tests/diagnosisLinkL2.test.ts:1946`
```ts
assert.equal(picked.status, 200, JSON.stringify(picked.body))
```

### Before `mcp/tests/diagnosisLinkL2.test.ts:1867` → V30

Test: posterior plain drusen returns an ordered leaf and staged family while occasional drusen stays descriptive. Canonical pick reports link pending, writes no legacy Condition.evidence and leaves the canonical fact unchanged.

Before:
```ts
assert.equal((picked.body as any).reason, "pre-rebuild-test-encounter")
```

After:
`mcp/tests/diagnosisLinkL2.test.ts:1950`
```ts
assert.equal((picked.body as { link: string }).link, "pending")
```
`mcp/tests/diagnosisLinkL2.test.ts:1951`
```ts
assert.equal(conditions[0].evidence, undefined)
```
`mcp/tests/diagnosisLinkL2.test.ts:1952`
```ts
assert.deepEqual(fhir.resources.find(resource => resource.resourceType === "Observation" && resource.id === maculaObservation.id), maculaObservation)
```

### Before `mcp/tests/diagnosisLinkL2.test.ts:1868` → V30

Test: posterior plain drusen returns an ordered leaf and staged family while occasional drusen stays descriptive. Exactly one Condition is now created from the canonical-supported staged-family pick; code resolves to the existing two-source-backed OD catalog pattern.

Before:
```ts
assert.equal(fhir.resources.some(r => r.resourceType === "Condition"), false)
```

After:
`mcp/tests/diagnosisLinkL2.test.ts:1948`
```ts
assert.equal(conditions.length, 1)
```
`mcp/tests/diagnosisLinkL2.test.ts:1949`
```ts
assert.equal(conditions[0].code?.coding?.[0]?.code, sourcedDiagnosisCode("dry_amd_early", "right"))
```

## Additional assertions

Each addition below supports V18/V30: strict checkbox fixture inputs, canonical identity validity, exact supported keys and baselines, successful candidate reads, and the pending-link Condition contract. These replace no additional old assertion.

`mcp/tests/diagnosisLinkL2.test.ts:85` (captureCustomSectionFixture)
```ts
assert.ok(Array.isArray(field.value), "Shared clinical fixture must supply checkbox options explicitly.")
```

`mcp/tests/diagnosisLinkL2.test.ts:792` (OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions)
```ts
assert.deepEqual(corneaRow?.candidates[0]?.supportingFacts, [candidateSupport(corneaObservation)])
```

`mcp/tests/diagnosisLinkL2.test.ts:850` (OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions)
```ts
assert.equal(lidsCandidates.status, 200, JSON.stringify(lidsCandidates.body))
```

`mcp/tests/diagnosisLinkL2.test.ts:859` (OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions)
```ts
assert.equal(row.candidates[0].supportingFacts?.length, 1)
```

`mcp/tests/diagnosisLinkL2.test.ts:861` (OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions)
```ts
assert.equal(support.key.optionCode, "anterior-blepharitis::ulcerative")
```

`mcp/tests/diagnosisLinkL2.test.ts:862` (OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions)
```ts
assert.deepEqual(support, candidateSupport(lidsObservations.find(observation => `Observation/${observation.id}` === support.baseline.reference)!))
```

`mcp/tests/diagnosisLinkL2.test.ts:880` (OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions)
```ts
assert.deepEqual(fhir.resources.filter((resource): resource is Observation => resource.resourceType === "Observation" &&
    resource.code.coding?.some((coding) => coding.code?.startsWith(`${lids.definition.stableKey}::`))), lidsObservations)
```

`mcp/tests/diagnosisLinkL2.test.ts:2549` (candidateSupport)
```ts
assert.ok(observation)
```

`mcp/tests/diagnosisLinkL2.test.ts:2551` (candidateSupport)
```ts
assert.equal(envelope.status, "valid")
```

## Executed checks

- Before migration: parent log `.odos/r10-a3-1/link-oh-regression.txt`: 85 tests, 73 pass, 12 fail (old shared capture wire).
- After frozen capture helper/fake support, before representation assertion updates: `.odos/r10-a3-1/link-migrating.txt`: 85 tests, 83 pass, 2 fail.
- Final full command: `mcp/node_modules/.bin/tsx --test mcp/tests/diagnosisLinkL2.test.ts`; evidence `link-l2-green.txt`: 85 tests, 85 pass, 0 fail.
- Mutation `link-l2-V30-supports`: unique candidate anchor `return facts.length ? { supportingFacts: facts } : {};` replaced with `return {};`. Focused OH-3 and posterior drusen tests: mutated 0 pass / 2 fail, restored 2 pass / 0 fail. Logs in `link-mutations/`; strict runner confirms one occurrence, designated assertion failure, and exact byte restoration.
- Source SHA256 after test migration: `e7965f9121159f2a2f369c42df66507d431c079b820fe302fb7f8937863e3fff`.

These are author checks only. Synthetic in-memory FHIR tests do not establish live AccessPolicy enforcement. No commit created. NOT EVALUATED; independent Claude/Fable/Opus evaluation remains required.
