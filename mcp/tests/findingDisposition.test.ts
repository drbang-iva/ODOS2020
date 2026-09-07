import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import {
  FINDING_DISPOSITION_REGISTRY,
  FINDING_DISPOSITION_ROWS,
  buildFindingDispositionKey,
  parseFindingDispositionKey,
} from "../src/clinical-graph/finding-disposition-registry.js";
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

interface FindingField {
  localCode: string;
  display: string;
  active: boolean;
  options?: Array<{ code: string; active: boolean }>;
}

function ocularHealthDefinitions(): ClinicalFindingDefinition[] {
  return buildFindingDefinitionSeeds().filter((definition) =>
    definition.active && definition.stableKey.startsWith("ocular-health:")
  );
}

function abnormalFindingChips(): FindingChip[] {
  return ocularHealthDefinitions().flatMap((definition) =>
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

function optionTriggerTargets(trigger: MappingTrigger): Array<{ field: string; option: string }> {
  if (trigger.kind === "option") {
    return trigger.anyOf.map((option) => ({ field: trigger.field, option }));
  }
  if (trigger.kind === "qualifier") {
    return [{ field: trigger.field, option: trigger.option }];
  }
  if (trigger.kind === "allOf") {
    return trigger.triggers.flatMap(optionTriggerTargets);
  }
  return [];
}

function activeTriggerKeys(): string[] {
  return ocularHealthDefinitions().flatMap((definition) =>
    (definition.diagnosisCandidates ?? [])
      .filter((candidate) => candidate.active)
      .flatMap((candidate) => optionTriggerTargets(candidate.trigger))
      .map(({ field, option }) => buildFindingDispositionKey({
        definitionStableKey: definition.stableKey,
        fieldLocalCode: field,
        optionCode: option,
      }))
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

test("every active ocular-health finding chip has exactly one disposition and every disposition names a live chip", () => {
  const chipKeys = abnormalFindingChips().map(buildFindingDispositionKey);
  const rowKeys = FINDING_DISPOSITION_ROWS.map(buildFindingDispositionKey);
  const duplicateRows = sortedUnique(rowKeys.filter((key, index) => rowKeys.indexOf(key) !== index));
  const missingRows = sortedUnique(chipKeys.filter((key) => !FINDING_DISPOSITION_REGISTRY.has(key)));
  const staleRows = sortedUnique(rowKeys.filter((key) => !chipKeys.includes(key)));

  assert.deepEqual(duplicateRows, [], `Duplicate finding-disposition rows: ${duplicateRows.join(", ")}`);
  assert.deepEqual(missingRows, [], `Active finding chips missing dispositions: ${missingRows.join(", ")}`);
  assert.deepEqual(staleRows, [], `Finding-disposition rows naming absent or inactive chips: ${staleRows.join(", ")}`);
  assert.equal(FINDING_DISPOSITION_REGISTRY.size, FINDING_DISPOSITION_ROWS.length);
});

test("proposes dispositions and active ocular-health option triggers agree in both directions", () => {
  const proposesKeys = sortedUnique(FINDING_DISPOSITION_ROWS
    .filter((row) => row.disposition.kind === "proposes")
    .map(buildFindingDispositionKey));
  const triggerKeys = sortedUnique(activeTriggerKeys());
  const proposalsWithoutTriggers = proposesKeys.filter((key) => !triggerKeys.includes(key));
  const triggersWithoutProposals = triggerKeys.filter((key) => !proposesKeys.includes(key));

  assert.deepEqual(
    proposalsWithoutTriggers,
    [],
    `Proposes dispositions without an active option trigger: ${proposalsWithoutTriggers.join(", ")}`,
  );
  assert.deepEqual(
    triggersWithoutProposals,
    [],
    `Active option triggers without a proposes disposition: ${triggersWithoutProposals.join(", ")}`,
  );
});

test("clinical dispositions carry every required reason and ruling reference", () => {
  const violations = FINDING_DISPOSITION_ROWS.flatMap((row) => {
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
});

test("pending ocular-health finding dispositions never increase", () => {
  const pending = FINDING_DISPOSITION_ROWS.filter((row) => row.disposition.kind === "pending");

  // M0 baseline: 158 at origin/main 5237da3d55beb2dc5f0c114b2072c70b82132612.
  // Tighten this ceiling whenever the count falls so pending dispositions may never rise again.
  assert.ok(pending.length <= 158, `Pending ocular-health finding dispositions rose to ${pending.length}.`);
});

test("the compiled disposition registry has no effective-definition dependency surface", async () => {
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

  assert.equal(dependencyInputs.length, 1, `Compiled disposition registry gained dependencies: ${dependencyInputs.join(", ")}`);
  assert.match(dependencyInputs[0] ?? "", /finding-disposition-registry\.ts$/);
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
