import { evaluateMappingTrigger } from "../src/clinical-graph/diagnosis-mapping.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import {
  FINDING_DISPOSITION_REGISTRY,
  FINDING_DISPOSITION_ROWS,
  buildFindingDispositionKey,
  parseFindingDispositionKey,
} from "../src/clinical-graph/finding-disposition-registry.js";
import type { FindingDispositionRegistryRow } from "../src/clinical-graph/finding-disposition-registry.js";
import { buildFindingDefinitionSeeds } from "../src/clinical-graph/finding-definition-store.js";
import type {
  ClinicalFindingDefinition,
  MappingTrigger,
  FindingInstance,
} from "../src/clinical-graph/glaucoma-suspect.js";

interface FindingChip {
  definitionStableKey: string;
  fieldLocalCode: string;
  optionCode: string;
}

interface FindingTriggerTarget extends FindingChip {
  kind: "option" | "qualifier";
  qualifiers?: Record<string, string>;
}

interface FindingField {
  localCode: string;
  display: string;
  active: boolean;
  options?: Array<{ code: string; active: boolean }>;
}

function ocularHealthDefinitions(
  definitions: readonly ClinicalFindingDefinition[] = buildFindingDefinitionSeeds(),
): ClinicalFindingDefinition[] {
  return definitions.filter((definition) =>
    definition.active && definition.stableKey.startsWith("ocular-health:")
  );
}

function abnormalFindingChips(
  definitions: readonly ClinicalFindingDefinition[] = ocularHealthDefinitions(),
): FindingChip[] {
  return definitions.flatMap((definition) =>
    Object.values(definition.valueSchema.fields as Record<string, FindingField>)
      .filter((field) => field.active && field.display === "Abnormal findings")
      .flatMap((field) => (field.options ?? [])
        .filter((option) => option.active)
        .map((option) => ({
          definitionStableKey: definition.stableKey,
          fieldLocalCode: field.localCode,
          optionCode: option.code,
        })))
  );
}

function optionTriggerTargets(
  trigger: MappingTrigger,
): Array<{ kind: "option" | "qualifier"; field: string; option: string; qualifiers?: Record<string, string> }> {
  if (trigger.kind === "option") {
    return trigger.anyOf.map((option) => ({ kind: "option", field: trigger.field, option }));
  }
  if (trigger.kind === "qualifier") {
    return [{ kind: "qualifier", field: trigger.field, option: trigger.option, qualifiers: trigger.qualifiers }];
  }
  if (trigger.kind === "allOf") {
    return trigger.triggers.flatMap(optionTriggerTargets);
  }
  return [];
}

function activeTriggerTargets(
  definitions: readonly ClinicalFindingDefinition[] = ocularHealthDefinitions(),
): FindingTriggerTarget[] {
  const abnormalFindingChipKeys = new Set(abnormalFindingChips(definitions).map(buildFindingDispositionKey));
  return definitions.flatMap((definition) =>
    (definition.diagnosisCandidates ?? [])
      .filter((candidate) => candidate.active)
      .flatMap((candidate) => optionTriggerTargets(candidate.trigger))
      .map((target) => ({
        kind: target.kind,
        definitionStableKey: definition.stableKey,
        fieldLocalCode: target.field,
        optionCode: target.option,
        qualifiers: target.qualifiers,
      }))
  ).filter((target) => abnormalFindingChipKeys.has(buildFindingDispositionKey(target)));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

const PTERYGIUM_IDENTITY = {
  definitionStableKey: "ocular-health:anterior:conjunctiva",
  fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04",
  optionCode: "pterygium",
} as const;

function rowsWithQualifierScopedPterygium(): FindingDispositionRegistryRow[] {
  const pterygiumKey = buildFindingDispositionKey(PTERYGIUM_IDENTITY);
  const baseRow = FINDING_DISPOSITION_ROWS.find((row) => buildFindingDispositionKey(row) === pterygiumKey);
  assert.ok(baseRow, "The compiled registry must contain the base pterygium row used by this fixture.");
  return [
    ...FINDING_DISPOSITION_ROWS.filter((row) => buildFindingDispositionKey(row) !== pterygiumKey),
    { ...baseRow, qualifierContext: "location=central" },
    { ...baseRow, qualifierContext: "location=peripheral" },
  ];
}

function rowsWithNarrowPterygiumDisposition(
  disposition: FindingDispositionRegistryRow["disposition"],
): FindingDispositionRegistryRow[] {
  const rows = rowsWithQualifierScopedPterygium();
  const peripheralRow = rows.find((row) => row.qualifierContext === "location=peripheral");
  assert.ok(peripheralRow);
  return [
    ...rows,
    {
      ...peripheralRow,
      qualifierContext: "location=peripheral&progression=stationary",
      disposition,
    },
  ];
}

function assertDispositionCoverage(
  rows: readonly FindingDispositionRegistryRow[],
  chips: readonly FindingChip[],
): void {
  const chipKeys = chips.map(buildFindingDispositionKey);
  const rowKeys = rows.map(buildFindingDispositionKey);
  const rowBaseKeys = rows.map((row) => buildFindingDispositionKey({
    definitionStableKey: row.definitionStableKey,
    fieldLocalCode: row.fieldLocalCode,
    optionCode: row.optionCode,
  }));
  const duplicateRows = sortedUnique(rowKeys.filter((key, index) => rowKeys.indexOf(key) !== index));
  const missingRows = sortedUnique(chipKeys.filter((key) => !rowBaseKeys.includes(key)));
  const staleRows = sortedUnique(rowBaseKeys.filter((key) => !chipKeys.includes(key)));
  const baseRowKeys = new Set(rows
    .filter((row) => row.qualifierContext === undefined)
    .map(buildFindingDispositionKey));
  const mixedRows = sortedUnique(rows
    .filter((row) => row.qualifierContext !== undefined)
    .map((row) => buildFindingDispositionKey({
      definitionStableKey: row.definitionStableKey,
      fieldLocalCode: row.fieldLocalCode,
      optionCode: row.optionCode,
    }))
    .filter((key) => baseRowKeys.has(key)));

  assert.deepEqual(duplicateRows, [], `Duplicate finding-disposition rows: ${duplicateRows.join(", ")}`);
  assert.deepEqual(missingRows, [], `Active finding chips missing dispositions: ${missingRows.join(", ")}`);
  assert.deepEqual(staleRows, [], `Finding-disposition rows naming absent or inactive chips: ${staleRows.join(", ")}`);
  assert.deepEqual(
    mixedRows,
    [],
    `Finding chips carrying both base and qualifier-scoped dispositions: ${mixedRows.join(", ")}`,
  );
}

function assertDispositionConsistency(
  rows: readonly FindingDispositionRegistryRow[],
  definitions: readonly ClinicalFindingDefinition[],
): void {
  const targets = activeTriggerTargets(definitions);
  const qualifierRowBases = new Set(rows
    .filter((row) => row.qualifierContext !== undefined)
    .map((row) => buildFindingDispositionKey({
      definitionStableKey: row.definitionStableKey,
      fieldLocalCode: row.fieldLocalCode,
      optionCode: row.optionCode,
    })));
  const baseKey = (identity: FindingChip): string => buildFindingDispositionKey({
    definitionStableKey: identity.definitionStableKey,
    fieldLocalCode: identity.fieldLocalCode,
    optionCode: identity.optionCode,
  });
  const contextMatches = (context: string, qualifiers: Record<string, string>): boolean => {
    const entries = [...new URLSearchParams(context).entries()];
    return entries.length > 0
      && new Set(entries.map(([key]) => key)).size === entries.length
      && entries.every(([key, value]) => qualifiers[key] === value);
  };

  // A qualifier row matches that option and context. A base row matches an
  // option trigger, or a qualifier trigger only while the chip has no
  // qualifier-scoped rows; the completeness guard separately forbids mixing both.
  const rowMatchesTarget = (row: FindingDispositionRegistryRow): boolean => {
    const rowBaseKey = baseKey(row);
    return targets.some((target) => {
      if (baseKey(target) !== rowBaseKey) return false;
      if (row.qualifierContext !== undefined) {
        return target.kind === "qualifier"
          && target.qualifiers !== undefined
          && contextMatches(row.qualifierContext, target.qualifiers);
      }
      return target.kind === "option" || !qualifierRowBases.has(rowBaseKey);
    });
  };
  const proposalsWithoutTriggers = rows
    .filter((row) => row.disposition.kind === "proposes" && !rowMatchesTarget(row))
    .map(buildFindingDispositionKey);
  const nonProposalsWithTriggers = rows
    .filter((row) => row.disposition.kind !== "proposes" && rowMatchesTarget(row))
    .map(buildFindingDispositionKey);
  const proposals = rows.filter((row) => row.disposition.kind === "proposes");
  const triggersWithoutProposals = targets
    .filter((target) => {
      const targetBaseKey = baseKey(target);
      return !proposals.some((row) => {
        if (baseKey(row) !== targetBaseKey) return false;
        if (target.kind === "option") return true;
        if (row.qualifierContext === undefined) return !qualifierRowBases.has(targetBaseKey);
        return target.qualifiers !== undefined && contextMatches(row.qualifierContext, target.qualifiers);
      });
    })
    .map((target) => target.kind === "qualifier" && target.qualifiers !== undefined
      ? `${baseKey(target)} (${new URLSearchParams(Object.entries(target.qualifiers).sort()).toString()})`
      : baseKey(target));

  assert.deepEqual(
    sortedUnique(proposalsWithoutTriggers),
    [],
    `Proposes dispositions without a matching active trigger: ${proposalsWithoutTriggers.join(", ")}`,
  );
  assert.deepEqual(
    sortedUnique(nonProposalsWithTriggers),
    [],
    `Non-proposes dispositions matched by active triggers: ${nonProposalsWithTriggers.join(", ")}`,
  );
  assert.deepEqual(
    sortedUnique(triggersWithoutProposals),
    [],
    `Active triggers without a matching proposes disposition: ${triggersWithoutProposals.join(", ")}`,
  );
}

function assertDispositionRequirements(rows: readonly FindingDispositionRegistryRow[]): void {
  const violations = rows.flatMap((row) => {
    const key = buildFindingDispositionKey(row);
    if (row.disposition.kind === "descriptive" && row.disposition.reason.trim().length === 0) {
      return [`${key} has an empty descriptive reason`];
    }
    if (row.disposition.kind === "awaiting-ruling") {
      return [
        row.disposition.question.trim().length > 0 ? undefined : `${key} has an empty ruling question`,
        row.disposition.owner.trim().length > 0 ? undefined : `${key} has an empty ruling owner`,
        row.disposition.reference.trim().length > 0 ? undefined : `${key} has an empty ruling reference`,
      ].filter((value): value is string => value !== undefined);
    }
    return [];
  });

  assert.deepEqual(violations, [], `Invalid finding dispositions: ${violations.join("; ")}`);
}

function assertPendingRowCeiling(
  rows: readonly FindingDispositionRegistryRow[],
  ceiling: number,
): void {
  const pendingRows = rows.filter((row) => row.disposition.kind === "pending");
  assert.ok(pendingRows.length <= ceiling, `Pending ocular-health finding-disposition rows rose to ${pendingRows.length}.`);
}

function assertCompiledRegistryIsolation(source: string, dependencyInputs: readonly string[]): void {
  // The source scan catches opaque CommonJS loads that esbuild cannot resolve;
  // the metafile catches real imports a source scan would only approximate.
  // Neither check replaces the other.
  assert.doesNotMatch(source, /\bcreateRequire\b/, "Compiled disposition registry source contains createRequire.");
  assert.doesNotMatch(source, /\brequire\s*\(/, "Compiled disposition registry source contains require(.");
  assert.equal(dependencyInputs.length, 1, `Compiled disposition registry gained dependencies: ${dependencyInputs.join(", ")}`);
  assert.match(dependencyInputs[0] ?? "", /finding-disposition-registry\.ts$/);
}

test("Guard 1: every active ocular-health finding chip has one base row or qualifier rows, never both", () => {
  assertDispositionCoverage(FINDING_DISPOSITION_ROWS, abnormalFindingChips());
  assert.equal(FINDING_DISPOSITION_REGISTRY.size, FINDING_DISPOSITION_ROWS.length);
});

test("Guard 2: proposes dispositions and active ocular-health triggers agree in both directions", () => {
  assertDispositionConsistency(FINDING_DISPOSITION_ROWS, ocularHealthDefinitions());
});

test("ruled benign findings are descriptive while pinguecula and plain drusen remain codeable", () => {
  const descriptiveIdentities = [
    ["ocular-health:anterior:conjunctiva", "CUSTOM_ABNORMAL_FINDINGS_04", "nevus"],
    ["ocular-health:anterior:conjunctiva", "CUSTOM_ABNORMAL_FINDINGS_04", "pigmentation"],
    ["ocular-health:anterior:conjunctiva", "CUSTOM_ABNORMAL_FINDINGS_04", "concretion"],
    ["ocular-health:anterior:cornea", "CUSTOM_ABNORMAL_FINDINGS_06", "krukenberg-spindle"],
    ["ocular-health:anterior:iris", "CUSTOM_ABNORMAL_FINDINGS_08", "nevus"],
    ["ocular-health:anterior:iris", "CUSTOM_ABNORMAL_FINDINGS_08", "heterochromia"],
    ["ocular-health:anterior:anterior-chamber", "CUSTOM_ABNORMAL_FINDINGS_07", "pigment"],
    ["ocular-health:posterior:fundus", "CUSTOM_ABNORMAL_FINDINGS_02", "choroidal-nevus"],
    ["ocular-health:posterior:fundus", "CUSTOM_ABNORMAL_FINDINGS_02", "myelinated-nerve-fiber"],
    ["ocular-health:posterior:fundus", "CUSTOM_ABNORMAL_FINDINGS_02", "occasional-drusen"],
    ["ocular-health:posterior:periphery", "CUSTOM_ABNORMAL_FINDINGS_05", "retinal-tuft"],
    ["ocular-health:posterior:periphery", "CUSTOM_ABNORMAL_FINDINGS_05", "white-without-pressure"],
    ["ocular-health:posterior:periphery", "CUSTOM_ABNORMAL_FINDINGS_05", "cobblestone-paving-stone-degeneration"],
    ["ocular-health:posterior:periphery", "CUSTOM_ABNORMAL_FINDINGS_05", "occasional-drusen"],
    ["ocular-health:posterior:vitreous", "CUSTOM_ABNORMAL_FINDINGS_01", "syneresis"],
  ] as const;

  for (const [definitionStableKey, fieldLocalCode, optionCode] of descriptiveIdentities) {
    const key = buildFindingDispositionKey({ definitionStableKey, fieldLocalCode, optionCode });
    const row = FINDING_DISPOSITION_REGISTRY.get(key);
    assert.equal(row?.disposition.kind, "descriptive", key);
  }

  for (const [definitionStableKey, fieldLocalCode, optionCode] of [
    ["ocular-health:anterior:conjunctiva", "CUSTOM_ABNORMAL_FINDINGS_04", "pinguecula"],
    ["ocular-health:posterior:fundus", "CUSTOM_ABNORMAL_FINDINGS_02", "drusen"],
    ["ocular-health:posterior:macula", "CUSTOM_ABNORMAL_FINDINGS_03", "drusen"],
    ["ocular-health:posterior:periphery", "CUSTOM_ABNORMAL_FINDINGS_05", "drusen"],
  ] as const) {
    const key = buildFindingDispositionKey({ definitionStableKey, fieldLocalCode, optionCode });
    assert.equal(FINDING_DISPOSITION_REGISTRY.get(key)?.disposition.kind, "proposes", key);
  }
});

test("iron-line subtypes carry descriptive dispositions", () => {
  const ironLineRows = FINDING_DISPOSITION_ROWS.filter((row) =>
    row.definitionStableKey === "ocular-health:anterior:cornea"
    && row.fieldLocalCode === "CUSTOM_ABNORMAL_FINDINGS_06"
    && row.optionCode === "iron-line"
  );

  assert.deepEqual(ironLineRows, [{
    definitionStableKey: "ocular-health:anterior:cornea",
    fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06",
    optionCode: "iron-line",
    qualifierContext: "subtype=hudson-stahli",
    disposition: { kind: "descriptive", reason: "Normal age-related corneal iron line." },
  }, {
    definitionStableKey: "ocular-health:anterior:cornea",
    fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06",
    optionCode: "iron-line",
    qualifierContext: "subtype=stockers",
    disposition: { kind: "descriptive", reason: "Corneal iron line at a pterygium head." },
  }, {
    definitionStableKey: "ocular-health:anterior:cornea",
    fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06",
    optionCode: "iron-line",
    qualifierContext: "subtype=fleischers",
    disposition: {
      kind: "descriptive",
      reason: "Corneal iron ring associated with keratoconus; charted as a sign, not a diagnosis. Confirm with topography before charting keratoconus.",
    },
  }]);
});

test("witness B1: two qualifier-scoped pterygium rows satisfy completeness by base chip identity", () => {
  assertDispositionCoverage(rowsWithQualifierScopedPterygium(), abnormalFindingChips());
});

test("witness B2: qualifier-scoped pterygium proposals agree with central and peripheral qualifier triggers", () => {
  assertDispositionConsistency(rowsWithQualifierScopedPterygium(), ocularHealthDefinitions());
});

test("witness H: a pending narrower qualifier row under a matching trigger fails Guard 2", () => {
  assert.throws(
    () => assertDispositionConsistency(
      rowsWithNarrowPterygiumDisposition({ kind: "pending" }),
      ocularHealthDefinitions(),
    ),
    /Non-proposes dispositions matched by active triggers: .*location=peripheral&progression=stationary/,
  );
});

test("witness I: overlapping qualifier rows both marked proposes pass Guard 2", () => {
  assertDispositionConsistency(
    rowsWithNarrowPterygiumDisposition({ kind: "proposes", entrySurface: "finding" }),
    ocularHealthDefinitions(),
  );
});

test("witness J: a pending qualifier row with no matching trigger passes Guard 2", () => {
  const rows = rowsWithQualifierScopedPterygium();
  const peripheralRow = rows.find((row) => row.qualifierContext === "location=peripheral");
  assert.ok(peripheralRow);

  assertDispositionConsistency([
    ...rows,
    { ...peripheralRow, qualifierContext: "location=temporal", disposition: { kind: "pending" } },
  ], ocularHealthDefinitions());
});

test("witness K: a pending base row under a live option trigger fails Guard 2", () => {
  const pterygiumKey = buildFindingDispositionKey(PTERYGIUM_IDENTITY);
  const pendingBaseRows = FINDING_DISPOSITION_ROWS.map((row) =>
    buildFindingDispositionKey(row) === pterygiumKey
      ? { ...row, disposition: { kind: "pending" } as const }
      : row
  );

  assert.throws(
    () => assertDispositionConsistency(pendingBaseRows, ocularHealthDefinitions()),
    /Non-proposes dispositions matched by active triggers: .*pterygium/,
  );
});

test("an active qualifier trigger without any disposition scope still fails Guard 2", () => {
  const centralOnlyRows = rowsWithQualifierScopedPterygium()
    .filter((row) => row.qualifierContext !== "location=peripheral");

  assert.throws(
    () => assertDispositionConsistency(centralOnlyRows, ocularHealthDefinitions()),
    /Active triggers without a matching proposes disposition: .*location=peripheral&progression=stationary/,
  );
});

test("witness C: a chip carrying both a base row and a qualifier row fails the either-or assertion", () => {
  const pterygiumKey = buildFindingDispositionKey(PTERYGIUM_IDENTITY);
  const baseRow = FINDING_DISPOSITION_ROWS.find((row) => buildFindingDispositionKey(row) === pterygiumKey);
  assert.ok(baseRow);
  const mixedRows = [...FINDING_DISPOSITION_ROWS, { ...baseRow, qualifierContext: "location=central" }];

  assert.throws(
    () => assertDispositionCoverage(mixedRows, abnormalFindingChips()),
    /both base and qualifier-scoped dispositions/,
  );
});

test("witness D: duplicate qualifier rows collide on their full disposition key", () => {
  const rows = rowsWithQualifierScopedPterygium();
  const centralRow = rows.find((row) => row.qualifierContext === "location=central");
  assert.ok(centralRow);

  assert.throws(
    () => assertDispositionCoverage([...rows, centralRow], abnormalFindingChips()),
    /Duplicate finding-disposition rows: .*location=central/,
  );
});

test("witness E: a qualifier row whose base identity names no live chip remains stale", () => {
  const rows = rowsWithQualifierScopedPterygium();
  const staleRows = rows.map((row) => row.qualifierContext === "location=central"
    ? { ...row, optionCode: "synthetic-missing-option" }
    : row);

  assert.throws(
    () => assertDispositionCoverage(staleRows, abnormalFindingChips()),
    /Finding-disposition rows naming absent or inactive chips: .*synthetic-missing-option/,
  );
});

test("witness A: the frozen registry keeps one base proposes row for pterygium and its census unchanged", () => {
  const pterygiumKey = buildFindingDispositionKey(PTERYGIUM_IDENTITY);
  const pterygiumTargets = activeTriggerTargets().filter((target) =>
    buildFindingDispositionKey({
      definitionStableKey: target.definitionStableKey,
      fieldLocalCode: target.fieldLocalCode,
      optionCode: target.optionCode,
    }) === pterygiumKey
  );
  const pterygiumRows = FINDING_DISPOSITION_ROWS.filter((row) =>
    buildFindingDispositionKey({
      definitionStableKey: row.definitionStableKey,
      fieldLocalCode: row.fieldLocalCode,
      optionCode: row.optionCode,
    }) === pterygiumKey
  );

  assert.deepEqual(pterygiumRows, [{
    ...PTERYGIUM_IDENTITY,
    disposition: { kind: "proposes", entrySurface: "finding" },
  }]);
  assert.equal(pterygiumTargets.filter((target) => target.kind === "option").length, 4);
  assert.equal(pterygiumTargets.filter((target) => target.kind === "qualifier").length, 4);
  assert.equal(FINDING_DISPOSITION_ROWS.length, 211);
  assert.equal(FINDING_DISPOSITION_ROWS.filter((row) => row.disposition.kind === "proposes").length, 54);
  assert.equal(FINDING_DISPOSITION_ROWS.filter((row) => row.disposition.kind === "pending").length, 139);
  assert.equal(FINDING_DISPOSITION_ROWS.filter((row) => row.disposition.kind === "descriptive").length, 18);
  assert.equal(FINDING_DISPOSITION_ROWS.filter((row) => row.disposition.kind === "awaiting-ruling").length, 0);
  assertDispositionCoverage(FINDING_DISPOSITION_ROWS, abnormalFindingChips());
  assertDispositionConsistency(FINDING_DISPOSITION_ROWS, ocularHealthDefinitions());
  assertDispositionRequirements(FINDING_DISPOSITION_ROWS);
  assertPendingRowCeiling(FINDING_DISPOSITION_ROWS, 139);
});

test("Guard 3: clinical dispositions carry every required reason and ruling reference", () => {
  assertDispositionRequirements(FINDING_DISPOSITION_ROWS);
});

test("Guard 4: pending ocular-health finding-disposition rows never increase", () => {
  // Ocular-status and iron-line ruling baseline: 139 on drbang-iva/ocular-catalog.
  // This ceiling counts registry rows, not chips; qualifier-scoped rows can make those units differ.
  // Tighten this ceiling whenever the row count falls so pending dispositions may never rise again.
  assertPendingRowCeiling(FINDING_DISPOSITION_ROWS, 139);
});

test("Guard 5: the compiled disposition registry has no effective-definition dependency surface", async () => {
  const mcpRoot = fileURLToPath(new URL("..", import.meta.url));
  const registryPath = fileURLToPath(new URL(
    "../src/clinical-graph/finding-disposition-registry.ts",
    import.meta.url,
  ));
  const result = await build({
    absWorkingDir: mcpRoot,
    entryPoints: [registryPath],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    packages: "external",
    logLevel: "silent",
  });
  const dependencyInputs = Object.keys(result.metafile.inputs);

  assertCompiledRegistryIsolation(readFileSync(registryPath, "utf8"), dependencyInputs);
});

test("witness F: registry source containing createRequire fails the source isolation check", () => {
  assert.throws(
    () => assertCompiledRegistryIsolation(
      'const localRequire = createRequire(import.meta.url);',
      ["src/clinical-graph/finding-disposition-registry.ts"],
    ),
    /createRequire/,
  );
});

test("witness G: registry source containing require( fails the source isolation check", () => {
  assert.throws(
    () => assertCompiledRegistryIsolation(
      'const store = require(".\/finding-definition-store.js");',
      ["src/clinical-graph/finding-disposition-registry.ts"],
    ),
    /require\(/,
  );
});

test("finding-disposition keys round-trip nested option codes without treating double colons as separators", () => {
  const identity = {
    definitionStableKey: "ocular-health:anterior:lids-lashes",
    fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02",
    optionCode: "anterior-blepharitis::ulcerative",
    qualifierContext: "severity=example",
  };

  assert.deepEqual(parseFindingDispositionKey(buildFindingDispositionKey(identity)), identity);
});


test("FLEISCHER-1 guard 1: Fleischer's subtype is descriptive and proposes no diagnosis", () => {
  const identity = {
    definitionStableKey: "ocular-health:anterior:cornea",
    fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06",
    optionCode: "iron-line",
    qualifierContext: "subtype=fleischers",
  };
  const disposition = FINDING_DISPOSITION_REGISTRY.get(buildFindingDispositionKey(identity))?.disposition;
  assert.equal(disposition?.kind, "descriptive");
  const cornea = buildFindingDefinitionSeeds().find((definition) => definition.stableKey === identity.definitionStableKey);
  assert.ok(cornea);
  const finding: FindingInstance = {
    id: "fleischer-test", state: "committed", presence: "present",
    findingDefinitionId: cornea.id, patientReference: "Patient/synthetic",
    encounterReference: "Encounter/synthetic", laterality: "OD", sourceType: "manual",
    recordedAt: cornea.provenance.recordedAt, provenance: cornea.provenance,
    interpretation: "abnormal",
    value: { type: "components", components: [
      { code: `${identity.fieldLocalCode}::iron-line`, display: "Iron line", value: true },
      { code: `${identity.fieldLocalCode}::iron-line::subtype`, display: "Subtype", value: "fleischers" },
    ] },
  };
  const proposals = (candidate: FindingInstance) => (cornea.diagnosisCandidates ?? [])
    .filter((mapping) => mapping.active && evaluateMappingTrigger(mapping.trigger, candidate))
    .map((mapping) => mapping.diagnosisKey);
  assert.deepEqual(proposals(finding), []);
  const positiveControl: FindingInstance = { ...finding, value: { type: "components", components: [
    { code: `${identity.fieldLocalCode}::keratoconus`, display: "Keratoconus", value: true },
    { code: `${identity.fieldLocalCode}::keratoconus::stability`, display: "Stability", value: "stable" },
  ] } };
  assert.ok(proposals(positiveControl).length > 0, "direct keratoconus selection must exercise the proposing path");
});

test("FLEISCHER-1 guard 2: no registry row awaits an operator ruling", () => {
  const blockedRows = FINDING_DISPOSITION_ROWS.filter((row) => row.disposition.kind === "awaiting-ruling");
  assert.equal(blockedRows.length, 0, blockedRows.map(buildFindingDispositionKey).join(", "));
});
