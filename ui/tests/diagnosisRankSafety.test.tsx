import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Condition, Encounter, Provenance } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiagnosisRankActions } from "../src/components/charting/AssessmentSection";
import {
  diagnosisRankForTier,
  makeConditionPrincipal,
  swapConditionRanks,
} from "../src/lib/clinical-actions";

const CONDITIONS = ["principal", "secondary-a", "secondary-b"].map((id) => ({
  resourceType: "Condition" as const,
  id,
}));

test("creation rank rules retain the duplicate-principal guard and append secondaries", () => {
  const encounter = rankedEncounter([1, 2]);
  assert.throws(
    () => diagnosisRankForTier(encounter, "principal"),
    /already has a principal diagnosis/,
  );
  assert.equal(diagnosisRankForTier(encounter, "secondary"), 3);
});

test("Make Principal swaps both ranks in one atomic Encounter PATCH", async () => {
  const encounter = rankedEncounter([1, 2, 3]);
  const capture = await captureEncounterPatch(encounter, async () => {
    await makeConditionPrincipal({ encounter, condition: CONDITIONS[1]! });
  });

  assert.equal(capture.encounterRequests, 1);
  assert.deepEqual(capture.operations, [
    { op: "replace", path: "/diagnosis/1/rank", value: 1 },
    { op: "replace", path: "/diagnosis/0/rank", value: 2 },
  ]);
  assert.deepEqual(applyRanks(encounter, capture.operations), [2, 1, 3]);
  assert.equal(new Set(applyRanks(encounter, capture.operations)).size, 3);
});

test("Make Principal without an existing principal updates only the target rank", async () => {
  const encounter = rankedEncounter([2, 3, 4]);
  const capture = await captureEncounterPatch(encounter, async () => {
    await makeConditionPrincipal({ encounter, condition: CONDITIONS[1]! });
  });

  assert.equal(capture.encounterRequests, 1);
  assert.deepEqual(capture.operations, [
    { op: "replace", path: "/diagnosis/1/rank", value: 1 },
  ]);
  assert.deepEqual(applyRanks(encounter, capture.operations), [2, 1, 4]);
});

test("Move up and Move down atomically swap adjacent secondary ranks", async () => {
  const encounter = rankedEncounter([1, 2, 3]);
  const movedUp = await captureEncounterPatch(encounter, async () => {
    await swapConditionRanks({
      encounter,
      condition: CONDITIONS[2]!,
      adjacentCondition: CONDITIONS[1]!,
    });
  });
  assert.equal(movedUp.encounterRequests, 1);
  assert.deepEqual(applyRanks(encounter, movedUp.operations), [1, 3, 2]);

  const movedDown = await captureEncounterPatch(encounter, async () => {
    await swapConditionRanks({
      encounter,
      condition: CONDITIONS[1]!,
      adjacentCondition: CONDITIONS[2]!,
    });
  });
  assert.equal(movedDown.encounterRequests, 1);
  assert.deepEqual(applyRanks(encounter, movedDown.operations), [1, 3, 2]);
});

test("rank actions render only for confirmed secondary diagnoses", () => {
  const props = {
    busy: false,
    canMoveUp: true,
    canMoveDown: true,
    onMakePrincipal: () => undefined,
    onMoveUp: () => undefined,
    onMoveDown: () => undefined,
  };
  const secondary = renderToStaticMarkup(
    <DiagnosisRankActions {...props} possible={false} principal={false} />,
  );
  assert.match(secondary, /Make Principal/);
  assert.match(secondary, /Move up/);
  assert.match(secondary, /Move down/);
  assert.doesNotMatch(
    renderToStaticMarkup(<DiagnosisRankActions {...props} possible={true} principal={false} />),
    /Make Principal|Move up|Move down/,
  );
  assert.doesNotMatch(
    renderToStaticMarkup(<DiagnosisRankActions {...props} possible={false} principal={true} />),
    /Make Principal|Move up|Move down/,
  );
});

test("the free-form diagnosis rank input and state wiring are removed", () => {
  const source = readFileSync(
    new URL("../src/components/charting/AssessmentSection.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes(["next", "Rank"].join("")), false);
  assert.doesNotMatch(source, /Save tier|Tier rank|inputMode="numeric"/);
});

function rankedEncounter(ranks: number[]): Encounter {
  return {
    resourceType: "Encounter",
    id: "encounter-1",
    meta: { versionId: "7" },
    status: "in-progress",
    class: {},
    diagnosis: ranks.map((rank, index) => ({
      condition: { reference: `Condition/${CONDITIONS[index]!.id}` },
      rank,
    })),
  };
}

async function captureEncounterPatch(
  encounter: Encounter,
  action: () => Promise<void>,
): Promise<{ encounterRequests: number; operations: Array<Record<string, unknown>> }> {
  const originalFetch = globalThis.fetch;
  let encounterRequests = 0;
  let operations: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith(`/Encounter/${encounter.id}`) && init?.method === "PATCH") {
      encounterRequests += 1;
      operations = JSON.parse(String(init.body)) as Array<Record<string, unknown>>;
      return jsonResponse({ ...encounter, meta: { versionId: "8" } });
    }
    if (String(input).endsWith("/Provenance") && init?.method === "POST") {
      return jsonResponse({ resourceType: "Provenance", id: "provenance-1" } satisfies Provenance);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(input)}`);
  };
  try {
    await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { encounterRequests, operations };
}

function applyRanks(encounter: Encounter, operations: Array<Record<string, unknown>>): number[] {
  const ranks = (encounter.diagnosis ?? []).map((diagnosis) => diagnosis.rank);
  for (const operation of operations) {
    const index = Number(String(operation.path).split("/")[2]);
    ranks[index] = operation.op === "remove" ? undefined : operation.value as number;
  }
  return ranks.filter((rank): rank is number => rank !== undefined);
}

function jsonResponse(resource: Encounter | Provenance): Response {
  return new Response(JSON.stringify(resource), {
    status: 200,
    headers: { "Content-Type": "application/fhir+json" },
  });
}
