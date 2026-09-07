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
  const proposals = rows.filter((row) => row.disposition.kind === "proposes");
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

  // A qualifier proposal must match that option and context. A base proposal
  // matches an option trigger, or a qualifier trigger only while the chip has no
  // qualifier-scoped rows; the completeness guard separately forbids mixing both.
  const proposalsWithoutTriggers = proposals
    .filter((row) => {
      const rowBaseKey = baseKey(row);
      return !targets.some((target) => {
        if (baseKey(target) !== rowBaseKey) return false;
        if (row.qualifierContext !== undefined) {
          return target.kind === "qualifier"
            && target.qualifiers !== undefined
            && contextMatches(row.qualifierContext, target.qualifiers);
        }
        return target.kind === "option" || !qualifierRowBases.has(rowBaseKey);
      });
    })
    .map(buildFindingDispositionKey);
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

test("witness B1: two qualifier-scoped pterygium rows satisfy completeness by base chip identity", () => {
  assertDispositionCoverage(rowsWithQualifierScopedPterygium(), abnormalFindingChips());
});

test("witness B2: qualifier-scoped pterygium proposals agree with central and peripheral qualifier triggers", () => {
  assertDispositionConsistency(rowsWithQualifierScopedPterygium(), ocularHealthDefinitions());
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
  assert.equal(FINDING_DISPOSITION_ROWS.filter((row) => row.disposition.kind === "proposes").length, 58);
  assert.equal(FINDING_DISPOSITION_ROWS.filter((row) => row.disposition.kind === "pending").length, 153);
  assertDispositionCoverage(FINDING_DISPOSITION_ROWS, abnormalFindingChips());
  assertDispositionConsistency(FINDING_DISPOSITION_ROWS, ocularHealthDefinitions());
  assertDispositionRequirements(FINDING_DISPOSITION_ROWS);
  assertPendingRowCeiling(FINDING_DISPOSITION_ROWS, 153);
});

test("Guard 3: clinical dispositions carry every required reason and ruling reference", () => {
  assertDispositionRequirements(FINDING_DISPOSITION_ROWS);
});

test("Guard 4: pending ocular-health finding-disposition rows never increase", () => {
  // M0 ship baseline: 153 at origin/main 1bd9f80434c94b721f8a87c8d574e13445f230c4.
  // This ceiling counts registry rows, not chips; qualifier-scoped rows can make those units differ.
  // Tighten this ceiling whenever the row count falls so pending dispositions may never rise again.
  assertPendingRowCeiling(FINDING_DISPOSITION_ROWS, 153);
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
