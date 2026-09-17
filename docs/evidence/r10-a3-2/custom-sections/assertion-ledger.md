# Custom sections assertion migration ledger

Author-side proof; NOT EVALUATED. Tests retain 83 cases. Original canonical-migration baseline: 46 pass / 37 fail. Final: 83 pass / 0 fail. No commits.

The explicitly named browser-safe fixture adapter expands test row specifications into canonical facts, offered baselines, panel values and negative scope envelopes. Current production editor receives only canonical `eyes`; prior snapshots remain historical fixture data. The Deferred and fresh suggestion cases use real handlers and memory FHIR. Non-Ocular production behavior is unchanged.

Every changed assertion is listed below with its exact before/after text and source line. Fixture-only changes (canonical response adapter, action identity, realistic browser event target, resolving fresh controls after reload) do not remove expectations. Root approved template assertion migration under V21/V22/W-k: saved scopes replace retired snapshot prose.

## V18 V22 ocular-health save asserts findings and clearing the last positive never invents Normal

Mapping: **V21 / V22 / W-k**. File: `ui/tests/customSections.test.tsx`; before test line 1175, after test line 1185.

Before:

Line 1205:
```ts
assert.equal(posts[0]?.eyes.OD.state, "abnormal")
```

Line 1206:
```ts
assert.deepEqual(posts[0]?.eyes.OD.customFields, [{
      code: "CUSTOM_DEFERRED_FINDINGS",
      value: ["synthetic-finding"],
    }])
```

Line 1213:
```ts
assert.equal(posts[1]?.eyes.OD.state, "normal")
```

Line 1214:
```ts
assert.deepEqual(posts[1]?.eyes.OD.customFields, [])
```

Line 1219:
```ts
assert.equal(posts[2]?.eyes.OD.state, "abnormal")
```

Line 1220:
```ts
assert.equal(posts[2]?.eyes.OD.other, "Trace scar")
```

After:

Line 1215:
```ts
assert.equal(posts[0]?.eyes.OD.panel.state.deferred, false)
```

Line 1216:
```ts
assert.deepEqual(posts[0]?.eyes.OD.selected.map((claim:any) => claim.key.optionCode), ["synthetic-finding"])
```

Line 1220:
```ts
assert.equal(posts[1]?.eyes.OD.negativeAct, undefined, "clearing the final positive never invents a negative act")
```

Line 1221:
```ts
assert.deepEqual(posts[1]?.eyes.OD.selected, [])
```

Line 1226:
```ts
assert.equal(posts[2]?.eyes.OD.panel.state.other, "Trace scar")
```

## W138 deferred locks loaded findings while the canonical server preserves their bytes

Mapping: **V21 / W70 / W138**. File: `ui/tests/customSections.test.tsx`; before test line 1244, after test line 1250.

Before: no assertion (new coverage).

After:

Line 1310:
```ts
assert.equal(attempts[0]?.status, 200, JSON.stringify(attempts[0]?.response))
```

Line 1311:
```ts
assert.deepEqual(attempts[0]?.body.eyes.OD.selected.map((claim:any) => claim.key.optionCode), ["synthetic-finding"])
```

Line 1313:
```ts
assert.ok(fact, "canonical fact was actually persisted by the handler")
```

Before:

Line 1320:
```ts
assert.equal(deferred().props["aria-pressed"], false)
```

After:

Line 1316:
```ts
assert.equal(finding().props.disabled, true, "W138 Deferred locks the selected fact")
```

Before:

Line 1324:
```ts
assert.equal(deferred().props["aria-pressed"], false)
```

Line 1325:
```ts
assert.match(JSON.stringify(renderer.toJSON()), /Clear the selected findings before deferring/)
```

Line 1326:
```ts
assert.equal(attempts.length, 0)
```

Line 1329:
```ts
assert.equal(attempts[0]?.status, 200, JSON.stringify(attempts[0]?.response))
```

Line 1330:
```ts
assert.equal(attempts[0]?.body.eyes.OD.state, "abnormal")
```

Line 1331:
```ts
assert.deepEqual(attempts[0]?.body.eyes.OD.customFields, [{
      code: "CUSTOM_DEFERRED_FINDINGS",
      value: ["synthetic-finding"],
    }])
```

Line 1338:
```ts
assert.equal(deferred().props["aria-pressed"], true)
```

Line 1340:
```ts
assert.equal(deferred().props["aria-pressed"], false)
```

Line 1342:
```ts
assert.equal(deferred().props["aria-pressed"], false)
```

Line 1343:
```ts
assert.match(JSON.stringify(renderer.toJSON()), /Clear Other text before deferring/)
```

After:

Line 1319:
```ts
assert.equal(attempts[1]?.status, 200, JSON.stringify(attempts[1]?.response))
```

Line 1320:
```ts
assert.deepEqual(attempts[1]?.body.eyes.OD.loaded, attempts[1]?.body.eyes.OD.selected, "W138 no deselection accompanies Deferred")
```

Line 1321:
```ts
assert.equal(attempts[1]?.body.eyes.OD.panel.state.deferred, true)
```

Line 1322:
```ts
assert.deepEqual(memory.all<Observation>("Observation").find(o => o.id === fact.id), fact, "W138 Deferred never changes the fact bytes or version")
```

Line 1324:
```ts
assert.equal(finding().props.disabled, false)
```

Line 1325:
```ts
assert.equal(finding().props["aria-pressed"], true)
```

## prior history never seeds current controls or changes the base POST body

Mapping: **V18 / V19 / W130**. File: `ui/tests/customSections.test.tsx`; before test line 1382, after test line 1364.

Before:

Line 1435:
```ts
assert.equal(posts[0], baseBody, "an untouched OD prior must not add a byte to an unrelated OS save")
```

After:

Line 1408:
```ts
assert.ok(request.commandId)
```

Line 1409:
```ts
assert.deepEqual(Object.keys(request.eyes), ["OS"], "untouched OD prior does not enter the current request")
```

Line 1410:
```ts
assert.deepEqual(request.eyes.OS.loaded, [])
```

Line 1411:
```ts
assert.deepEqual(request.eyes.OS.selected.map((claim:any) => ({code:claim.key.optionCode,qualifiers:claim.qualifiers})), [{code:"synthetic-finding",qualifiers:{}}])
```

Line 1412:
```ts
assert.equal(request.eyes.OS.panel.state.deferred, false)
```

## ocular-health read-forward preserves stored finding details through an unrelated save

Mapping: **V18 / W130**. File: `ui/tests/customSections.test.tsx`; before test line 1787, after test line 1765.

Before:

Line 1827:
```ts
assert.deepEqual(postedBody, {
      patientReference: "Patient/p-qualified-forward",
      encounterReference: "Encounter/e-qualified-forward",
      eyes: {
        OD: {
          state: "abnormal",
          customFields: [{ code: "CUSTOM_ABNORMAL_FINDINGS_01", value: ["synthetic-finding"] }],
          findingDetails: storedFindingDetails,
          other: "Unrelated note.",
        },
      },
    })
```

After:

Line 1806:
```ts
assert.ok(request.commandId)
```

Line 1807:
```ts
assert.equal(request.patientReference, "Patient/p-qualified-forward")
```

Line 1808:
```ts
assert.equal(request.encounterReference, "Encounter/e-qualified-forward")
```

Line 1809:
```ts
assert.deepEqual(request.eyes.OD.selected, request.eyes.OD.loaded)
```

Line 1810:
```ts
assert.deepEqual(canonicalQualifiers(request.eyes.OD), storedFindingDetails)
```

Line 1811:
```ts
assert.equal(request.eyes.OD.panel.state.other, "Unrelated note.")
```

## segmented finding grades replace the value and re-tapping clears the findingDetails entry

Mapping: **V18 / W130**. File: `ui/tests/customSections.test.tsx`; before test line 2094, after test line 2068.

Before:

Line 2129:
```ts
assert.deepEqual(posts[0]!.eyes.OD.findingDetails, { "synthetic-mgd": { grade: "marked" } })
```

After:

Line 2103:
```ts
assert.deepEqual(canonicalQualifiers(posts[0]!.eyes.OD), { "synthetic-mgd": { grade: "marked" } })
```

Before:

Line 2133:
```ts
assert.equal("findingDetails" in posts[1]!.eyes.OD, false)
```

After:

Line 2107:
```ts
assert.deepEqual(canonicalQualifiers(posts[1]!.eyes.OD), {})
```

## all four finding qualifier controls write the server-validated value shapes

Mapping: **V18 / W130**. File: `ui/tests/customSections.test.tsx`; before test line 2139, after test line 2113.

Before:

Line 2187:
```ts
assert.deepEqual(postedBody?.eyes.OD.findingDetails, {
      "synthetic-mgd": {
        grade: "marked",
        type: "seborrheic",
        score: 3,
        arc: { from: 2, to: 5, clockwise: false },
      },
    })
```

After:

Line 2161:
```ts
assert.deepEqual(canonicalQualifiers(postedBody?.eyes.OD), {
      "synthetic-mgd": {
        grade: "marked",
        type: "seborrheic",
        score: 3,
        arc: { from: 2, to: 5, clockwise: false },
      },
    })
```

## numeric finding qualifiers preserve controlled keystrokes and visibly reject invalid values

Mapping: **V18 / W130**. File: `ui/tests/customSections.test.tsx`; before test line 2200, after test line 2174.

Before:

Line 2261:
```ts
assert.deepEqual(postedBody?.eyes.OD.findingDetails, {
      "synthetic-decimal": { score: 1.5 },
      "synthetic-integer": { score: 15 },
    })
```

After:

Line 2235:
```ts
assert.deepEqual(canonicalQualifiers(postedBody?.eyes.OD), {
      "synthetic-decimal": { score: 1.5 },
      "synthetic-integer": { score: 15 },
    })
```

## described finding destruction is guarded from Zone A and the row remove path prunes the next POST

Mapping: **V18 / V19 / W130**. File: `ui/tests/customSections.test.tsx`; before test line 2297, after test line 2271.

Before:

Line 2344:
```ts
assert.deepEqual(posts[0], {
      patientReference: "Patient/p-confirm-destroy",
      encounterReference: "Encounter/e-confirm-destroy",
      eyes: { OD: { state: "normal", customFields: [] } },
    })
```

After:

Line 2318:
```ts
assert.ok(posts[0].commandId)
```

Line 2319:
```ts
assert.equal(posts[0].patientReference, "Patient/p-confirm-destroy")
```

Line 2320:
```ts
assert.equal(posts[0].encounterReference, "Encounter/e-confirm-destroy")
```

Line 2321:
```ts
assert.deepEqual(posts[0].eyes.OD.selected, [])
```

Line 2322:
```ts
assert.deepEqual(posts[0].eyes.OD.loaded.map((claim:any) => claim.key.optionCode), ["synthetic-finding"])
```

Line 2323:
```ts
assert.equal(posts[0].eyes.OD.negativeAct, undefined, "removal never invents Normal")
```

## child details fold into the worksheet row and remain selection codes in the POST body

Mapping: **V18 / W130**. File: `ui/tests/customSections.test.tsx`; before test line 2516, after test line 2492.

Before:

Line 2548:
```ts
assert.deepEqual(postedBody?.eyes.OD.customFields, [{
      code: "CUSTOM_ABNORMAL_FINDINGS_WORKSHEET",
      value: ["synthetic-demodex", "synthetic-demodex::collarettes"],
    }])
```

Line 2552:
```ts
assert.equal("findingDetails" in postedBody!.eyes.OD, false)
```

After:

Line 2524:
```ts
assert.deepEqual(postedBody?.eyes.OD.selected.map((claim:any) => claim.key.optionCode), ["synthetic-demodex", "synthetic-demodex::collarettes"])
```

Line 2525:
```ts
assert.deepEqual(canonicalQualifiers(postedBody!.eyes.OD), {})
```

## V21 V22 a saved negative scope stays frozen after the live normal template changes

Mapping: **V21 / V22 / W-k**. File: `ui/tests/customSections.test.tsx`; before test line 2598, after test line 2571.

Before:

Line 2628:
```ts
assert.equal(templates[0], "Saved normal snapshot.")
```

Line 2629:
```ts
assert.equal(templates[1], "Later edited live template.")
```

After:

Line 2602:
```ts
assert.deepEqual(templates, ["Later edited live template.", "Later edited live template."])
```

Line 2604:
```ts
assert.equal(negativeAfter, negativeBefore, "V22 the recorded negative scope and timestamp do not change with template prose")
```

Line 2605:
```ts
assert.doesNotMatch(negativeAfter, /Later edited live template|Saved normal snapshot/)
```

## saved ocular-health findings expose real scoped diagnosis suggestions and only explicit taps propose or retract

Mapping: **V30 / W139 / W140**. File: `ui/tests/customSections.test.tsx`; before test line 2775, after test line 2751.

Before:

Line 2914:
```ts
assert.deepEqual(diagnosisWrites[0], {
      diagnosisKey: "cataract_nuclear_sclerosis",
      action: "possible",
      findingInstanceId: "lens-current",
      source: "mapping",
    })
```

After:

Line 2905:
```ts
assert.match(String(diagnosisWrites[0]?.commandId), /^[0-9a-f-]{36}$/)
```

Line 2906:
```ts
assert.deepEqual(diagnosisWrites[0], {
      diagnosisKey: "cataract_nuclear_sclerosis", action: "possible", source: "mapping",
      commandId: diagnosisWrites[0]!.commandId, supportingFacts: [{key,baseline:support.baseline}], laterality: "OD",
    })
```

Line 2910:
```ts
assert.deepEqual(homes,["Condition/condition-cataract"])
```

## fresh ocular-health history restores scoped diagnosis suggestions without a save

Mapping: **V30 / W139 / W140**. File: `ui/tests/customSections.test.tsx`; before test line 2933, after test line 2924.

Before:

Line 3020:
```ts
assert.equal(saved.status, 200, JSON.stringify(saved.body))
```

Line 3023:
```ts
assert.equal(savedReference, `Observation/${observations[0]?.id}`)
```

After:

Line 2975:
```ts
assert.equal(before.status,200,JSON.stringify(before.body))
```

Line 2981:
```ts
assert.equal(saved.status,200,JSON.stringify(saved.body))
```

Line 2986:
```ts
assert.ok(memory.fhir)
```

## posterior seeded history renders honestly and zero-data eyes remain untouched

Mapping: **V21 / W96 / W136**. File: `ui/tests/customSections.test.tsx`; before test line 3167, after test line 3132.

Before:

Line 3191:
```ts
assert.equal(renderer.root.findAllByProps({ value: "" }).length, 12)
```

After:

Line 3157:
```ts
assert.equal(otherFields.length, definitions.length * 2)
```

Line 3158:
```ts
assert.ok(otherFields.every(node => node.props.value === ""))
```

Line 3159:
```ts
assert.ok(renderer.root.findAllByType(OdosSelect).every(node => node.props.value === ""), "unmeasured grades remain blank")
```

Line 3160:
```ts
assert.equal(renderer.root.findAllByType("textarea").filter(node => node.props["aria-label"]?.endsWith(" Remarks") && node.props.value === "").length, definitions.length * 2)
```

## V21 V22 posterior re-save stays pristine, round-trips selections, and preserves the saved negative scope

Mapping: **V21 / V22 / W-k**. File: `ui/tests/customSections.test.tsx`; before test line 3214, after test line 3183.

Before:

Line 3254:
```ts
assert.ok(templates.includes("Saved fundus normal snapshot."))
```

After:

Line 3224:
```ts
assert.equal(fundusNegative(), negativeBefore, "V22 unrelated save preserves recorded scope")
```

Line 3225:
```ts
assert.match(fundusNegative(), /Absent:/)
```

## AVFILL-1 deliberate 2:3 choice persists and does not POST again while pristine

Mapping: **V21 / W96 / W136**. File: `ui/tests/customSections.test.tsx`; before test line 3260, after test line 3231.

Before:

Line 3293:
```ts
assert.deepEqual(JSON.parse(posts[0]!).eyes.OD.customFields, [{ code: "CUSTOM_GRADE_A_V_RATIO", value: "2-3" }])
```

After:

Line 3264:
```ts
assert.deepEqual(JSON.parse(posts[0]!).eyes.OD.panel.state.values, { CUSTOM_GRADE_A_V_RATIO: "2-3" })
```

## remaining anterior structure grades render blank, persist typed values, and hydrate per eye

Mapping: **V21 / W96 / W136**. File: `ui/tests/customSections.test.tsx`; before test line 3302, after test line 3273.

Before:

Line 3342:
```ts
assert.deepEqual(posts[0]!.body.eyes.OD?.customFields, [{ code: "CUSTOM_GRADE_TBUT", value: 6 }])
```

Line 3343:
```ts
assert.deepEqual(posts[1]!.body.eyes.OS?.customFields, [{ code: "CUSTOM_GRADE_VAN_HERICK", value: "grade-2" }])
```

After:

Line 3313:
```ts
assert.deepEqual(posts[0]!.body.eyes.OD?.panel.state.values, { CUSTOM_GRADE_TBUT: 6 })
```

Line 3314:
```ts
assert.deepEqual(posts[1]!.body.eyes.OS?.panel.state.values, { CUSTOM_GRADE_VAN_HERICK: "grade-2" })
```

## Proof

- `node --import tsx --test tests/customSections.test.tsx`, from ui/: restored **83 pass, 0 fail**.
- Qualifier mutation: replace outgoing selected fact qualifiers with `{}`. Four migrated qualifier/read-forward tests: **0 pass, 4 fail**; restored.
- Deferred mutation: force outgoing panel `deferred: false`. Real-handler W138 test: **0 pass, 1 fail**; restored.
- W144 void/undo proof is in the neighboring `void-undo/` evidence directory.

Changed assertion groups: 16. Raw outputs below this directory.


## Operator-approved W138 visibility follow-up

The existing flag-only Deferred visibility test is renamed to `W138 canonical ocular panels expose Deferred independently of the legacy definition flag`. Its one exact count assertion changes from2 to4 controls across two bilateral definitions. The user explicitly approved exposing canonical Deferred despite the legacy flag. See ../deferred-visibility-approval.md. No other assertion in this test changes. Before implementation the updated test failed0/1; after implementation the combined customSections/editor suite passed106/106.
