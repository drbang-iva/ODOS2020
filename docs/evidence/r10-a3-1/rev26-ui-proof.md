# Rev 2.6 carried UI failures

All **8/8** recorded failures meet §8: six legacy shared-definition saves and two void-result comparisons missing `voidActionId`. No additional failure among the eight was found. This is source/log classification, not a fresh test run or independent evaluation.

Base/HEAD: `1706d7c8417b04791471d4332b4ecd712883bf11`; source contains the current uncommitted A3.1 changes. `git diff --name-only 1706d7c8 -- ui` is empty. Prior log reports 1,685 tests, 1,673 pass, 8 fail, 0 skipped, 4 TODO (lines 11975–11981). TODOs are separate from the eight.

## Per-test proof

### 1. deferred and recorded ocular findings cannot coexist at the client-server boundary

The synthetic definition explicitly has ocular-health-structure type and a multi-select field. The rendered selection posts eyes.OD.state/customFields without commandId, loaded or selected; first save returns 400.

Saved failure: `docs/evidence/r10-a3-1/full-checks/ui-test.txt:1586`. Common evidence: `legacy_ui_request`, `shared_capture_gate`.

`ui/tests/customSections.test.tsx:1244–1255`
```text
1244: test("deferred and recorded ocular findings cannot coexist at the client-server boundary", async () => {
1245:   const definition = syntheticDeferredOcularDefinition();
1246:   const serverDefinition: ClinicalFindingDefinition = {
1247:     id: "finding-definition-synthetic-deferred",
1248:     stableKey: definition.stableKey,
1249:     display: definition.display,
1250:     sectionKey: definition.sectionKey,
1251:     valueSchema: {
1252:       type: "ocular-health-structure",
1253:       perEye: true,
1254:       fields: { CUSTOM_DEFERRED_FINDINGS: { ...definition.customFields[0]!, origin: "practice" } },
1255:     },
```

`ui/tests/customSections.test.tsx:1276–1293`
```text
1276:   const attempts: Array<{ body: Record<string, any>; status: number; response: unknown }> = [];
1277:   const fetchImpl = (async (_input, init) => {
1278:     if (init?.method !== "POST") return jsonResponse({ rows: [] });
1279:     const body = JSON.parse(String(init.body));
1280:     const result = await handleCustomSectionCaptureRequest({
1281:       authenticate: async () => ({
1282:         staffReference: "Practitioner/test",
1283:         actorRole: "provider" as const,
1284:         fhir: serverFhir,
1285:       }),
1286:       findingDefinitions: () => [serverDefinition],
1287:       now: () => "2026-09-09T12:00:00.000Z",
1288:     }, {
1289:       authHeader: "Bearer test",
1290:       params: { stableKey: serverDefinition.stableKey },
1291:       body,
1292:     });
1293:     attempts.push({ body, status: result.status, response: result.body });
```

`ui/tests/customSections.test.tsx:1328–1334`
```text
1328:     await act(async () => save.props.onClick());
1329:     assert.equal(attempts[0]?.status, 200, JSON.stringify(attempts[0]?.response));
1330:     assert.equal(attempts[0]?.body.eyes.OD.state, "abnormal");
1331:     assert.deepEqual(attempts[0]?.body.eyes.OD.customFields, [{
1332:       code: "CUSTOM_DEFERRED_FINDINGS",
1333:       value: ["synthetic-finding"],
1334:     }]);
```

`ui/tests/customSections.test.tsx:1916–1931`
```text
1916: function syntheticDeferredOcularDefinition() {
1917:   return {
1918:     stableKey: "ocular-health:anterior:synthetic-deferred",
1919:     sectionKey: "ocular-health:anterior:synthetic-deferred",
1920:     display: "Synthetic Deferred",
1921:     active: true,
1922:     perEye: true,
1923:     normalTemplate: "Synthetic normal.",
1924:     allowDeferred: true,
1925:     customFields: [{
1926:       localCode: "CUSTOM_DEFERRED_FINDINGS",
1927:       display: "Abnormal findings",
1928:       valueType: "multi-select" as const,
1929:       options: [{
1930:         code: "synthetic-finding",
1931:         display: "Synthetic Finding",
```

### 2. fresh ocular-health history restores scoped diagnosis suggestions without a save

The actual injected lens definition explicitly has ocular-health-structure type. The direct handler request supplies eyes.OD.state/customFields; its setup save returns 400 before history remount.

Saved failure: `docs/evidence/r10-a3-1/full-checks/ui-test.txt:1776`. Common evidence: `shared_capture_gate`.

`ui/tests/customSections.test.tsx:2962–2978`
```text
2962:   const serverDefinition: ClinicalFindingDefinition = {
2963:     id: "finding-definition-lens",
2964:     stableKey: "ocular-health:anterior:lens",
2965:     display: "Lens",
2966:     sectionKey: "ocular-health:anterior:lens",
2967:     valueSchema: {
2968:       type: "ocular-health-structure",
2969:       perEye: true,
2970:       fields: {
2971:         CUSTOM_LENS_FINDINGS: {
2972:           localCode: "CUSTOM_LENS_FINDINGS",
2973:           display: "Abnormal findings",
2974:           origin: "practice",
2975:           valueType: "multi-select",
2976:           options: [{
2977:             code: "nuclear-sclerosis",
2978:             display: "nuclear sclerosis",
```

`ui/tests/customSections.test.tsx:3003–3020`
```text
3003:     findingDefinitions: () => [serverDefinition],
3004:     now: () => "2026-08-27T14:00:00.000Z",
3005:   };
3006:   const saved = await handleCustomSectionCaptureRequest(serverDeps, {
3007:     authHeader: "Bearer test",
3008:     params: { stableKey: serverDefinition.stableKey },
3009:     body: {
3010:       patientReference: "Patient/p-history-structure-dx",
3011:       encounterReference: "Encounter/e-history-structure-dx",
3012:       eyes: {
3013:         OD: {
3014:           state: "abnormal",
3015:           customFields: [{ code: "CUSTOM_LENS_FINDINGS", value: ["nuclear-sclerosis"] }],
3016:         },
3017:       },
3018:     },
3019:   });
3020:   assert.equal(saved.status, 200, JSON.stringify(saved.body));
```

### 3. count honesty: Dilation section preview, confirm, void result, section subtotal, and stored statuses all agree

The real handler response is recorded, then compared to the UI callback result. The callback parser drops top-level voidActionId; the recorded deep-equality diagnostic identifies that extra expected field.

Saved failure: `docs/evidence/r10-a3-1/full-checks/ui-test.txt:3220`. Common evidence: `void_response_chain`.

`ui/tests/encounterVoid.test.tsx:412–414`
```text
412:   const confirmations: string[] = [];
413:   const cleared: VoidBody[] = [];
414:   const restore = installRealVoidBridge(deps, responses, confirmations);
```

`ui/tests/encounterVoid.test.tsx:439–444`
```text
439:     assert.equal(result?.count, 3);
440:     assert.equal(result?.voided.length, 3);
441:     assert.deepEqual([...result!.voided].sort(), ["MedicationAdministration/ma1", "MedicationAdministration/ma2", "Observation/dfe"]);
442:     assert.equal(result?.sections.reduce((sum, section) => sum + section.count, 0), result?.count);
443:     assert.equal(result?.sections.find((section) => section.sectionKey === "entrance:dilation")?.count, 3);
444:     assert.deepEqual(cleared, [{ ...result, canWriteDiagnosis: (result as Partial<EncounterVoidResult>)?.canWriteDiagnosis === true }]);
```

### 4. count honesty: whole-visit preview, confirm, void result, section subtotals, and stored statuses all agree

The whole-visit real handler response is compared to the UI callback result. The parser drops top-level voidActionId; the diagnostic identifies that exact missing field.

Saved failure: `docs/evidence/r10-a3-1/full-checks/ui-test.txt:3339`. Common evidence: `void_response_chain`.

`ui/tests/encounterVoid.test.tsx:471–473`
```text
471:   const confirmations: string[] = [];
472:   const cleared: VoidBody[] = [];
473:   const restore = installRealVoidBridge(deps, responses, confirmations);
```

`ui/tests/encounterVoid.test.tsx:497–502`
```text
497:     assert.equal(result?.count, 4);
498:     assert.equal(result?.voided.length, 4);
499:     assert.deepEqual([...result!.voided].sort(), ["MedicationAdministration/ma1", "MedicationAdministration/ma2", "Observation/dfe", "Observation/today"]);
500:     assert.equal(result?.sections.reduce((sum, section) => sum + section.count, 0), result?.count);
501:     assert.equal(result?.sections.find((section) => section.sectionKey === "entrance:dilation")?.count, 3);
502:     assert.deepEqual(cleared, [{ ...result, canWriteDiagnosis: (result as Partial<EncounterVoidResult>)?.canWriteDiagnosis === true }]);
```

### 5. custom state writer preserves other-only notes for normal and abnormal findings

First awaited helper call is real-seed ocular-health:anterior:conjunctiva, abnormal Other-only. Seed builder gives ocular-health-structure/perEye. Helper sends eyes.OD={customFields:[],state,other}; 400 occurs before the later non-shared stereo call.

Saved failure: `docs/evidence/r10-a3-1/full-checks/ui-test.txt:4664`. Common evidence: `overview_helper`, `compiled_seed_ownership`, `shared_capture_gate`.

`ui/tests/examOverviewBoard.test.tsx:1065–1076`
```text
1065: test("custom state writer preserves other-only notes for normal and abnormal findings", async () => {
1066:   const abnormal = await renderedWriterStateSectionValue(
1067:     "ocular-health:anterior:conjunctiva",
1068:     "abnormal",
1069:     "Reports intermittent shimmer",
1070:   );
1071:   const normal = await renderedWriterStateSectionValue(
1072:     "entrance:stereo",
1073:     "normal",
1074:     "Reliable responses throughout",
1075:   );
1076:   assert.deepEqual({
```

`mcp/src/clinical-graph/ocular-health-definition.ts:68–74`
```text
68:   {
69:     key: "conjunctiva",
70:     display: "Conjunctiva",
71:     normalTemplate: "White and quiet; no injection or discharge.",
72:     sheetLabel: "White and quiet",
73:     priority: ["injection", "pinguecula", pterygiumFinding("pterygium", "pterygium"), "chemosis"],
74:     additional: ["subconjunctival hemorrhage", "nevus", "pigmentation", "concretion", "conjunctivochalasis", "episcleritis", "scleritis", "phlyctenule", "lymphangiectasia", "scleral thinning", "nodule"],
```

### 6. abnormal custom state other-only value leaves the exact unformatted sentinel behind

Real-seed conjunctiva abnormal Other-only runs the same legacy request through the real capture handler and returns 400.

Saved failure: `docs/evidence/r10-a3-1/full-checks/ui-test.txt:4693`. Common evidence: `overview_helper`, `compiled_seed_ownership`, `shared_capture_gate`.

`ui/tests/examOverviewBoard.test.tsx:1098–1105`
```text
1098: test("abnormal custom state other-only value leaves the exact unformatted sentinel behind", async () => {
1099:   const abnormal = await renderedWriterStateSectionValue(
1100:     "ocular-health:anterior:conjunctiva",
1101:     "abnormal",
1102:     "Reports intermittent shimmer",
1103:   );
1104:   assert.equal(abnormal.formattedValue, "Other Reports intermittent shimmer");
1105: });
```

`mcp/src/clinical-graph/ocular-health-definition.ts:68–74`
```text
68:   {
69:     key: "conjunctiva",
70:     display: "Conjunctiva",
71:     normalTemplate: "White and quiet; no injection or discharge.",
72:     sheetLabel: "White and quiet",
73:     priority: ["injection", "pinguecula", pterygiumFinding("pterygium", "pterygium"), "chemosis"],
74:     additional: ["subconjunctival hemorrhage", "nevus", "pigmentation", "concretion", "conjunctivochalasis", "episcleritis", "scleritis", "phlyctenule", "lymphangiectasia", "scleral thinning", "nodule"],
```

### 7. exercised EOM and custom-state writers declare every schema-blind component code

After the EOM helper calls, failure occurs at abnormalState: conjunctiva Other-only via the same real-seed helper, before normal stereo and the component-code comparison.

Saved failure: `docs/evidence/r10-a3-1/full-checks/ui-test.txt:4740`. Common evidence: `overview_helper`, `compiled_seed_ownership`, `shared_capture_gate`.

`ui/tests/examOverviewBoard.test.tsx:1284–1294`
```text
1284:   const normalEom = await renderedWriterEomFinding({}, "normal");
1285:   const abnormalState = await renderedWriterStateSectionValue(
1286:     "ocular-health:anterior:conjunctiva",
1287:     "abnormal",
1288:     "Reports intermittent shimmer",
1289:   );
1290:   const normalState = await renderedWriterStateSectionValue(
1291:     "entrance:stereo",
1292:     "normal",
1293:     "Reliable responses throughout",
1294:   );
```

`mcp/src/clinical-graph/ocular-health-definition.ts:68–74`
```text
68:   {
69:     key: "conjunctiva",
70:     display: "Conjunctiva",
71:     normalTemplate: "White and quiet; no injection or discharge.",
72:     sheetLabel: "White and quiet",
73:     priority: ["injection", "pinguecula", pterygiumFinding("pterygium", "pterygium"), "chemosis"],
74:     additional: ["subconjunctival hemorrhage", "nevus", "pigmentation", "concretion", "conjunctivochalasis", "episcleritis", "scleritis", "phlyctenule", "lymphangiectasia", "scleral thinning", "nodule"],
```

### 8. SWEEP-1 guard 1 REAL SEED: Anterior All Normal posts only requests accepted by the real capture handler

Real seeds feed both the rendered UI and handler. Anterior All Normal emits nine legacy eyes state/negativeAct/customFields requests; all nine are 400 in the saved diagnostic. Each anterior structure comes through buildOcularHealthDefinitions and has ocular-health-structure type. No fixture name inference.

Saved failure: `docs/evidence/r10-a3-1/full-checks/ui-test.txt:7131`. Common evidence: `compiled_seed_ownership`, `legacy_ui_request`, `shared_capture_gate`.

`ui/tests/ocularSweepValueOnly.test.tsx:12–24`
```text
12: const seeds = buildFindingDefinitionSeeds();
13: const definitions: CustomFindingDefinition[] = seeds.map((definition) => ({
14:   stableKey: definition.stableKey,
15:   sectionKey: definition.sectionKey,
16:   display: definition.display,
17:   active: definition.active,
18:   perEye: definition.valueSchema.perEye === true,
19:   customFields: customFieldEntries(definition, true),
20:   normalTemplate: definition.normalSemantics?.template as string | undefined,
21:   allowDeferred: definition.normalSemantics?.allowDeferred === true,
22: }));
23: const stainingKey = "dry-eye:conjunctival-staining";
24: const ocularDefinitions = definitions.filter((definition) => definition.stableKey.startsWith("ocular-health:") || definition.stableKey === stainingKey);
```

`ui/tests/ocularSweepValueOnly.test.tsx:31–35`
```text
31: test("SWEEP-1 guard 1 REAL SEED: Anterior All Normal posts only requests accepted by the real capture handler", async () => {
32:   const writes: Array<Observation | Provenance> = [];
33:   const deps: CustomSectionEndpointDeps = {
34:     findingDefinitions: () => seeds,
35:     authenticate: async () => ({
```

`ui/tests/ocularSweepValueOnly.test.tsx:47–56`
```text
47:   const posts: Array<{ key: string; body: { eyes: Record<string, { negativeAct: NegativeAct }> }; status: number; response: unknown }> = [];
48:   const fetchImpl = (async (input, init) => {
49:     if (init?.method !== "POST") return Response.json({ rows: [] });
50:     const key = decodeURIComponent(String(input).split("/").at(-1)!);
51:     const body = JSON.parse(String(init.body));
52:     const result = await handleCustomSectionCaptureRequest(deps, {
53:       authHeader: undefined, params: { stableKey: key }, body,
54:     });
55:     posts.push({ key, body, status: result.status, response: result.body });
56:     return Response.json(result.body, { status: result.status });
```

`ui/tests/ocularSweepValueOnly.test.tsx:60–75`
```text
60:     await act(async () => {
61:       renderer = create(<OcularHealthSection definitions={ocularDefinitions}
62:         patientReference="Patient/sweep-test" encounterReference="Encounter/sweep-test"
63:         onSaved={() => undefined} apiBase="http://synthetic" fetchImpl={fetchImpl} />);
64:     });
65:     const button = (label: string) => renderer.root.findAllByType("button").find((node) => text(node) === label)!;
66:     act(() => button("Anterior All Normal").props.onClick());
67:     await act(async () => button("Save Ocular Health").props.onClick());
68:     assert.ok(posts.length > 0);
69:     assert.deepEqual(posts.filter((post) => post.status !== 200), [], "every posted request must be accepted");
70:     assert.equal(posts.length, 9);
71:     assert.ok(posts.every((post) => post.key !== stainingKey));
72:     for (const post of posts) {
73:       for (const eye of ["OD", "OS"]) assert.ok(post.body.eyes[eye].negativeAct.optionCodes.length > 0);
74:     }
75:     assert.equal(writes.filter((resource) => resource.resourceType === "Observation").length, 18);
```

## Shared trace excerpts

### legacy_ui_request

`ui/src/components/charting/OcularHealthSection.tsx:396–410`
```text
396:             const state = derivedExamState(capture);
397:             return [[eye, {
398:               state,
399:               ...(capture.negativeAct ? { negativeAct: {
400:                 id: capture.negativeAct.id,
401:                 definitionStableKey: capture.negativeAct.definitionStableKey,
402:                 eye: capture.negativeAct.eye,
403:                 optionCodes: capture.negativeAct.optionCodes,
404:                 exclusions: capture.negativeAct.exclusions,
405:                 assertedAt: capture.negativeAct.assertedAt,
406:               } } : {}),
407:               customFields: [
408:                 ...(field && capture.selections.length
409:                   ? [{ code: field.localCode, value: capture.selections }]
410:                   : []),
```

`ui/src/components/charting/OcularHealthSection.tsx:423–431`
```text
423:             }]];
424:           }));
425:           const response = await fetchImpl(
426:             `${apiBase ?? clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}`,
427:             {
428:               method: "POST",
429:               headers: { ...authHeaders(), "Content-Type": "application/json" },
430:               body: JSON.stringify({ patientReference, encounterReference, eyes }),
431:             },
```

### shared_capture_gate

`mcp/src/clinical-graph/custom-section-endpoint.ts:120–122`
```text
120:   const definition = resolveCustomDefinition(deps.findingDefinitions?.(), input.params, true);
121:   if (!definition) return { status: 404, body: { error: "Active custom section not found." } };
122:   if (definition.valueSchema.type === "ocular-health-structure") return saveOcularHealth(deps, staff, definition, input.body);
```

`mcp/src/clinical-graph/custom-section-endpoint.ts:578–579`
```text
578: const ocularEyeSchema = z.object({ loaded: z.array(claimSchema).max(500), selected: z.array(claimSchema).max(500), panel: z.object({ baseline: z.union([canonicalBaselineSchema, z.object({ kind: z.literal("absent"), key: currentFindingPanelKeySchema }).strict()]).optional(), state: z.unknown() }).strict().optional(), negativeAct: ocularNegativeSchema.optional() }).strict();
579: const ocularSaveSchema = z.object({ commandId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i), patientReference: z.string().regex(/^Patient\/[A-Za-z0-9.-]+$/), encounterReference: z.string().regex(/^Encounter\/[A-Za-z0-9.-]+$/), eyes: z.object({ OD: ocularEyeSchema.optional(), OS: ocularEyeSchema.optional() }).strict().refine(e => !!e.OD || !!e.OS) }).strict();
```

`mcp/src/clinical-graph/custom-section-endpoint.ts:624–627`
```text
624: async function saveOcularHealth(deps: CustomSectionEndpointDeps, staff: OcularStaff, definition: ClinicalFindingDefinition, input: unknown): Promise<OcularResponse> {
625:   const parsed = ocularSaveSchema.safeParse(input);
626:   if (!parsed.success) return ocularError(400, "invalid");
627:   const body = parsed.data;
```

### compiled_seed_ownership

`mcp/src/clinical-graph/finding-definition-store.ts:142–146`
```text
142:     ...buildMyopiaFindingDefinitions(provenance),
143:     ...buildDryEyeFindingDefinitions(provenance),
144:     ...buildAnteriorOcularHealthDefinitions(provenance),
145:     ...buildPosteriorOcularHealthDefinitions(provenance),
146:   ];
```

`mcp/src/clinical-graph/ocular-health-definition.ts:558–562`
```text
558: export function buildAnteriorOcularHealthDefinitions(
559:   provenance: ClinicalGraphProvenance,
560: ): ClinicalFindingDefinition[] {
561:   return buildOcularHealthDefinitions(ANTERIOR_STRUCTURES, ANTERIOR_OCULAR_HEALTH_PREFIX, provenance);
562: }
```

`mcp/src/clinical-graph/ocular-health-definition.ts:575–590`
```text
575:   return structures.map((structure, structureIndex) => {
576:     const stableKey = `${prefix}${structure.key}`;
577:     const fields = [
578:       abnormalField(structure, structureIndex),
579:       ...(structure.gradeFields ?? []).map((grade, gradeIndex) => gradeField(grade, gradeIndex)),
580:     ];
581:     const definition = buildClinicalFindingDefinition({
582:       stableKey,
583:       display: structure.display,
584:       sectionKey: stableKey,
585:       anatomyTarget: structure.key === "cornea" ? "cornea" : "eye",
586:       valueSchema: {
587:         type: "ocular-health-structure",
588:         perEye: true,
589:         fields: Object.fromEntries(fields.map((field) => [field.localCode, field])),
590:       },
```

### overview_helper

`ui/tests/examOverviewBoard.test.tsx:2142–2177`
```text
2142:
2143: async function renderedWriterStateSectionValue(
2144:   stableKey: "entrance:pupils" | "entrance:stereo" | "ocular-health:anterior:conjunctiva",
2145:   state: "normal" | "abnormal" | "deferred",
2146:   other: string,
2147: ): Promise<{
2148:   value: string;
2149:   formattedValue: string;
2150:   componentCodes: string[];
2151:   finding: ExamOverviewFindingProjection;
2152: }> {
2153:   const definitions = buildFindingDefinitionSeeds();
2154:   const definition = definitions.find((candidate) => candidate.stableKey === stableKey);
2155:   assert.ok(definition);
2156:   const fhir = new EomWriterFhir();
2157:   const deps: CustomSectionEndpointDeps = {
2158:     authenticate: async () => ({
2159:       staffReference: "Practitioner/state-writer-fixture",
2160:       actorRole: "provider",
2161:       fhir,
2162:     }),
2163:     findingDefinitions: () => definitions,
2164:     now: () => "2026-07-22T12:00:00.000Z",
2165:   };
2166:   const result = await handleCustomSectionCaptureRequest(deps, {
2167:     authHeader: "Bearer state-writer-fixture",
2168:     params: { stableKey },
2169:     body: {
2170:       patientReference: "Patient/state-writer-fixture",
2171:       encounterReference: "Encounter/state-writer-fixture",
2172:       ...(definition.valueSchema.perEye === true
2173:         ? { eyes: { OD: { customFields: [], state, other } } }
2174:         : { customFields: [], state, other }),
2175:     },
2176:   });
2177:   assert.equal(result.status, 200, JSON.stringify(result.body));
```

### void_response_chain

`ui/tests/encounterVoid.test.tsx:695–718`
```text
695: function installRealVoidBridge(
696:   deps: Parameters<typeof handleEncounterVoidRequest>[0],
697:   responses: VoidBody[],
698:   confirmations: string[],
699: ): () => void {
700:   const originalFetch = globalThis.fetch;
701:   const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
702:   Object.defineProperty(globalThis, "window", {
703:     configurable: true,
704:     value: { confirm(message: string) { confirmations.push(message); return true; } },
705:   });
706:   globalThis.fetch = async (input, init) => {
707:     const url = new URL(String(input), "http://localhost");
708:     const match = url.pathname.match(/^\/clinical-graph\/encounters\/([^/]+)\/void$/);
709:     if (!match || init?.method !== "POST") throw new Error(`Unexpected request: ${url}`);
710:     const result = await handleEncounterVoidRequest(deps, {
711:       authHeader: AUTH,
712:       params: { encounterId: decodeURIComponent(match[1]!) },
713:       body: JSON.parse(String(init.body)),
714:     });
715:     responses.push(result.body as VoidBody);
716:     return Response.json(result.body, { status: result.status });
717:   };
718:   return () => {
```

`mcp/src/clinical-graph/encounter-void-endpoint.ts:431–433`
```text
431:   const response: EncounterVoidResponse = { canWriteDiagnosis, voided, count: voided.length, sections, entries, preview, ledger: nextLedger, voidActionId };
432:
433:   // --- One transaction ------------------------------------------------------------------
```

`ui/src/lib/encounter-void.ts:87–100`
```text
87:   const body = await response.json().catch(() => ({})) as Partial<EncounterVoidResult> & ClinicalGraphErrorBody;
88:   if (!response.ok) {
89:     throw clinicalGraphResponseError(response, body, `Void failed (${response.status}).`);
90:   }
91:   return {
92:     canWriteDiagnosis: body.canWriteDiagnosis === true,
93:     voided: body.voided ?? [],
94:     count: body.count ?? 0,
95:     sections: body.sections ?? [],
96:     entries: Array.isArray(body.entries) ? body.entries : [],
97:     preview: body.preview === true,
98:     ...(body.ledger ? { ledger: parseUndoLedger({ ledger: body.ledger }, encounterId) } : {}),
99:   };
100: }
```

## Contract and limits

§3.4 frozen save request; V19/V20 and W66 establish baseline-relative save semantics. §8 specifically carries these legacy requests; §9 migrates screens. This evidence does not claim those guards were rerun.
§3.6 void action identity (lines 319-321); W127 requires identity-bound undo; §9 makes UI preserve/send it.

The JSON preserves the exact void diagnostics showing the top-level `voidActionId` difference. The six old save payloads lack required `commandId` and `loaded`/`selected`; strict parsing returns 400 before conditional transport use. No UI tests/assertions were changed or rerun. No evaluation marker is issued.
