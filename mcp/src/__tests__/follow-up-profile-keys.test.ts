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
