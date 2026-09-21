# Operator rulings R1–R5 and granted edits

## R1 — overlapping open PR #647

Before: AGENTS.md required stopping because #647 also touched mcp/src/index.ts.
After: operator authorized this isolated branch's single new route block immediately after exam-view-state. #647's hunks were near 133, 714 and 7826; its highest re-pin was 7956, still before our insertion. No scripts/fhir-read-grant-check.ts edits. If #647 merges before this PR, rebase onto new main and rerun both suites, all three typechecks and preflight; report both heads. At the R5 fetch, #647 remained OPEN and main remained 9adec598a7d012729ca239cce11aab1b726171f0.

## R2 — valid PostgreSQL-backed baseline

Before: MCP baseline lacked PostgreSQL and reported 43 failures; operator voided it.
After: every MCP run uses dedicated odos-s3c2a-suite-postgres and ODOS_POSTGRES_URL pointing to localhost:29857. Full suite mirrors CI's ODOS_REAL_WEASYPRINT_TEST=1 with pinned WeasyPrint 69.0. Accepted baseline: MCP 6210 total, 6156 pass, 0 fail, 54 skip; UI 1828 pass, 0 fail. Source edits granted: none. Stop task containers at end; leave vf-prac1b-walk-db untouched.

## R3 — tab count

ui/tests/examOverviewBoard.test.tsx, base lines 3424 and 3429:

```diff
-test("DXIMAGING imaging preference survives stages with four tabs", async () => {
+test("DXIMAGING imaging preference survives stages with five tabs", async () => {
-    assert.equal(tabs.findAllByProps({ role: "tab" }).length, 4);
+    assert.equal(tabs.findAllByProps({ role: "tab" }).length, 5);
```

No other change to this existing test.

## R4 — mounted surface counts

ui/tests/examOverviewBoard.test.tsx, base lines 3458 and 3467:

```diff
-    assert.equal(panels.length, 2);
+    assert.equal(panels.length, 3);
-    assert.equal(harness.renderer.root.findAllByType(ExamRightPanelSurface).length, 2);
+    assert.equal(harness.renderer.root.findAllByType(ExamRightPanelSurface).length, 3);
```

Unchanged: panels[0].props.active === true (Photos stays first); modal suppression count remains 0. Follow-up is rendered after the existing surfaces and gated by rightPanelForward.

## R5 — clinical-graph route inventory

mcp/tests/findingDefinitionStore.test.ts, base line 481:

```diff
-  assert.equal(clinicalRoutes.length, 105);
+  // The follow-up queue authenticates with chart.read and reads the shape, fee schedule and plan actions, not definition-store route dependencies.
+  assert.equal(clinicalRoutes.length, 106);
```

Unchanged: routeDependencies.length === 50; procedureRouteDependencies.length === 6. Route remains literal app.get("/clinical-graph/encounters/:encounterId/follow-up-queue", ...). No other edit to this file. Removing that route from the counted clinical-graph family produces a red inventory test; restoring produces green (mutations.json).

## Original kickoff's three frozen-field expectation adaptations

The following excerpts show every field before and after; no original expected field was removed.

### mcp/tests/examOverviewEndpoint.test.ts

Before:
```ts
const glaucomaTestsProposed = [
  { orderable: "visual-field-threshold", sources: [{ kind: "profile", profileKey: "glaucoma" }] },
  { orderable: "scodi-optic-nerve", sources: [{ kind: "profile", profileKey: "glaucoma" }] },
  { orderable: "fundus-photography", focus: "optic nerve", sources: [{ kind: "profile", profileKey: "glaucoma" }] },
];
```

After:
```ts
const glaucomaTestsProposed = [
  { orderable: "visual-field-threshold", label: "Visual field", sources: [{ kind: "profile", profileKey: "glaucoma", profileLabel: "Glaucoma / glaucoma suspect" }] },
  { orderable: "scodi-optic-nerve", label: "OCT optic nerve", sources: [{ kind: "profile", profileKey: "glaucoma", profileLabel: "Glaucoma / glaucoma suspect" }] },
  { orderable: "fundus-photography", focus: "optic nerve", label: "Optic nerve photos", sources: [{ kind: "profile", profileKey: "glaucoma", profileLabel: "Glaucoma / glaucoma suspect" }] },
];
```

### mcp/tests/examShapeRecord.test.ts

Before:
```ts
  assert.deepEqual(result.testsProposed, [
    { orderable: "fundus-photography", focus: "optic nerve", sources: [{ kind: "profile", profileKey: first.profileKey }, { kind: "profile", profileKey: second.profileKey }] },
    { orderable: "fundus-photography", focus: "retina", sources: [{ kind: "profile", profileKey: first.profileKey }] },
    { orderable: "visual-field-threshold", sources: [{ kind: "profile", profileKey: first.profileKey }] },
  ]);
```

After:
```ts
  assert.deepEqual(result.testsProposed, [
    { orderable: "fundus-photography", focus: "optic nerve", label: "Same label", sources: [{ kind: "profile", profileKey: first.profileKey, profileLabel: first.label }, { kind: "profile", profileKey: second.profileKey, profileLabel: second.label }] },
    { orderable: "fundus-photography", focus: "retina", label: "Same label", sources: [{ kind: "profile", profileKey: first.profileKey, profileLabel: first.label }] },
    { orderable: "visual-field-threshold", label: "Same label", sources: [{ kind: "profile", profileKey: first.profileKey, profileLabel: first.label }] },
  ]);
```

### S3c1 G3 sources assertion

Before:
```ts
  for (const test of shaped.testsProposed!) assert.deepEqual(test.sources, [{ kind: "profile", profileKey: "macula-retina" }]);
```

After:
```ts
  for (const test of shaped.testsProposed!) assert.deepEqual(test.sources, [{ kind: "profile", profileKey: "macula-retina", profileLabel: "Macular degeneration / retina" }]);
```

Original caller inventory authorization: ui/tests/clinicalGraphRouting.test.tsx line 41, `assert.equal(callers.length, 58)` -> `assert.equal(callers.length, 59)`, no other edit. G14 proves that count detects removal of the new caller.
