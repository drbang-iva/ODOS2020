import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadDiagnosisCodeLedgerRows,
  resolveDiagnosisDxKeys,
} from "../src/clinical-graph/diagnosis-dx-key-resolver.js";
import { matchesCode } from "../src/clinical-graph/protocol-service.js";

const rows = loadDiagnosisCodeLedgerRows();

function resolved(input: string) {
  const resolution = resolveDiagnosisDxKeys(input);
  assert.equal(resolution.status, "resolved", `${input} should resolve from a diagnosis ledger`);
  return resolution;
}

function matchingCodes(dxKeys: readonly string[]): string[] {
  return rows
    .filter((row) => dxKeys.some((pattern) => matchesCode(row.code, pattern)))
    .map((row) => row.code)
    .sort();
}

test("the diagnosis adapter loads all nine real ledgers and H35.44- remains absent", () => {
  assert.equal(rows.length, 493);
  assert.equal(rows.filter((row) => row.family === "H35.44-" || row.code.startsWith("H35.44")).length, 0);
});

test("H40.01- resolves only the verified low-risk glaucoma-suspect codes", () => {
  const resolution = resolved("H40.01-");
  assert.deepEqual(resolution.dxKeys, ["H40.011", "H40.012", "H40.013", "H40.019"]);
  assert.equal(resolution.dxKeys.some((pattern) => matchesCode("H40.011", pattern)), true);
  assert.equal(resolution.dxKeys.some((pattern) => matchesCode("H40.021", pattern)), false);
  assert.equal(resolution.dxKeys.some((pattern) => matchesCode("H40.051", pattern)), false);
});

test("H35.44- reports unresolved instead of guessing a diagnosis trigger", () => {
  assert.deepEqual(resolveDiagnosisDxKeys("H35.44-"), {
    status: "unresolved",
    input: "H35.44-",
    reason: "no-ledger-entry",
  });
});

test("stage-specific labels stay narrow while bare staged labels and staged stableKeys return every stage", () => {
  const cases = [
    {
      bareLabel: "H40.11-",
      clinicalFamily: "primary-open-angle-glaucoma",
      stageLabel: "H40.11-mild",
      stageStableKey: "poag_mild",
      stageFamilies: ["H40.11-mild", "H40.11-moderate", "H40.11-severe", "H40.11-indeterminate"],
    },
    {
      bareLabel: "H40.12-",
      clinicalFamily: "low-tension-glaucoma",
      stageLabel: "H40.12-mild",
      stageStableKey: "low_tension_glaucoma_mild",
      stageFamilies: ["H40.12-mild", "H40.12-moderate", "H40.12-severe", "H40.12-indeterminate"],
    },
    {
      bareLabel: "H35.31-",
      clinicalFamily: "nonexudative-amd",
      stageLabel: "H35.31-early",
      stageStableKey: "dry_amd_early",
      stageFamilies: [
        "H35.31-early",
        "H35.31-intermediate",
        "H35.31-advanced_atrophic_without_subfoveal",
        "H35.31-advanced_atrophic_with_subfoveal",
      ],
    },
    {
      bareLabel: "H35.32-",
      clinicalFamily: "exudative-amd",
      stageLabel: "H35.32-active_cnv",
      stageStableKey: "wet_amd_active_cnv",
      stageFamilies: ["H35.32-active_cnv", "H35.32-inactive_cnv", "H35.32-inactive_scar"],
    },
  ] as const;

  for (const item of cases) {
    const stageCodes = rows.filter((row) => row.family === item.stageLabel).map((row) => row.code).sort();
    const familyCodes = rows.filter((row) => item.stageFamilies.includes(row.family as never)).map((row) => row.code).sort();
    assert.deepEqual(resolved(item.stageLabel).dxKeys, stageCodes, `${item.stageLabel} should stay stage-specific`);
    assert.deepEqual(resolved(item.stageStableKey).dxKeys, stageCodes, `${item.stageStableKey} should stay stage-specific`);
    assert.deepEqual(resolved(item.bareLabel).dxKeys, familyCodes, `${item.bareLabel} should include every stage`);
    assert.deepEqual(resolved(item.clinicalFamily).dxKeys, familyCodes, `${item.clinicalFamily} should include every stage`);
  }
});

test("non-ICD family labels and exact-code families resolve from the real ledgers", () => {
  assert.deepEqual(resolved("diplopia").dxKeys, ["H53.2"]);
  assert.deepEqual(resolved("paralytic-strabismus").dxKeys, ["H49.9"]);
  assert.deepEqual(resolved("E11.9").dxKeys, ["E11.9"]);
  assert.deepEqual(resolved("H52.4").dxKeys, ["H52.4"]);
  assert.deepEqual(resolved("Z96.1").dxKeys, ["Z96.1"]);
});

test("ordinary and staged catalog stableKeys resolve through ledger families, never from their text", () => {
  assert.deepEqual(resolved("glaucoma_suspect_open_angle_low").dxKeys, [
    "H40.011",
    "H40.012",
    "H40.013",
    "H40.019",
  ]);
  assert.deepEqual(resolved("primary-open-angle-glaucoma").ledgerFamilies, [
    "H40.11-indeterminate",
    "H40.11-mild",
    "H40.11-moderate",
    "H40.11-severe",
  ]);
});

test("every direct and bare staged family has exact cover across all 493 real ledger codes", () => {
  const directFamilies = [...new Set(rows.map((row) => row.family))].sort();
  const stagedFamilies = [
    {
      input: "H40.11-",
      members: ["H40.11-mild", "H40.11-moderate", "H40.11-severe", "H40.11-indeterminate"],
    },
    {
      input: "H40.12-",
      members: ["H40.12-mild", "H40.12-moderate", "H40.12-severe", "H40.12-indeterminate"],
    },
    {
      input: "H35.31-",
      members: [
        "H35.31-early",
        "H35.31-intermediate",
        "H35.31-advanced_atrophic_without_subfoveal",
        "H35.31-advanced_atrophic_with_subfoveal",
      ],
    },
    {
      input: "H35.32-",
      members: ["H35.32-active_cnv", "H35.32-inactive_cnv", "H35.32-inactive_scar"],
    },
  ] as const;

  for (const family of directFamilies) {
    const expectedCodes = rows.filter((row) => row.family === family).map((row) => row.code).sort();
    assert.deepEqual(matchingCodes(resolved(family).dxKeys), expectedCodes, `${family} must match only its ledger rows`);
  }
  for (const staged of stagedFamilies) {
    const expectedCodes = rows
      .filter((row) => staged.members.includes(row.family as never))
      .map((row) => row.code)
      .sort();
    assert.deepEqual(
      matchingCodes(resolved(staged.input).dxKeys),
      expectedCodes,
      `${staged.input} must match every stage and no foreign ledger row`,
    );
  }
});
