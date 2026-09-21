import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { BUILT_IN_PROFILE_SECTIONS, FOLLOW_UP_PROFILE_SEEDS } from "../clinical-graph/follow-up-profile-store.js";
import { buildAnteriorOcularHealthDefinitions, buildPosteriorOcularHealthDefinitions } from "../clinical-graph/ocular-health-definition.js";
import { FhirFindingSectionGroupStore, type FindingSectionGroupFhirClient } from "../clinical-graph/finding-section-group-store.js";
import { PROCEDURE_FEE_SEEDS } from "../clinical-graph/procedure-fee-schedule.js";
import { PENDING_ORDERABLES } from "../clinical-graph/plan-sets/glaucoma.js";

function builtInKeys() {
  const file = ts.createSourceFile("types.ts", readFileSync(new URL("../../../ui/src/components/charting/types.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "BuiltInSectionId");
  assert.ok(declaration && ts.isUnionTypeNode(declaration.type));
  return declaration.type.types.map(node => {
    assert.ok(ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal));
    return node.literal.text;
  });
}

test("G1 every seed section resolves in the real catalogues or names its unavailable reason", async () => {
  const provenance = { source: "manual" as const, recordedAt: new Date(0).toISOString(), actorReference: "Practitioner/synthetic" };
  const groups = await new FhirFindingSectionGroupStore({ search: async () => ({ resourceType: "Bundle", entry: [] }) } as unknown as FindingSectionGroupFhirClient).list();
  const builtin = builtInKeys();
  assert.deepEqual(Object.keys(BUILT_IN_PROFILE_SECTIONS).sort(), [...builtin].sort());
  const keys = new Set([
    ...builtin,
    ...buildAnteriorOcularHealthDefinitions(provenance).map(row => row.stableKey),
    ...buildPosteriorOcularHealthDefinitions(provenance).map(row => row.stableKey),
    ...groups.map(row => `group:${row.groupKey}`),
  ]);
  for (const profile of FOLLOW_UP_PROFILE_SEEDS) for (const row of profile.sectionsOpen) {
    assert.ok(keys.has(row.key) || row.unavailableReason?.trim(), `${profile.profileKey}: ${row.key}`);
  }
});

test("G2 every seed test is orderable, pending, or explicitly unavailable", () => {
  const keys = new Set(PROCEDURE_FEE_SEEDS.map(row => row.procedureConceptKey));
  for (const profile of FOLLOW_UP_PROFILE_SEEDS) for (const row of profile.testsQueuedByDefault) {
    assert.ok(keys.has(row.orderable) || PENDING_ORDERABLES.has(row.orderable) || row.unavailableReason?.trim(), `${profile.profileKey}: ${row.orderable}`);
  }
});

test("G3 no MDM field anywhere in any seed", () => {
  function check(value: unknown, path: string) {
    if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, /mdm/i, `${path}.${key}`);
      check(child, `${path}.${key}`);
    }
  }
  check(FOLLOW_UP_PROFILE_SEEDS, "seeds");
});

function seedUnavailableReasons(): Record<string, string> {
  const reasons: Record<string, string> = {};
  function walk(value: unknown, path: string) {
    if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (key === "unavailableReason") {
        assert.equal(typeof child, "string", childPath);
        reasons[childPath] = child as string;
      } else {
        walk(child, childPath);
      }
    }
  }
  for (const profile of FOLLOW_UP_PROFILE_SEEDS) walk(profile, profile.profileKey);
  return reasons;
}

test("Wording G1 every seeded unavailable reason is clinician facing", () => {
  const reasons = Object.values(seedUnavailableReasons());
  assert.equal(reasons.length, 14);
  for (const reason of reasons) {
    assert.ok(reason.trim());
    assert.doesNotMatch(reason, /\.[jt]sx?\b|:\d|§|#\d|\bNEW\b|orderables?\b|pending|draft|design|shipped|endpoint|plan-sets|content/i);
  }
});

test("Wording G2 all fourteen seeded reasons match the approved clinical wording", () => {
  assert.deepEqual(seedUnavailableReasons(), {
    "macula-retina.testsQueuedByDefault.0.unavailableReason": "OCT retina can't be ordered in ODOS yet.",
    "macula-retina.testsQueuedByDefault.2.unavailableReason": "ERG can't be ordered in ODOS yet.",
    "macula-retina.historyTemplate.unavailableReason": "The macular degeneration history template isn't available yet.",
    "dry-eye.testsQueuedByDefault.0.unavailableReason": "Ocular surface staining can't be ordered in ODOS yet.",
    "dry-eye.testsQueuedByDefault.0.choice.options.2.unavailableReason": "Rose bengal isn't one of the vital dye choices yet.",
    "dry-eye.testsQueuedByDefault.1.unavailableReason": "Tear osmolarity can't be ordered in ODOS yet.",
    "dry-eye.testsQueuedByDefault.2.unavailableReason": "InflammaDry (MMP-9) can't be ordered in ODOS yet.",
    "dry-eye.testsQueuedByDefault.3.unavailableReason": "Meibography can't be ordered in ODOS yet. Images can still be captured in the gland structure section.",
    "dry-eye.priorValuesShown.5.unavailableReason": "Punctal plug status isn't recorded in ODOS yet.",
    "dry-eye.historyTemplate.unavailableReason": "The dry eye history template isn't available yet.",
    "red-eye.historyTemplate.unavailableReason": "The red eye history template isn't available yet.",
    "bv-vt.sectionsOpen.7.unavailableReason": "The binocular vision section isn't available yet.",
    "bv-vt.sectionsOpen.8.unavailableReason": "The sensory section isn't available yet.",
    "bv-vt.historyTemplate.unavailableReason": "The binocular vision history template isn't available yet.",
  });
});

test("Wording G3 changed seeds advance to version two while glaucoma stays at one", () => {
  assert.deepEqual(Object.fromEntries(FOLLOW_UP_PROFILE_SEEDS.map(profile => [profile.profileKey, profile.version])), {
    glaucoma: 1,
    "macula-retina": 2,
    "dry-eye": 2,
    "red-eye": 2,
    "bv-vt": 2,
  });
});
