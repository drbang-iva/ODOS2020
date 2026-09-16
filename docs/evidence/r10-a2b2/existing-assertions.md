# Existing assertion migration — R10 A2b.2

Base: `6025d836` (A2b.1). The before lines refer to the unchanged base file; after lines refer to this A2b.2 working-tree file. Every changed or removed assertion in the two migrated suites appears below; added strengthening assertions are included with their replacement. No test was skipped or removed.

`diagnosisCarryForward.test.tsx` changes only fixtures to canonical per-eye rows with keys, baselines, status, homes and contributors, plus the GET payload fields (W-c). Its assertions are unchanged. `diagnosisLinkL2.test.tsx` and `diagnosisLinkL3.test.tsx` are unchanged. Existing `diagnosisDemotionImpact.test.tsx` assertions remain unchanged; W54 adds a new failed-pick behavioral test at line 356 under rev 3.5 legacy-client compatibility. Its mutation evidence is in `W54/README.md`.

## Change 1: V17 / W-c: origin text is supplied by canonical homeSources; preserves provenance and pagination checks.

**Before `ui/tests/diagnosisWorkspace.test.tsx:227`**

```tsx
assert.equal(renderer.root.findByProps({ className: "odos-diagnosis-provenance" }).children.join(""), "← from Lens OD");
```

**After `ui/tests/diagnosisWorkspace.test.tsx:228`**

```tsx
assert.equal(renderer.root.findByProps({ className: "odos-diagnosis-provenance" }).children.join(""), "← from Lens · OD");
```

## Change 4: V7 / W-b: failed refresh explicitly displays Findings unavailable; stale carry assertions remain forbidden.

**Before `ui/tests/diagnosisWorkspace.test.tsx:1089`**

```tsx
assert.ok(renderer.root.findAllByProps({ role: "alert" }).some((node) => node.children.join("") === "Finding verification failed."));
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1091`**

```tsx
assert.ok(renderer.root.findAllByProps({ role: "alert" }).some((node) => node.children.join("").includes("Findings unavailable")));
```

## Change 7: V9 / W-a / W-c: explicit eye choices replace inherited source; six commands retain all prior actions, with UUID and exact per-eye targets/baselines/state checks.

**Before `ui/tests/diagnosisWorkspace.test.tsx:1199`**

```tsx
assert.match(json, /is-inherited/);
```

**Before `ui/tests/diagnosisWorkspace.test.tsx:1200`**

```tsx
assert.match(json, /is-explicit/);
```

**Before `ui/tests/diagnosisWorkspace.test.tsx:1215`**

```tsx
assert.deepEqual(mutations, [
    {
      action: "assert",
      patientReference: "Patient/p1",
      conditionReference: "Condition/selected",
      atomicFindingId: "section::field::offered",
      presence: "present",
    },
    {
      action: "assert",
      patientReference: "Patient/p1",
      conditionReference: "Condition/selected",
      atomicFindingId: "section::field::offered",
      presence: "absent",
    },
    {
      action: "assert",
      patientReference: "Patient/p1",
      conditionReference: "Condition/selected",
      atomicFindingId: "section::field::absent",
      presence: "present",
      laterality: "OS",
    },
    {
      action: "clear",
      patientReference: "Patient/p1",
      observationReference: "Observation/charted",
    },
    {
      action: "clear",
      patientReference: "Patient/p1",
      observationReference: "Observation/absent",
    },
    {
      action: "laterality",
      patientReference: "Patient/p1",
      observationReference: "Observation/charted",
      laterality: "OS",
    },
  ]);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1201`**

```tsx
assert.doesNotMatch(json, /Use diagnosis/);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1202`**

```tsx
assert.deepEqual(renderer.root.findByProps({ "aria-label": "Laterality Charted finding" }).findAllByType("option").map((node) => node.props.value), ["OD", "OS", "OU"]);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1222`**

```tsx
assert.match(mutation.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1223`**

```tsx
assert.equal(new Set(mutations.map((mutation) => mutation.commandId)).size, 6);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1224`**

```tsx
assert.deepEqual(mutations.map(({ commandId: _id, ...body }) => body), [
    { operation: "assert", patientReference: "Patient/p1", context: { selectedConditionReference: "Condition/selected" }, targets: [target(offered, "live", "present", ["Condition/selected"])] },
    { operation: "assert", patientReference: "Patient/p1", context: { selectedConditionReference: "Condition/selected" }, targets: [target(offered, "live", "absent", ["Condition/selected"])] },
    { operation: "assert", patientReference: "Patient/p1", context: { selectedConditionReference: "Condition/selected" }, targets: [target(absent, "live", "present")] },
    { operation: "clear", patientReference: "Patient/p1", context: { selectedConditionReference: "Condition/selected" }, targets: [target(charted, "retired")] },
    { operation: "clear", patientReference: "Patient/p1", context: { selectedConditionReference: "Condition/selected" }, targets: [target(absent, "retired")] },
    { operation: "eye-change", patientReference: "Patient/p1", context: { selectedConditionReference: "Condition/selected" }, eyes: { from: ["OD"], to: ["OS"] }, targets: [
      target(charted, "retired"),
      { kind: "fact", key: { ...charted.key, eye: "OS" }, baseline: { kind: "absent", key: { ...charted.key, eye: "OS" } }, state: { status: "live", presence: "present", qualifiers: {}, homes: ["Condition/selected"] } },
    ] },
  ]);
```

## Change 16: V1 / W-a: assignment becomes move and standalone remains one command; UUID uniqueness and exact canonical target bodies are checked.

**Before `ui/tests/diagnosisWorkspace.test.tsx:1277`**

```tsx
assert.deepEqual(mutations, [
    {
      action: "assign",
      patientReference: "Patient/p1",
      observationReference: "Observation/unassigned",
      conditionReference: "Condition/selected",
    },
    {
      action: "standalone",
      patientReference: "Patient/p1",
      observationReference: "Observation/unassigned",
    },
  ]);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1258`**

```tsx
assert.match(mutation.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1259`**

```tsx
assert.notEqual(mutations[0]!.commandId, mutations[1]!.commandId);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1260`**

```tsx
assert.deepEqual(mutations.map(({ commandId: _id, ...body }) => body), [
    { operation: "move", patientReference: "Patient/p1", context: { selectedConditionReference: "Condition/selected" }, targets: [{ kind: "fact", key: row.key, baseline: row.baseline, state: { status: "live", presence: "present", qualifiers: {}, homes: ["Condition/selected"] } }] },
    { operation: "standalone", patientReference: "Patient/p1", targets: [{ kind: "fact", key: row.key, baseline: row.baseline, state: { status: "live", presence: "present", qualifiers: {}, homes: [] } }] },
  ]);
```

## Change 21: V13 / W-d / W-e: canonical suggestion identity and supportingFacts travel through the typed pick path with a UUID.

**Before `ui/tests/diagnosisWorkspace.test.tsx:1407`**

```tsx
assert.deepEqual(pickBodies, [{
      diagnosisKey: "macular_drusen",
      action: "confirm",
      findingInstanceId: "finding-unassigned",
      laterality: "OD",
      source: "mapping",
    }]);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1385`**

```tsx
assert.match(String(pickBodies[0]?.commandId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1386`**

```tsx
assert.deepEqual(pickBodies.map(({ commandId: _id, ...body }) => body), [{
      diagnosisKey: "macular_drusen",
      action: "confirm",
      findingInstanceId: "unassigned:OD",
      laterality: "OD",
      source: "mapping",
      supportingFacts: supportingFacts.map(({ key, baseline }) => ({ key, baseline })),
    }]);
```

## Change 25: V1: Staff can mutate finding homes using chart.write without diagnosis permission.

**Before `ui/tests/diagnosisWorkspace.test.tsx:2052`**

```tsx
assert.equal(tray.props.disabled, denied, "assignment and standalone change diagnosis evidence");
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1952`**

```tsx
assert.equal(tray.props.disabled, false, "finding commands retain ordinary chart write capability");
```

## Change 28: V1 / W-a: Staff assert/clear controls and callbacks remain enabled independently of chart.diagnosis.write.

**Before `ui/tests/diagnosisWorkspace.test.tsx:2072`**

```tsx
assert.equal(control.props.disabled, canWriteDiagnosis !== true, label);
```

**Before `ui/tests/diagnosisWorkspace.test.tsx:2075`**

```tsx
assert.deepEqual(mutations, [], "denied evidence callbacks do not issue writes");
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1972`**

```tsx
assert.equal(control.props.disabled, false, label);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1975`**

```tsx
assert.deepEqual(mutations.map((mutation) => mutation.operation), ["assert", "assert", "clear", "clear"], "Staff can record and clear findings");
```

## Change 33: V1 / V11 / W-a: grade and eye-change operations remain enabled, along with search assertion.

**Before `ui/tests/diagnosisWorkspace.test.tsx:2081`**

```tsx
assert.deepEqual(mutations.map((mutation) => mutation.action), ["grade", "laterality"]);
```

**Before `ui/tests/diagnosisWorkspace.test.tsx:2083`**

```tsx
assert.equal(renderer.root.findByProps({ className: "odos-diagnosis-finding-search-results" }).findByType("button").props.disabled, canWriteDiagnosis !== true);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1981`**

```tsx
assert.deepEqual(mutations.slice(4).map((mutation) => mutation.operation), ["grade", "eye-change"]);
```

**After `ui/tests/diagnosisWorkspace.test.tsx:1983`**

```tsx
assert.equal(renderer.root.findByProps({ className: "odos-diagnosis-finding-search-results" }).findByType("button").props.disabled, false);
```

## Assertion context change: pending selected diagnosis

V17 / W-c: `ui/tests/diagnosisWorkspace.test.tsx:1120` retains the same `assert.doesNotMatch(pending, /A finding|pulled from Aug 1, 2026/)` (base line 1118), but `pending` now reads the rendered text of `aria-label="Selected diagnosis workspace"` instead of the whole workspace. The guard still forbids the prior diagnosis finding/carry state in the active workspace while B loads. The rail may independently display A's valid homeSources origin while A remains in the visit list. The adjacent Loading findings assertion is unchanged.

## Verification

From `ui/`: `node --import tsx --test tests/diagnosisWorkspace.test.tsx tests/diagnosisCarryForward.test.tsx tests/diagnosisLinkL2.test.tsx tests/diagnosisLinkL3.test.tsx tests/diagnosisDemotionImpact.test.tsx`: 90 tests, 90 pass, 0 fail, 0 skipped, 0 todo. This is author verification, not independent evaluation. Main A2b.2 guard evidence remains in the slice's guard ledger.

## Overlay grouping suite
- `ui/tests/diagnosisFindingGrouping.test.tsx:14`: before `[display, source]` expected atomic/section origins; after `[display, rowKey]` expects two distinct canonical per-eye rows. W-c removes source and introduces rowKey; section filtering remains asserted.
- `ui/tests/diagnosisFindingGrouping.test.tsx:49`: before label “Charted in section”; after “Shared finding”. W-c replaces legacy source classification with current shared finding rows. Presence/grade/laterality and refresh assertions unchanged.

## Fixback after evaluation at 9f58d5fc

No existing assertion was changed, removed, skipped, or weakened in this fixback. Thirteen new test cases were appended to r10DiagnosisWorkspace (eight) and r10DiagnosisTable (five), mapping to W55–W64 from the accepted evaluation record. Existing helper changes only add isolated fixture modes/configuration for these tests; prior modes and assertions are retained. W55: current live eye rows, fresh command/baseline and caught builder failure. W56: confirmed clinical write despite unconfirmed outcome. W57: thrown fetch and identical Retry. W58: carried absent search. W59: pre-rebuild diagnosis controls. W60: additive link homes. W61: replacement move homes. W62: signed/conflict tray refusal. W63: applied-pick event. W64: conflict labels. Thus there are no additional before/after assertion replacements to ledger.
